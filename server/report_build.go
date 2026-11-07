package main

// The three reports on the Reports page, built here as documents (operator,
// 2026-11-07: "the logic for generating pdf or reports to move to the
// server"). Ported from the dashboard's lib/samadReports, rule for rule:
//
//	Policy Breaches  per unit: overspeeding, harsh braking, harsh acceleration,
//	                 no seatbelt, on phone, camera covered
//	Movements        every unit: distance in the period, where it is now, its state
//	End of Shift     the shift at a glance, critical alarms, the breaches with
//	                 the top units for each, and the handover
//	Driver Conduct   each driver's incidents per vehicle, by vehicle type, and
//	                 the roster's vehicles the platform does not track
//	Weekly Incidents (report_weekly.go) breaches per driver and truck, week
//	                 by week
//
// IntelliFleet sends no fuel and Samad has no weighbridge, so neither appears.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

var breachKinds = []KPI{ // Label is the heading, Value the reportKind key
	{Label: "Overspeeding", Value: "overspeed"},
	{Label: "Harsh braking", Value: "harsh_braking"},
	{Label: "Harsh acceleration", Value: "harsh_acceleration"},
	{Label: "No seatbelt", Value: "no_seatbelt"},
	{Label: "On phone", Value: "phone"},
	{Label: "Camera covered", Value: "camera_covered"},
}

func isBreachKind(k string) bool {
	for _, b := range breachKinds {
		if b.Value == k {
			return true
		}
	}
	return false
}

// ── time, in Nairobi ─────────────────────────────────────────────────────

func eat(t time.Time) time.Time { return t.In(fleetZone) }

func dayStartOf(t time.Time) time.Time {
	n := eat(t)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, fleetZone)
}

func fmtDay(t time.Time) string   { return eat(t).Format("2 Jan 2006") }
func fmtShort(t time.Time) string { return eat(t).Format("2 Jan 15:04") }
func fmtClock(t time.Time) string { return eat(t).Format("15:04") }

// when is "14:05" on the same day as ref, else "3 Nov 14:05".
func when(t, ref time.Time) string {
	if t.IsZero() {
		return "-"
	}
	if dayStartOf(t).Equal(dayStartOf(ref)) {
		return fmtClock(t)
	}
	return fmtShort(t)
}

// periodWords is "3 Nov 2026", "1 Nov 2026 to 3 Nov 2026" or "3 Nov 06:00 to 18:00".
func periodWords(from, to time.Time) string {
	day := 24 * time.Hour
	if dayStartOf(from).Equal(from) && to.Sub(from)%day == 0 && to.After(from) {
		last := to.Add(-day)
		if last.Equal(from) {
			return fmtDay(from)
		}
		return fmtDay(from) + " to " + fmtDay(last)
	}
	end := fmtShort(to)
	if dayStartOf(to).Equal(dayStartOf(from)) {
		end = fmtClock(to)
	}
	return fmtShort(from) + " to " + end
}

// reportNumber is "PB-SAMAD-20261103-1405": which report, whose, when made.
func reportNumber(prefix string, now time.Time) string {
	return prefix + "-" + OrgCode + "-" + eat(now).Format("20060102-1504")
}

// num prints a figure the way the dashboard did: 120, 42.5.
func num(f float64) string { return strconv.FormatFloat(math.Round(f*10)/10, 'f', -1, 64) }

func nOf(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// ── what the reports read ────────────────────────────────────────────────

type rptEvent struct {
	VehID                             int // the partner's vehicle id
	ID, Kind, Label, Plate, VehicleID string
	At                                time.Time
	Speed                             *float64
	HasClip                           bool
}

type rptUnit struct {
	ID                             int    // the partner's vehicle id
	VehicleID, Plate, Driver, Type string // Driver "" when none is assigned
	HasPos                         bool
	Lat, Lng                       float64
	Online, Moving                 bool
	ZoneNow                        string
	Last                           time.Time // its last fix
}

type rptData struct {
	From, To, Now time.Time
	Events        []rptEvent // in [From, To), the kinds the reports count
	Units         []rptUnit  // every unit now, by plate
	Km            map[string]*float64
	Places        map[string]string
	DayDrivers    map[string]map[int]string // fleet day → vehicle → who drove it that day
	Untracked     []string                  // roster plates the partner does not report
}

// reportData reads the period's events and every unit from the store.
func (s *Server) reportData(from, to, now time.Time) *rptData {
	d := &rptData{From: from, To: to, Now: now}
	for _, e := range s.store.RosterMissing() {
		d.Untracked = append(d.Untracked, e.Truck)
	}
	plates := map[int]string{}
	zones := s.store.Geofences()
	for _, v := range s.store.Vehicles() {
		u := rptUnit{ID: v.VehicleID, VehicleID: vehicleKey(v.VehicleID), Plate: v.Registration, Type: vehicleType(v)}
		if n := driverName(v); n != "Unassigned" {
			u.Driver = n
		}
		if u.Plate == "" {
			u.Plate = u.VehicleID
		}
		plates[v.VehicleID] = u.Plate
		if p := v.Position; p != nil {
			u.Online, u.Moving = online(p), p.MotionStatus == "moving"
			u.Last = parseTime(p.LastUpdate)
			if p.Latitude != 0 || p.Longitude != 0 {
				u.HasPos, u.Lat, u.Lng = true, p.Latitude, p.Longitude
				u.ZoneNow, _, _ = whereNow(zones, p.Latitude, p.Longitude)
			}
		}
		d.Units = append(d.Units, u)
	}
	sort.SliceStable(d.Units, func(i, j int) bool { return d.Units[i].Plate < d.Units[j].Plate })
	var days []string
	for t := dayStartOf(from); t.Before(to); t = t.AddDate(0, 0, 1) {
		days = append(days, fleetDay(t))
	}
	d.DayDrivers = map[string]map[int]string{}
	for day, m := range s.store.Days(days) {
		d.DayDrivers[day] = map[int]string{}
		for id, st := range m {
			d.DayDrivers[day][id] = st.Driver
		}
	}
	for _, e := range s.store.Events() {
		at := parseTime(e.OccurredAt)
		kind := reportKind(e)
		if at.IsZero() || at.Before(from) || !at.Before(to) || kind == "other" || kind == "geofence" {
			continue
		}
		label := e.TypeLabel
		if label == "" {
			label = strings.ReplaceAll(e.Type, "_", " ")
		}
		road, cabin := clipsOf(e)
		plate := plates[e.VehicleID]
		if plate == "" {
			plate = e.Registration
		}
		d.Events = append(d.Events, rptEvent{
			VehID: e.VehicleID, ID: e.EventID, Kind: kind, Label: label, Plate: plate, VehicleID: vehicleKey(e.VehicleID),
			At: at, Speed: e.Speed, HasClip: road != "" || cabin != "",
		})
	}
	sort.SliceStable(d.Events, func(i, j int) bool { return d.Events[i].At.Before(d.Events[j].At) })
	return d
}

func (u rptUnit) state() string {
	switch {
	case !u.Online:
		return "Offline"
	case u.Moving:
		return "Moving"
	}
	return "Stopped"
}

// place is where the unit is now, in words: the place name looked up for it,
// else its zone, else its coordinates.
func (d *rptData) place(u rptUnit) string {
	if p := d.Places[u.VehicleID]; p != "" {
		return p
	}
	if !u.HasPos {
		return "No position"
	}
	if u.ZoneNow != "" {
		return u.ZoneNow
	}
	return fmt.Sprintf("%.4f, %.4f", u.Lat, u.Lng)
}

func (d *rptData) km(u rptUnit) *float64 { return d.Km[u.VehicleID] }

func kmCell(k *float64) Cell {
	if k == nil {
		return Cell{Text: "Not available", Muted: true}
	}
	return Cell{Text: fmt.Sprintf("%.1f km", *k)}
}

func stateCell(st string) Cell { return Cell{Text: st, Muted: st == "Offline"} }

func orDash(s string) Cell {
	if s == "" {
		return Cell{Text: "-", Muted: true}
	}
	return Cell{Text: s}
}

// byKm: furthest first, a unit whose distance is unknown last.
func byKm(a, b *float64) int {
	av, bv := -1.0, -1.0
	if a != nil {
		av = *a
	}
	if b != nil {
		bv = *b
	}
	switch {
	case av > bv:
		return -1
	case av < bv:
		return 1
	}
	return 0
}

// newDoc starts a report with its letterhead facts.
func newDoc(kind, title, prefix string, d *rptData, info []InfoPair) *ReportDoc {
	words := periodWords(d.From, d.To)
	all := append([]InfoPair{{"Fleet", OrgName}, {"Period", words}}, info...)
	all = append(all, InfoPair{"Generated", fmtShort(d.Now)})
	return &ReportDoc{
		Kind: kind, Title: title, ReportNo: reportNumber(prefix, d.Now),
		Date: eat(d.From).Format("02/01/2006"), Company: OrgName, Orientation: "portrait",
		Info: all, FootNote: OrgName + " · " + title + " · " + words,
		Filename:    title + " " + OrgName + " " + fleetDay(d.Now),
		GeneratedAt: d.Now.UTC().Format(time.RFC3339),
	}
}

// ── Policy Breaches ──────────────────────────────────────────────────────

type breachRow struct {
	unit   rptUnit
	counts map[string]int
	total  int
}

func buildBreaches(d *rptData) *ReportDoc {
	units := map[string]rptUnit{}
	for _, u := range d.Units {
		units[u.VehicleID] = u
	}
	per := map[string]*breachRow{}
	var order []string
	for _, e := range d.Events {
		if !isBreachKind(e.Kind) {
			continue
		}
		r := per[e.VehicleID]
		if r == nil {
			u, ok := units[e.VehicleID]
			if !ok {
				u = rptUnit{ID: e.VehID, VehicleID: e.VehicleID, Plate: e.Plate, Type: "TRUCK"}
			}
			r = &breachRow{unit: u, counts: map[string]int{}}
			per[e.VehicleID] = r
			order = append(order, e.VehicleID)
		}
		r.counts[e.Kind]++
		r.total++
	}
	rows := make([]*breachRow, 0, len(order))
	for _, id := range order {
		rows = append(rows, per[id])
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].total != rows[j].total {
			return rows[i].total > rows[j].total
		}
		return rows[i].unit.Plate < rows[j].unit.Plate
	})
	total := 0
	totals := map[string]int{}
	for _, r := range rows {
		total += r.total
		for k, n := range r.counts {
			totals[k] += n
		}
	}

	doc := newDoc("breaches", "Policy Breaches Report", "PB", d, []InfoPair{
		{Label: "Vehicles", Value: fmt.Sprintf("%d with breaches of %d", len(rows), len(d.Units))},
		{Label: "Breaches", Value: strconv.Itoa(total)},
	})
	kpis := make([]KPI, 0, len(breachKinds)+2)
	for _, b := range breachKinds {
		kpis = append(kpis, KPI{Label: b.Label, Value: strconv.Itoa(totals[b.Value])})
	}
	kpis = append(kpis, KPI{Label: "Total breaches", Value: strconv.Itoa(total)}, KPI{Label: "Vehicles", Value: strconv.Itoa(len(rows))})
	doc.Blocks = []Block{{Type: "heading", Text: "1. Overview", Small: periodWords(d.From, d.To)}, {Type: "kpis", KPIs: kpis}}
	if len(rows) == 0 {
		doc.Blocks = append(doc.Blocks, Block{Type: "empty", Text: "No policy breaches in this period."})
	}

	// One section per vehicle type when there is more than one, the largest first.
	type section struct {
		name string
		rows []*breachRow
	}
	var sections []section
	byType := map[string]int{}
	for _, r := range rows {
		i, ok := byType[r.unit.Type]
		if !ok {
			i = len(sections)
			byType[r.unit.Type] = i
			t := strings.ToLower(r.unit.Type)
			if t == "" {
				t = "vehicle"
			}
			sections = append(sections, section{name: strings.ToUpper(t[:1]) + t[1:]})
		}
		sections[i].rows = append(sections[i].rows, r)
	}
	if len(sections) == 1 {
		sections[0].name = "All vehicles"
	}
	sort.SliceStable(sections, func(i, j int) bool { return len(sections[i].rows) > len(sections[j].rows) })

	cols := []Col{{H: "Vehicle", W: 24}, {H: "Driver", W: 34}}
	for _, b := range breachKinds {
		cols = append(cols, Col{H: b.Label, W: 16, Right: true})
	}
	cols = append(cols, Col{H: "Total", W: 14, Right: true})
	for i, s := range sections {
		sum := 0
		var cells [][]Cell
		for _, r := range s.rows {
			sum += r.total
			row := []Cell{{Text: r.unit.Plate, Bold: true}, orDash(r.unit.Driver)}
			for _, b := range breachKinds {
				n := r.counts[b.Value]
				row = append(row, Cell{Text: strconv.Itoa(n), Muted: n == 0})
			}
			cells = append(cells, append(row, Cell{Text: strconv.Itoa(r.total), Bold: true}))
		}
		doc.Blocks = append(doc.Blocks,
			Block{Type: "heading", Text: fmt.Sprintf("%d. %s", i+2, s.name),
				Small: nOf(len(s.rows), "vehicle", "vehicles") + " · " + nOf(sum, "breach", "breaches")},
			Block{Type: "table", Cols: cols, Rows: cells})
	}
	doc.Blocks = append(doc.Blocks,
		Block{Type: "note", Text: "Overspeeding, harsh braking and harsh acceleration come from the trackers and dashcams; no seatbelt, on phone and camera covered from the dashcams, so only units with a camera can raise them."},
		Block{Type: "note", Text: "Driver is the driver assigned to the vehicle when the report was made, who may not have been driving at the time of every breach."})
	doc.Summary = map[string]any{"breaches": total, "vehicles": len(rows), "period": periodWords(d.From, d.To)}
	return doc
}

// ── Driver Conduct ───────────────────────────────────────────────────────
//
// Laid out after the Driver Conduct sheet the operator sent (Menengai,
// 2026-11-07): how each driver drove, per vehicle, by vehicle type, then the
// roster's vehicles the platform does not track. Speed is left out (the
// Policy Breaches report has it), and so is harsh cornering: IntelliFleet
// sends no such event for this fleet.

var conductKinds = []KPI{ // in the sheet's order
	{Label: "Harsh acceleration", Value: "harsh_acceleration"},
	{Label: "Harsh braking", Value: "harsh_braking"},
	{Label: "No seatbelt", Value: "no_seatbelt"},
	{Label: "On phone", Value: "phone"},
	{Label: "Camera covered", Value: "camera_covered"},
}

// typeWords is "Truck" for TRUCK.
func typeWords(t string) string {
	t = strings.ToLower(strings.TrimSpace(t))
	if t == "" {
		return "Vehicle"
	}
	return strings.ToUpper(t[:1]) + t[1:]
}

func buildConduct(d *rptData) *ReportDoc {
	units := map[string]rptUnit{}
	for _, u := range d.Units {
		units[u.VehicleID] = u
	}
	type row struct {
		unit   rptUnit
		counts map[string]int
		total  int
		last   time.Time
	}
	per := map[string]*row{}
	totals := map[string]int{}
	total := 0
	for _, e := range d.Events {
		counted := false
		for _, k := range conductKinds {
			if k.Value == e.Kind {
				counted = true
			}
		}
		if !counted {
			continue
		}
		r := per[e.VehicleID]
		if r == nil {
			u, ok := units[e.VehicleID]
			if !ok {
				u = rptUnit{ID: e.VehID, VehicleID: e.VehicleID, Plate: e.Plate, Type: "TRUCK"}
			}
			r = &row{unit: u, counts: map[string]int{}}
			per[e.VehicleID] = r
		}
		r.counts[e.Kind]++
		r.total++
		r.last = e.At
		totals[e.Kind]++
		total++
	}

	doc := newDoc("conduct", "Driver Conduct Report", "DC", d, []InfoPair{{Label: "Vehicles", Value: fmt.Sprintf("%d reported", len(per))}})
	doc.FootNote = OrgName + " · Driver Conduct Report · " + periodWords(d.From, d.To)
	kpis := []KPI{{Label: "Vehicles", Value: strconv.Itoa(len(per))}}
	for _, k := range conductKinds {
		kpis = append(kpis, KPI{Label: k.Label, Value: strconv.Itoa(totals[k.Value])})
	}
	kpis = append(kpis, KPI{Label: "Total incidents", Value: strconv.Itoa(total)})
	doc.Blocks = []Block{{Type: "heading", Text: "1. Overview", Small: periodWords(d.From, d.To)}, {Type: "kpis", KPIs: kpis}}
	if total == 0 {
		doc.Blocks = append(doc.Blocks, Block{Type: "empty", Text: "No incidents in this period."})
	}

	// One section per vehicle type, the most vehicles first; plates in order.
	byType := map[string][]*row{}
	var types []string
	for _, r := range per {
		t := typeWords(r.unit.Type)
		if _, ok := byType[t]; !ok {
			types = append(types, t)
		}
		byType[t] = append(byType[t], r)
	}
	sort.Slice(types, func(i, j int) bool {
		if len(byType[types[i]]) != len(byType[types[j]]) {
			return len(byType[types[i]]) > len(byType[types[j]])
		}
		return types[i] < types[j]
	})
	cols := []Col{{H: "Vehicle", W: 20}, {H: "Type", W: 13}, {H: "Driver", W: 30}}
	for _, k := range conductKinds {
		cols = append(cols, Col{H: k.Label, W: 15, Right: true})
	}
	cols = append(cols, Col{H: "Total", W: 10, Right: true})
	n := 2
	for _, t := range types {
		rows := byType[t]
		sort.Slice(rows, func(i, j int) bool { return rows[i].unit.Plate < rows[j].unit.Plate })
		sum := 0
		var cells [][]Cell
		for _, r := range rows {
			sum += r.total
			line := []Cell{{Text: r.unit.Plate, Bold: true}, {Text: t}, orDash(d.driverOn(r.unit, r.last))}
			for _, k := range conductKinds {
				line = append(line, Cell{Text: strconv.Itoa(r.counts[k.Value])})
			}
			cells = append(cells, append(line, Cell{Text: strconv.Itoa(r.total), Bold: true}))
		}
		doc.Blocks = append(doc.Blocks,
			Block{Type: "heading", Text: fmt.Sprintf("%d. %ss", n, t), Small: nOf(len(rows), "vehicle", "vehicles") + " · " + nOf(sum, "incident", "incidents")},
			Block{Type: "table", Cols: cols, Rows: cells})
		n++
	}

	// Only against a vehicle list that came in: without one, every roster
	// truck would look untracked.
	if len(d.Untracked) > 0 && len(d.Units) > 0 {
		plates := append([]string(nil), d.Untracked...)
		sort.Strings(plates)
		doc.Blocks = append(doc.Blocks,
			Block{Type: "heading", Text: fmt.Sprintf("%d. Not tracked on the platform", n), Small: fmt.Sprintf("%d on the list", len(plates))},
			Block{Type: "table", Cols: []Col{{H: "Group", W: 26}, {H: "Vehicles", W: 100}},
				Rows: [][]Cell{{{Text: fmt.Sprintf("Trucks (%d)", len(plates)), Bold: true}, {Text: strings.Join(plates, ", "), Wrap: true}}}})
	}
	doc.Blocks = append(doc.Blocks, Block{Type: "spacer"},
		Block{Type: "note", Text: "This is a system-generated report. For any queries about its contents, please contact OGC Monitoring at operations@offgridconsultingltd.com."})
	doc.Summary = map[string]any{"incidents": total, "vehicles": len(per), "period": periodWords(d.From, d.To)}
	return doc
}

// ── Movements ────────────────────────────────────────────────────────────

func buildMovements(d *rptData) *ReportDoc {
	units := append([]rptUnit(nil), d.Units...)
	sort.SliceStable(units, func(i, j int) bool {
		if c := byKm(d.km(units[i]), d.km(units[j])); c != 0 {
			return c < 0
		}
		mi, mj := units[i].state() == "Moving", units[j].state() == "Moving"
		if mi != mj {
			return mi
		}
		return units[i].Plate < units[j].Plate
	})
	total, moving, unknown := 0.0, 0, false
	rows := make([][]Cell, 0, len(units))
	for _, u := range units {
		k := d.km(u)
		if k != nil {
			total += *k
		} else {
			unknown = true
		}
		if u.state() == "Moving" {
			moving++
		}
		rows = append(rows, []Cell{{Text: u.Plate, Bold: true}, orDash(u.Driver), kmCell(k),
			{Text: d.place(u), Wrap: true}, stateCell(u.state())})
	}
	doc := newDoc("movements", "Movements Report", "MV", d, []InfoPair{{"Units", strconv.Itoa(len(units))}})
	doc.Blocks = []Block{
		{Type: "heading", Text: "1. Overview", Small: "At " + when(d.Now, d.Now)},
		{Type: "kpis", KPIs: []KPI{{Label: "Units", Value: strconv.Itoa(len(units))}, {Label: "Moving now", Value: strconv.Itoa(moving)}}},
		{Type: "heading", Text: "2. Assets Location", Small: fmt.Sprintf("%s · %s km in the period", nOf(len(units), "unit", "units"), num(total))},
		{Type: "table", Cols: []Col{{H: "Vehicle", W: 24}, {H: "Driver", W: 40}, {H: "Distance", W: 26, Right: true},
			{H: "Current location", W: 70}, {H: "State", W: 18}}, Rows: rows},
	}
	if unknown {
		doc.Blocks = append(doc.Blocks, Block{Type: "note", Text: "Not available: the unit's trip history for the period could not be read."})
	}
	doc.Summary = map[string]any{"km": math.Round(total*10) / 10, "moving": moving, "units": len(units), "period": periodWords(d.From, d.To)}
	return doc
}

// ── End of Shift ─────────────────────────────────────────────────────────
//
// Laid out after the end-of-shift sheet the operator sent (Menengai Tankers,
// 2026-11-07), landscape: the shift at a glance, the critical alarms, the
// policy breaches as a strip of counts then the top units for each breach two
// to a row, and the handover with lines to write on and two signatures. The
// sheet's fuel, geofence and products sections are left out: IntelliFleet
// sends no fuel, no geofence crossings for this fleet, and Samad has no
// weighbridge.

const (
	shiftTop    = 5               // units listed under each breach
	shiftCustom = "Custom period" // the shift words of a period picked by hand
)

// fmtThousands prints 6295.1 as "6,295.1".
func fmtThousands(f float64) string {
	s := strconv.FormatFloat(math.Round(f*10)/10, 'f', 1, 64)
	whole, frac, _ := strings.Cut(s, ".")
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if frac != "" && frac != "0" {
		b.WriteString("." + frac)
	}
	return b.String()
}

// driverOn is who drove the unit on the fleet day of t: the day's tally,
// else the driver assigned now.
func (d *rptData) driverOn(u rptUnit, t time.Time) string {
	if n := d.DayDrivers[fleetDay(t)][u.ID]; n != "" {
		return n
	}
	return u.Driver
}

func buildShift(d *rptData, shiftWords string) *ReportDoc {
	units := map[string]rptUnit{}
	for _, u := range d.Units {
		units[u.VehicleID] = u
	}
	unitOf := func(e rptEvent) rptUnit {
		if u, ok := units[e.VehicleID]; ok {
			return u
		}
		return rptUnit{ID: e.VehID, VehicleID: e.VehicleID, Plate: e.Plate}
	}
	var critical []rptEvent
	for _, e := range d.Events {
		if e.Kind == "critical" {
			critical = append(critical, e)
		}
	}

	// Each breach: how many, by how many units, and the units most at it.
	type unitN struct {
		u rptUnit
		n int
		t time.Time // the last time, for the driver of that day
	}
	type breach struct {
		label string
		count int
		units []unitN
	}
	breaches := make([]breach, 0, len(breachKinds))
	breachTotal := 0
	for _, b := range breachKinds {
		per := map[string]*unitN{}
		count := 0
		for _, e := range d.Events {
			if e.Kind != b.Value {
				continue
			}
			x := per[e.VehicleID]
			if x == nil {
				x = &unitN{u: unitOf(e)}
				per[e.VehicleID] = x
			}
			x.n++
			x.t = e.At
			count++
		}
		list := make([]unitN, 0, len(per))
		for _, x := range per {
			list = append(list, *x)
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].n != list[j].n {
				return list[i].n > list[j].n
			}
			return list[i].u.Plate < list[j].u.Plate
		})
		breaches = append(breaches, breach{b.Label, count, list})
		breachTotal += count
	}

	// Units heard from: since the shift began while it is on, else the
	// units that moved in it.
	live := !d.To.Before(d.Now.Add(-time.Minute))
	reporting, reportLabel := 0, "Units that moved"
	if live {
		reportLabel = "Reporting since " + fmtClock(d.From)
		for _, u := range d.Units {
			if !u.Last.Before(d.From) {
				reporting++
			}
		}
	}
	total, moved, known := 0.0, 0, 0
	for _, u := range d.Units {
		if k := d.km(u); k != nil {
			known++
			total += *k
			if *k >= 0.5 {
				moved++
			}
		}
	}
	if !live {
		reporting = moved
	}

	day := eat(d.From).Format("02/01/2006")
	shiftWhen := day + ", " + shiftWords
	name := strings.ToLower(strings.SplitN(shiftWords, ",", 2)[0])
	if shiftWords == shiftCustom {
		shiftWhen, name = periodWords(d.From, d.To), "custom"
	}
	doc := newDoc("shift", "End of Shift Report", "ES", d, nil)
	doc.Info = []InfoPair{{"Fleet", OrgName}, {"Shift", shiftWhen}, {"Units", strconv.Itoa(len(d.Units))}}
	doc.Orientation = "landscape"
	doc.FootNote = OrgName + " · End of shift report · " + day + " · made " + eat(d.Now).Format("2 Jan 2006, 15:04")
	doc.Filename = "End of shift report " + OrgName + " " + eat(d.From).Format("2006-01-02") + " " + name

	k := 1
	head := func(text, small string) Block {
		b := Block{Type: "heading", Text: fmt.Sprintf("%d. %s", k, text), Small: small}
		k++
		return b
	}
	distance := "Not available"
	if known > 0 {
		distance = fmtThousands(total) + " km · " + nOf(moved, "unit", "units")
	}
	doc.Blocks = append(doc.Blocks, head("Overview", shiftWhen), Block{Type: "kpis", KPIs: []KPI{
		{Label: "Critical alarms", Value: strconv.Itoa(len(critical))},
		{Label: "Policy breaches", Value: strconv.Itoa(breachTotal)},
		{Label: reportLabel, Value: fmt.Sprintf("%d of %d", reporting, len(d.Units))},
		{Label: "Distance covered", Value: distance},
	}})

	doc.Blocks = append(doc.Blocks, head("Critical: alarms", nOf(len(critical), "alarm", "alarms")+" in the shift"))
	if len(critical) == 0 {
		doc.Blocks = append(doc.Blocks, Block{Type: "empty", Text: "No critical alarm in the shift."})
	} else {
		var rows [][]Cell
		for _, e := range critical {
			speed := Cell{Text: "-", Muted: true}
			if e.Speed != nil && *e.Speed > 0 {
				speed = Cell{Text: fmt.Sprintf("%d km/h", int(math.Round(*e.Speed)))}
			}
			clip := Cell{Text: "No", Muted: true}
			if e.HasClip {
				clip = Cell{Text: "Yes"}
			}
			rows = append(rows, []Cell{{Text: when(e.At, d.From)}, {Text: e.Plate, Bold: true},
				orDash(d.driverOn(unitOf(e), e.At)), {Text: e.Label}, speed, clip})
		}
		doc.Blocks = append(doc.Blocks, Block{Type: "table", Cols: []Col{{H: "Time", W: 16}, {H: "Unit", W: 22},
			{H: "Driver", W: 40}, {H: "Alarm", W: 60}, {H: "Speed", W: 16, Right: true}, {H: "Clip", W: 12}}, Rows: rows})
	}

	doc.Blocks = append(doc.Blocks, head("Policy breaches", fmt.Sprintf("%d in the shift · top %d units for each", breachTotal, shiftTop)))
	strip := make([]KPI, 0, len(breaches))
	groups := make([]SubTable, 0, len(breaches))
	for _, b := range breaches {
		strip = append(strip, KPI{Label: b.label, Value: strconv.Itoa(b.count), Sub: nOf(len(b.units), "unit", "units")})
		g := SubTable{Text: b.label, Empty: "None in the shift."}
		if len(b.units) > 0 {
			top := b.units[:min(shiftTop, len(b.units))]
			g.Small = "all " + nOf(len(b.units), "unit", "units")
			if len(top) < len(b.units) {
				g.Small = fmt.Sprintf("top %d of %d units", len(top), len(b.units))
			}
			g.Cols = []Col{{H: "Unit", W: 14}, {H: "Driver", W: 50}, {H: "Times", W: 10, Right: true}}
			for _, x := range top {
				g.Rows = append(g.Rows, []Cell{{Text: x.u.Plate, Bold: true}, orDash(d.driverOn(x.u, x.t)), {Text: strconv.Itoa(x.n), Bold: true}})
			}
		}
		groups = append(groups, g)
	}
	doc.Blocks = append(doc.Blocks,
		Block{Type: "counts", KPIs: strip},
		Block{Type: "spacer"},
		Block{Type: "groups", Groups: groups},
		Block{Type: "note", Text: "On phone, no seatbelt and camera covered come from the dashcams, so only units with a camera are counted."},
		head("Handover to the next shift", ""),
		Block{Type: "lines", N: 4},
		Block{Type: "sign", KPIs: []KPI{{Label: "Prepared by (outgoing operator)"}, {Label: "Received by (incoming operator)"}}},
	)
	doc.Summary = map[string]any{"critical": len(critical), "breaches": breachTotal, "reporting": reporting,
		"units": len(d.Units), "period": periodWords(d.From, d.To)}
	return doc
}

// buildReport makes one report for [from, to). Movements and End of Shift
// also read each unit's trip history and place name, which takes a while on
// a cold cache: the partner answers one request every 600 ms.
func (s *Server) buildReport(ctx context.Context, kind string, from, to, now time.Time, shiftWords string) (*ReportDoc, error) {
	d := s.reportData(from, to, now)
	switch kind {
	case "breaches":
		return buildBreaches(d), nil
	case "conduct":
		return buildConduct(d), nil
	}
	km, err := s.reports.distances(ctx, s.client, d.Units, from, to, now)
	if err != nil {
		return nil, err
	}
	d.Km = km
	if kind == "shift" {
		return buildShift(d, shiftWords), nil
	}
	d.Places = s.reports.places(ctx, s.cfg.GoogleKey(), d.Units)
	return buildMovements(d), nil
}
