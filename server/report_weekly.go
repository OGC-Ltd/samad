package main

// Weekly Incidents (operator, 2026-11-07: "a report on a weekly basis on the
// number of incidents per driver/truck … this number of incidents is to go
// down weekly as we keep monitoring these incidents and as we change the
// culture of the drivers"). An incident is a policy breach: overspeeding,
// harsh braking, harsh acceleration, no seatbelt, on phone, camera covered.
//
// Events and day tallies are kept 30 days (keepEventsFor), so each finished
// week is also kept as a small tally (Store.archiveWeeks, run with the daily
// prune) that outlives them: per truck its km and incidents by kind, and the
// same per driver. An incident is put on the driver the truck had that fleet
// day (the day tally's driver: IntelliFleet's, else the roster's), not
// whoever drives it today. Weeks run Monday 00:00 to Monday 00:00, Nairobi.

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// WeekTally is one week's incidents and distance.
type WeekTally struct {
	Units map[int]*WeekUnit `json:"units"`
	// Since is the first fleet day with records when the week began before
	// them, so the week is only partly counted.
	Since string `json:"since,omitempty"`
}

type WeekUnit struct {
	Plate   string                 `json:"plate"`
	Km      float64                `json:"km"`
	Counts  map[string]int         `json:"counts,omitempty"`
	Drivers map[string]*WeekDriver `json:"drivers,omitempty"` // by driverKey; "" is no driver
}

type WeekDriver struct {
	Name   string         `json:"name"`
	Km     float64        `json:"km"`
	Counts map[string]int `json:"counts,omitempty"`
}

const (
	weeklyMax    = 12  // weeks in one report
	weeksKeptFor = 104 // weeks the tallies are kept
)

// weekStart is the Monday 00:00 (Nairobi) of t's week.
func weekStart(t time.Time) time.Time {
	d := dayStartOf(t)
	return d.AddDate(0, 0, -((int(d.Weekday()) + 6) % 7))
}

// driverKey matches "MOSES WANYONYI" from the roster with "Moses  Wanyonyi".
func driverKey(name string) string { return strings.ToUpper(strings.Join(strings.Fields(name), " ")) }

// displayName writes a name typed in capitals as "Moses Wanyonyi".
func displayName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if name != strings.ToUpper(name) {
		return name
	}
	words := strings.Fields(strings.ToLower(name))
	for i, w := range words {
		r := []rune(w)
		words[i] = strings.ToUpper(string(r[:1])) + string(r[1:])
	}
	return strings.Join(words, " ")
}

func sumCounts(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

// tallyWeek counts the week starting at start from the stored events and
// day tallies.
func tallyWeek(start time.Time, events []PEvent, days map[string]map[int]DayStats, vehicles map[int]PVehicle) *WeekTally {
	end := start.AddDate(0, 0, 7)
	t := &WeekTally{Units: map[int]*WeekUnit{}}
	unit := func(id int, plate string) *WeekUnit {
		u := t.Units[id]
		if u == nil {
			if v, ok := vehicles[id]; ok && v.Registration != "" {
				plate = v.Registration
			}
			if plate == "" {
				plate = vehicleKey(id)
			}
			u = &WeekUnit{Plate: plate, Counts: map[string]int{}, Drivers: map[string]*WeekDriver{}}
			t.Units[id] = u
		}
		return u
	}
	driverOf := func(day string, id int) string {
		if st, ok := days[day][id]; ok && st.Driver != "" {
			return st.Driver
		}
		if v, ok := vehicles[id]; ok && v.Driver != nil {
			return v.Driver.Name
		}
		return ""
	}
	driver := func(u *WeekUnit, name string) *WeekDriver {
		k := driverKey(name)
		d := u.Drivers[k]
		if d == nil {
			d = &WeekDriver{Name: displayName(name), Counts: map[string]int{}}
			u.Drivers[k] = d
		}
		return d
	}
	for day := start; day.Before(end); day = day.AddDate(0, 0, 1) {
		dk := fleetDay(day)
		for id, st := range days[dk] {
			if st.Km <= 0 {
				continue
			}
			u := unit(id, "")
			u.Km += st.Km
			driver(u, driverOf(dk, id)).Km += st.Km
		}
	}
	for _, e := range events {
		at := parseTime(e.OccurredAt)
		if at.IsZero() || at.Before(start) || !at.Before(end) {
			continue
		}
		k := reportKind(e)
		if !isBreachKind(k) {
			continue
		}
		u := unit(e.VehicleID, e.Registration)
		u.Counts[k]++
		driver(u, driverOf(fleetDay(at), e.VehicleID)).Counts[k]++
	}
	return t
}

// ── the store's side: keeping finished weeks ─────────────────────────────

// firstDay is the earliest fleet day with a tally; "" when there is none.
// The caller holds the lock.
func (s *Store) firstDay() string {
	first := ""
	for d := range s.p.Days {
		if first == "" || d < first {
			first = d
		}
	}
	return first
}

func (s *Store) daysCopy() map[string]map[int]DayStats {
	out := make(map[string]map[int]DayStats, len(s.p.Days))
	for d, m := range s.p.Days {
		c := make(map[int]DayStats, len(m))
		for id, st := range m {
			c[id] = *st
		}
		out[d] = c
	}
	return out
}

// archiveWeeks (re)counts every finished week whose records are all still
// kept, so the tally a week leaves behind is the last full count of it, made
// with every review done by then. Weeks older than two years are dropped.
// The caller holds the lock.
func (s *Store) archiveWeeks(now, floor time.Time) {
	if s.p.Weeks == nil {
		s.p.Weeks = map[string]*WeekTally{}
	}
	first := s.firstDay()
	if first == "" {
		return
	}
	firstAt, err := time.ParseInLocation("2006-01-02", first, fleetZone)
	if err != nil {
		return
	}
	days := s.daysCopy()
	cover := floor
	if firstAt.After(cover) {
		cover = firstAt
	}
	for w := weekStart(cover); !w.AddDate(0, 0, 7).After(now); w = w.AddDate(0, 0, 7) {
		if w.Before(floor) {
			continue // its first days are already gone
		}
		t := tallyWeek(w, s.p.Events, days, s.vehicles)
		if w.Before(firstAt) {
			t.Since = first
		}
		s.p.Weeks[fleetDay(w)] = t
	}
	oldest := fleetDay(weekStart(now).AddDate(0, 0, -7*weeksKeptFor))
	for k := range s.p.Weeks {
		if k < oldest {
			delete(s.p.Weeks, k)
		}
	}
	s.dirty = true
}

// weekSource is what a report reads for the weeks: the kept tallies, the
// raw events and day tallies, and from when the raw records are whole.
type weekSource struct {
	kept     map[string]*WeekTally
	events   []PEvent
	days     map[string]map[int]DayStats
	vehicles map[int]PVehicle
	cover    time.Time // raw records are whole from here
	first    time.Time // the first day with any record; zero when none
}

func (s *Store) weekSource(now time.Time) weekSource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ws := weekSource{
		kept:     make(map[string]*WeekTally, len(s.p.Weeks)),
		events:   append([]PEvent(nil), s.p.Events...),
		days:     s.daysCopy(),
		vehicles: make(map[int]PVehicle, len(s.vehicles)),
		cover:    now.Add(-keepEventsFor),
	}
	for k, t := range s.p.Weeks { // a kept tally is replaced, never changed, so sharing it is safe
		ws.kept[k] = t
	}
	for id, v := range s.vehicles {
		ws.vehicles[id] = v
	}
	if first := s.firstDay(); first != "" {
		if at, err := time.ParseInLocation("2006-01-02", first, fleetZone); err == nil {
			ws.first = at
			if at.After(ws.cover) {
				ws.cover = at
			}
		}
	}
	return ws
}

// week is the tally for the week starting at w, and whether there is any
// record of it.
func (ws weekSource) week(w time.Time) (*WeekTally, bool) {
	end := w.AddDate(0, 0, 7)
	if !w.Before(ws.cover) { // every record of it is still kept
		return tallyWeek(w, ws.events, ws.days, ws.vehicles), true
	}
	if t, ok := ws.kept[fleetDay(w)]; ok {
		return t, true
	}
	if ws.first.IsZero() || !end.After(ws.cover) {
		return nil, false
	}
	t := tallyWeek(w, ws.events, ws.days, ws.vehicles) // only its last days are kept
	t.Since = fleetDay(ws.cover)
	return t, true
}

// ── the report ───────────────────────────────────────────────────────────

type wkCol struct {
	start   time.Time
	tally   *WeekTally
	have    bool
	running bool // the week now under way, counted so far
}

func (c wkCol) label() string { _, n := c.start.ISOWeek(); return "Wk " + strconv.Itoa(n) }

// dates is "2–8 Nov" or "27 Oct–2 Nov".
func (c wkCol) dates() string {
	a, b := eat(c.start), eat(c.start.AddDate(0, 0, 6))
	s := a.Format("2 Jan") + "–" + b.Format("2 Jan")
	if a.Month() == b.Month() {
		s = fmt.Sprintf("%d–%d %s", a.Day(), b.Day(), b.Format("Jan"))
	}
	if c.running {
		s += ", so far"
	}
	return s
}

// wkLine is one driver's or truck's weeks.
type wkLine struct {
	name   string
	others map[string]float64 // trucks a driver drove, or a truck's drivers, by km
	counts []int              // per week, incidents
	km     []float64          // per week
	kinds  map[string]int     // over the shown weeks
}

func newLine(name string, n int) *wkLine {
	return &wkLine{name: name, others: map[string]float64{}, counts: make([]int, n), km: make([]float64, n), kinds: map[string]int{}}
}

func (w *wkLine) total(from int) int {
	n := 0
	for _, c := range w.counts[from:] {
		n += c
	}
	return n
}

// with lists the other names, most km first: "KDN 506L, KDU 566F +1".
func (w *wkLine) with() string {
	type kv struct {
		k string
		v float64
	}
	var list []kv
	for k, v := range w.others {
		if k != "" {
			list = append(list, kv{k, v})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].v != list[j].v {
			return list[i].v > list[j].v
		}
		return list[i].k < list[j].k
	})
	if len(list) == 0 {
		return ""
	}
	names := []string{list[0].k}
	if len(list) > 1 {
		names = append(names, list[1].k)
	}
	s := strings.Join(names, ", ")
	if len(list) > 2 {
		s += fmt.Sprintf(" +%d", len(list)-2)
	}
	return s
}

func per100(n int, km float64) string {
	if km < 1 {
		return "-"
	}
	return strconv.FormatFloat(math.Round(float64(n)/km*1000)/10, 'f', 1, 64)
}

// change is "Down 3 (−40%)", "Up 2", "Same" or "None".
func change(prev, last int) Cell {
	switch {
	case prev == 0 && last == 0:
		return Cell{Text: "None", Muted: true}
	case last == prev:
		return Cell{Text: "Same"}
	case prev == 0:
		return Cell{Text: fmt.Sprintf("Up %d", last), Bold: true}
	}
	pct := int(math.Round(float64(last-prev) / float64(prev) * 100))
	if last < prev {
		return Cell{Text: fmt.Sprintf("Down %d (−%d%%)", prev-last, -pct)}
	}
	return Cell{Text: fmt.Sprintf("Up %d (+%d%%)", last-prev, pct), Bold: true}
}

// buildWeekly shows n weeks ending with the week starting at last (a
// Monday, at most this week's, which is then counted so far).
func (s *Server) buildWeekly(n int, last, now time.Time) *ReportDoc {
	ws := s.store.weekSource(now)
	return buildWeekly(weekCols(ws, n, last, now), ws.vehicles, now)
}

func weekCols(ws weekSource, n int, last, now time.Time) []wkCol {
	end := last.AddDate(0, 0, 7)
	// One week more than shown, for the first week's change.
	cols := make([]wkCol, n+1)
	for i := range cols {
		st := end.AddDate(0, 0, -7*(n+1-i))
		t, ok := ws.week(st)
		cols[i] = wkCol{start: st, tally: t, have: ok, running: st.AddDate(0, 0, 7).After(now)}
	}
	return cols
}

func buildWeekly(cols []wkCol, vehicles map[int]PVehicle, now time.Time) *ReportDoc {
	n := len(cols) - 1
	shown := cols[1:]
	last, prev := len(cols)-1, len(cols)-2

	drivers := map[string]*wkLine{}
	trucks := map[int]*wkLine{}
	fleetKm := make([]float64, len(cols))
	fleetN := make([]int, len(cols))
	fleetKinds := make([]map[string]int, len(cols))
	for i, c := range cols {
		fleetKinds[i] = map[string]int{}
		if c.tally == nil {
			continue
		}
		for id, u := range c.tally.Units {
			plate := u.Plate
			if v, ok := vehicles[id]; ok && v.Registration != "" {
				plate = v.Registration
			}
			tl := trucks[id]
			if tl == nil {
				tl = newLine(plate, len(cols))
				trucks[id] = tl
			}
			tl.counts[i] += sumCounts(u.Counts)
			tl.km[i] += u.Km
			fleetKm[i] += u.Km
			fleetN[i] += sumCounts(u.Counts)
			for k, v := range u.Counts {
				fleetKinds[i][k] += v
				if i > 0 {
					tl.kinds[k] += v
				}
			}
			for key, d := range u.Drivers {
				name := d.Name
				if key == "" {
					name = "No driver on record"
				}
				dl := drivers[key]
				if dl == nil {
					dl = newLine(name, len(cols))
					drivers[key] = dl
				}
				dl.counts[i] += sumCounts(d.Counts)
				dl.km[i] += d.Km
				dl.others[plate] += d.Km + 0.001*float64(sumCounts(d.Counts))
				if key != "" {
					tl.others[name] += d.Km + 0.001*float64(sumCounts(d.Counts))
				}
				for k, v := range d.Counts {
					if i > 0 {
						dl.kinds[k] += v
					}
				}
			}
		}
	}

	lastCol, prevCol := cols[last], cols[prev]
	doc := &ReportDoc{
		Kind: "weekly", Title: "Weekly Incidents Report", ReportNo: reportNumber("WI", now),
		Date: eat(lastCol.start).Format("02/01/2006"), Company: OrgName, Orientation: "landscape",
		GeneratedAt: now.UTC().Format(time.RFC3339),
	}
	span := shown[0].label() + " to " + lastCol.label()
	if n == 1 {
		span = lastCol.label()
	}
	spanDates := eat(shown[0].start).Format("2 Jan") + " to " + eat(lastCol.start.AddDate(0, 0, 6)).Format("2 Jan 2006")
	doc.Info = []InfoPair{
		{Label: "Fleet", Value: OrgName},
		{Label: "Weeks", Value: span + " · " + spanDates},
		{Label: "Incidents", Value: "Policy breaches"},
		{Label: "Generated", Value: fmtShort(now)},
	}
	doc.FootNote = OrgName + " · Weekly incidents · " + span + " · made " + eat(now).Format("2 Jan 2006, 15:04")
	doc.Filename = "Weekly incidents " + OrgName + " " + strings.ReplaceAll(span, "Wk ", "wk")

	// Better and worse, last week against the one before.
	type move struct {
		line       *wkLine
		prev, last int
	}
	moves := func(m map[string]*wkLine) (better, worse []move) {
		for _, l := range m {
			p, c := l.counts[prev], l.counts[last]
			switch {
			case c < p:
				better = append(better, move{l, p, c})
			case c > p:
				worse = append(worse, move{l, p, c})
			}
		}
		sort.Slice(better, func(i, j int) bool {
			if a, b := better[i].prev-better[i].last, better[j].prev-better[j].last; a != b {
				return a > b
			}
			return better[i].line.name < better[j].line.name
		})
		sort.Slice(worse, func(i, j int) bool {
			if a, b := worse[i].last-worse[i].prev, worse[j].last-worse[j].prev; a != b {
				return a > b
			}
			return worse[i].line.name < worse[j].line.name
		})
		return better, worse
	}
	byName := func(m map[int]*wkLine) map[string]*wkLine {
		out := make(map[string]*wkLine, len(m))
		for id, l := range m {
			out[strconv.Itoa(id)] = l
		}
		return out
	}
	dBetter, dWorse := moves(drivers)
	tBetter, tWorse := moves(byName(trucks))

	fleetChange := change(fleetN[prev], fleetN[last])
	rate := per100(fleetN[last], fleetKm[last])
	if r := per100(fleetN[prev], fleetKm[prev]); r != "-" && rate != "-" {
		rate += " (was " + r + ")"
	}
	k := 1
	head := func(text, small string) Block {
		b := Block{Type: "heading", Text: fmt.Sprintf("%d. %s", k, text), Small: small}
		k++
		return b
	}
	doc.Blocks = append(doc.Blocks, head("Overview", lastCol.label()+" ("+lastCol.dates()+") against "+prevCol.label()),
		Block{Type: "kpis", KPIs: []KPI{
			{Label: "Incidents, " + lastCol.label(), Value: strconv.Itoa(fleetN[last])},
			{Label: "Change on " + prevCol.label(), Value: fleetChange.Text},
			{Label: "Per 100 km, " + lastCol.label(), Value: rate},
			{Label: "Drivers better / worse", Value: fmt.Sprintf("%d / %d", len(dBetter), len(dWorse))},
			{Label: "Trucks better / worse", Value: fmt.Sprintf("%d / %d", len(tBetter), len(tWorse))},
		}})
	if lastCol.running {
		doc.Blocks = append(doc.Blocks, Block{Type: "note", Text: lastCol.label() + " is still under way: it is counted to " + fmtShort(now) + ", against the whole of " + prevCol.label() + "."})
	}
	if !lastCol.have || !prevCol.have {
		doc.Blocks = append(doc.Blocks, Block{Type: "note", Text: "There is no record of " + map[bool]string{true: prevCol.label(), false: lastCol.label()}[lastCol.have] + ", so its change cannot be told yet."})
	}

	// The fleet, week by week.
	doc.Blocks = append(doc.Blocks, head("The fleet, week by week", "incidents, and per 100 km driven"))
	var bars []KPI
	fcols := []Col{{H: "Week", W: 12}, {H: "Dates", W: 18}}
	for _, b := range breachKinds {
		fcols = append(fcols, Col{H: b.Label, W: 13, Right: true})
	}
	fcols = append(fcols, Col{H: "Total", W: 10, Right: true}, Col{H: "Km", W: 13, Right: true},
		Col{H: "Per 100 km", W: 12, Right: true}, Col{H: "Change", W: 22})
	var frows [][]Cell
	for j, c := range shown {
		i := j + 1
		if !c.have {
			bars = append(bars, KPI{Label: c.label() + " · " + c.dates(), Value: "-", Sub: "no record"})
			row := []Cell{{Text: c.label(), Bold: true}, {Text: c.dates()}}
			for range breachKinds {
				row = append(row, Cell{Text: "-", Muted: true})
			}
			frows = append(frows, append(row, Cell{Text: "-", Muted: true}, Cell{Text: "-", Muted: true},
				Cell{Text: "-", Muted: true}, Cell{Text: "No record", Muted: true}))
			continue
		}
		sub := per100(fleetN[i], fleetKm[i]) + " per 100 km · " + fmtThousands(fleetKm[i]) + " km"
		if since, err := time.ParseInLocation("2006-01-02", c.tally.Since, fleetZone); err == nil {
			sub += " · km from " + since.Format("2 Jan")
		}
		bars = append(bars, KPI{Label: c.label() + " · " + c.dates(), Value: strconv.Itoa(fleetN[i]), Sub: sub})
		row := []Cell{{Text: c.label(), Bold: true}, {Text: c.dates()}}
		for _, b := range breachKinds {
			v := fleetKinds[i][b.Value]
			row = append(row, Cell{Text: strconv.Itoa(v), Muted: v == 0})
		}
		ch := Cell{Text: "-", Muted: true}
		if cols[i-1].have {
			ch = change(fleetN[i-1], fleetN[i])
		}
		frows = append(frows, append(row, Cell{Text: strconv.Itoa(fleetN[i]), Bold: true}, Cell{Text: fmtThousands(fleetKm[i])},
			Cell{Text: per100(fleetN[i], fleetKm[i])}, ch))
	}
	doc.Blocks = append(doc.Blocks, Block{Type: "bars", KPIs: bars}, Block{Type: "spacer"}, Block{Type: "table", Cols: fcols, Rows: frows})

	// Most better, most worse.
	const top = 5
	moveGroup := func(title, none string, list []move) SubTable {
		g := SubTable{Text: title, Empty: none}
		if len(list) == 0 {
			return g
		}
		if len(list) > top {
			g.Small = fmt.Sprintf("top %d of %d", top, len(list))
		}
		g.Cols = []Col{{H: "Name", W: 40}, {H: prevCol.label(), W: 10, Right: true}, {H: lastCol.label(), W: 10, Right: true}, {H: "Change", W: 22}}
		for _, m := range list[:min(top, len(list))] {
			g.Rows = append(g.Rows, []Cell{{Text: m.line.name, Bold: true}, {Text: strconv.Itoa(m.prev)}, {Text: strconv.Itoa(m.last)}, change(m.prev, m.last)})
		}
		return g
	}
	doc.Blocks = append(doc.Blocks, head("Better and worse", lastCol.label()+" against "+prevCol.label()), Block{Type: "groups", Groups: []SubTable{
		moveGroup("Drivers with fewer incidents", "No driver had fewer incidents.", dBetter),
		moveGroup("Drivers with more incidents", "No driver had more incidents.", dWorse),
		moveGroup("Trucks with fewer incidents", "No truck had fewer incidents.", tBetter),
		moveGroup("Trucks with more incidents", "No truck had more incidents.", tWorse),
	}})

	// Every driver and truck, week by week.
	lineTable := func(lines []*wkLine, who, with string) Block {
		cs := []Col{{H: who, W: 30}, {H: with, W: 30}}
		for _, c := range shown {
			cs = append(cs, Col{H: c.label(), W: 8, Right: true})
		}
		cs = append(cs, Col{H: "Total", W: 9, Right: true}, Col{H: "Per 100 km, " + lastCol.label(), W: 13, Right: true}, Col{H: "Change", W: 20})
		var rows [][]Cell
		for _, l := range lines {
			row := []Cell{{Text: l.name, Bold: true}, orDash(l.with())}
			for j, c := range shown {
				i := j + 1
				switch {
				case !c.have:
					row = append(row, Cell{Text: "-", Muted: true})
				case l.counts[i] == 0 && l.km[i] < 1:
					row = append(row, Cell{Text: "-", Muted: true}) // off the road
				default:
					row = append(row, Cell{Text: strconv.Itoa(l.counts[i]), Muted: l.counts[i] == 0})
				}
			}
			rows = append(rows, append(row, Cell{Text: strconv.Itoa(l.total(1)), Bold: true},
				Cell{Text: per100(l.counts[last], l.km[last])}, change(l.counts[prev], l.counts[last])))
		}
		return Block{Type: "table", Cols: cs, Rows: rows}
	}
	order := func(lines []*wkLine) []*wkLine {
		sort.Slice(lines, func(i, j int) bool {
			a, b := lines[i], lines[j]
			if a.counts[last] != b.counts[last] {
				return a.counts[last] > b.counts[last]
			}
			if a.total(1) != b.total(1) {
				return a.total(1) > b.total(1)
			}
			return a.name < b.name
		})
		return lines
	}
	active := func(l *wkLine) bool {
		for i := 1; i < len(cols); i++ {
			if l.counts[i] > 0 || l.km[i] >= 1 {
				return true
			}
		}
		return false
	}
	var dl, tl []*wkLine
	for _, l := range drivers {
		if active(l) {
			dl = append(dl, l)
		}
	}
	for _, l := range trucks {
		if active(l) {
			tl = append(tl, l)
		}
	}
	doc.Blocks = append(doc.Blocks,
		head("Drivers", nOf(len(dl), "driver", "drivers")+" · most incidents in "+lastCol.label()+" first"), lineTable(order(dl), "Driver", "Trucks"),
		head("Trucks", nOf(len(tl), "truck", "trucks")+" · most incidents in "+lastCol.label()+" first"), lineTable(order(tl), "Truck", "Drivers"),
		Block{Type: "note", Text: "Incidents are the policy breaches: overspeeding, harsh braking, harsh acceleration, no seatbelt, on phone and camera covered. No seatbelt, on phone and camera covered come from the dashcams, so only trucks with a camera can raise them."},
		Block{Type: "note", Text: "Each incident is put on the driver the truck had that day (IntelliFleet's assignment, else the roster)."},
	)
	if len(dl) == 0 && len(tl) == 0 {
		doc.Blocks = append(doc.Blocks, Block{Type: "empty", Text: "No record of these weeks yet."})
	}
	doc.Summary = map[string]any{"incidents": fleetN[last], "week": lastCol.label(), "change": fleetChange.Text,
		"drivers": len(dl), "trucks": len(tl), "period": span}
	return doc
}
