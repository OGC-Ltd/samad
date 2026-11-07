package main

// The three reports on the Reports page, built here as documents (operator,
// 2026-11-07: "the logic for generating pdf or reports to move to the
// server"). Ported from the dashboard's lib/samadReports, rule for rule:
//
//	Policy Breaches  per unit: overspeeding, harsh braking, harsh acceleration,
//	                 no seatbelt, on phone, camera covered
//	Movements        every unit: distance in the period, where it is now, its state
//	End of Shift     the shift at a glance, critical alarms, the breaches by
//	                 unit, and every unit's distance and place
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
}

type rptData struct {
	From, To, Now time.Time
	Events        []rptEvent // in [From, To), the kinds the reports count
	Units         []rptUnit  // every unit now, by plate
	Km            map[string]*float64
	Places        map[string]string
}

// reportData reads the period's events and every unit from the store.
func (s *Server) reportData(from, to, now time.Time) *rptData {
	d := &rptData{From: from, To: to, Now: now}
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
			if p.Latitude != 0 || p.Longitude != 0 {
				u.HasPos, u.Lat, u.Lng = true, p.Latitude, p.Longitude
				u.ZoneNow, _, _ = whereNow(zones, p.Latitude, p.Longitude)
			}
		}
		d.Units = append(d.Units, u)
	}
	sort.SliceStable(d.Units, func(i, j int) bool { return d.Units[i].Plate < d.Units[j].Plate })
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
			ID: e.EventID, Kind: kind, Label: label, Plate: plate, VehicleID: vehicleKey(e.VehicleID),
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
				u = rptUnit{VehicleID: e.VehicleID, Plate: e.Plate, Type: "TRUCK"}
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
		{"Vehicles", fmt.Sprintf("%d with breaches of %d", len(rows), len(d.Units))},
		{"Breaches", strconv.Itoa(total)},
	})
	kpis := make([]KPI, 0, len(breachKinds)+2)
	for _, b := range breachKinds {
		kpis = append(kpis, KPI{b.Label, strconv.Itoa(totals[b.Value])})
	}
	kpis = append(kpis, KPI{"Total breaches", strconv.Itoa(total)}, KPI{"Vehicles", strconv.Itoa(len(rows))})
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
		{Type: "kpis", KPIs: []KPI{{"Units", strconv.Itoa(len(units))}, {"Moving now", strconv.Itoa(moving)}}},
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

func buildShift(d *rptData, shiftWords string) *ReportDoc {
	units := map[string]rptUnit{}
	for _, u := range d.Units {
		units[u.VehicleID] = u
	}
	var critical []rptEvent
	breachUnits := map[string]bool{}
	for _, e := range d.Events {
		if e.Kind == "critical" {
			critical = append(critical, e)
		}
		if isBreachKind(e.Kind) {
			breachUnits[e.VehicleID] = true
		}
	}
	type unitN struct {
		plate string
		n     int
	}
	type breach struct {
		label string
		count int
		units []unitN
	}
	breaches := make([]breach, 0, len(breachKinds))
	breachTotal := 0
	for _, b := range breachKinds {
		per := map[string]int{}
		count := 0
		for _, e := range d.Events {
			if e.Kind == b.Value {
				per[e.Plate]++
				count++
			}
		}
		list := make([]unitN, 0, len(per))
		for p, n := range per {
			list = append(list, unitN{p, n})
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].n != list[j].n {
				return list[i].n > list[j].n
			}
			return list[i].plate < list[j].plate
		})
		breaches = append(breaches, breach{b.Label, count, list})
		breachTotal += count
	}
	reporting := 0
	for _, u := range d.Units {
		if u.Online {
			reporting++
		}
	}

	doc := newDoc("shift", "End of Shift Report", "ES", d, []InfoPair{
		{"Shift", shiftWords},
		{"Units", fmt.Sprintf("%d (%d reporting)", len(d.Units), reporting)},
	})
	k := 1
	head := func(text, small string) Block {
		b := Block{Type: "heading", Text: fmt.Sprintf("%d. %s", k, text), Small: small}
		k++
		return b
	}
	doc.Blocks = append(doc.Blocks, head("Shift Overview", periodWords(d.From, d.To)), Block{Type: "kpis", KPIs: []KPI{
		{"Critical alarms", strconv.Itoa(len(critical))},
		{"Policy breaches", strconv.Itoa(breachTotal)},
		{"Units with breaches", strconv.Itoa(len(breachUnits))},
		{"Units reporting", fmt.Sprintf("%d of %d", reporting, len(d.Units))},
	}})

	doc.Blocks = append(doc.Blocks, head("Critical alarms", strconv.Itoa(len(critical))))
	if len(critical) == 0 {
		doc.Blocks = append(doc.Blocks, Block{Type: "empty", Text: "No critical alarm in this shift."})
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
				orDash(units[e.VehicleID].Driver), {Text: e.Label}, speed, clip})
		}
		doc.Blocks = append(doc.Blocks, Block{Type: "table", Cols: []Col{{H: "Time", W: 16}, {H: "Vehicle", W: 24},
			{H: "Driver", W: 34}, {H: "Alarm", W: 46}, {H: "Speed", W: 18, Right: true}, {H: "Clip", W: 14}}, Rows: rows})
	}

	doc.Blocks = append(doc.Blocks, head("Policy breaches", strconv.Itoa(breachTotal)))
	kpis := make([]KPI, 0, len(breaches))
	var rows [][]Cell
	for _, b := range breaches {
		kpis = append(kpis, KPI{b.label + " · " + nOf(len(b.units), "unit", "units"), strconv.Itoa(b.count)})
		rows = append(rows, []Cell{{Text: b.label, Bold: true}, {Text: strconv.Itoa(b.count), Bold: true}})
		if len(b.units) == 0 {
			rows = append(rows, []Cell{{Text: "None", Muted: true, Indent: true}, {}})
		}
		for _, u := range b.units {
			rows = append(rows, []Cell{{Text: u.plate, Indent: true}, {Text: strconv.Itoa(u.n)}})
		}
	}
	doc.Blocks = append(doc.Blocks, Block{Type: "kpis", KPIs: kpis}, Block{Type: "spacer"},
		Block{Type: "table", Cols: []Col{{H: "Breach / unit", W: 150}, {H: "Count", W: 34, Right: true}}, Rows: rows})

	list := append([]rptUnit(nil), d.Units...)
	sort.SliceStable(list, func(i, j int) bool {
		if c := byKm(d.km(list[i]), d.km(list[j])); c != 0 {
			return c < 0
		}
		return list[i].Plate < list[j].Plate
	})
	total, unknown := 0.0, false
	var urows [][]Cell
	for _, u := range list {
		km := d.km(u)
		if km != nil {
			total += *km
		} else {
			unknown = true
		}
		urows = append(urows, []Cell{{Text: u.Plate, Bold: true}, kmCell(km), {Text: d.place(u), Wrap: true}, stateCell(u.state())})
	}
	doc.Blocks = append(doc.Blocks, head("Units", fmt.Sprintf("%d · %s km in the shift", len(list), num(total))),
		Block{Type: "table", Cols: []Col{{H: "Vehicle", W: 30}, {H: "Distance in shift", W: 34, Right: true},
			{H: "Current location", W: 90}, {H: "State", W: 22}}, Rows: urows})
	if unknown {
		doc.Blocks = append(doc.Blocks, Block{Type: "note", Text: "Not available: the unit's trip history for the shift could not be read."})
	}
	doc.Summary = map[string]any{"critical": len(critical), "breaches": breachTotal, "reporting": reporting,
		"units": len(d.Units), "period": periodWords(d.From, d.To)}
	return doc
}

// buildReport makes one report for [from, to). Movements and End of Shift
// also read each unit's trip history and place name, which takes a while on
// a cold cache: the partner answers one request every 600 ms.
func (s *Server) buildReport(ctx context.Context, kind string, from, to, now time.Time, shiftWords string) (*ReportDoc, error) {
	d := s.reportData(from, to, now)
	if kind == "breaches" {
		return buildBreaches(d), nil
	}
	km, err := s.reports.distances(ctx, s.client, d.Units, from, to, now)
	if err != nil {
		return nil, err
	}
	d.Km = km
	d.Places = s.reports.places(ctx, s.cfg.GoogleKey(), d.Units)
	if kind == "shift" {
		return buildShift(d, shiftWords), nil
	}
	return buildMovements(d), nil
}
