package main

// Road Safety Compliance (operator, 2026-11-23, compliance-page-spec.md): the
// client's Road Safety Standard, measured from what the system already has.
// Only requirements the system can measure from its own data are here; no
// hand-typed statuses.
//
//	5.1.3   no phone use while driving   dashcam phone use (smoking and distracted
//	                                     alarms left out: false alarms)
//	5.1.4a  working hours                hours.go working_hours_day/_week
//	5.1.4b  total hours with overtime    hours.go overtime_day/_week
//	5.1.4c  overtime not structural      days over 8 h worked, per unit-week
//	5.1.4d  break after 4.5 h driving    hours.go no_break
//	5.1.4e  daily rest                   hours.go daily_rest
//	5.1.4f  weekly rest                  hours.go weekly_rest, per unit-week
//	5.1.4g  driving time                 hours.go driving_time_day/_week
//	5.1.5   telematics                   units reporting positions; with a dashcam
//	5.1.6   incidents handled on time    critical alarms reviewed within 6 h
//	5.2.2e  seat belts in use            dashcam no-seatbelt alarms
//	5.2.2h  speed limiters working       highest speed vs the 70 km/h setting
//	                                     (SPEED_LIMITER_KMH; 0 leaves it out)
//
// A driver-day is one vehicle on one fleet day (Nairobi midnight to midnight)
// on which it worked: a day hours.go tallied work for (dutyState.Days, Work
// above zero), from the day its monitoring began (dutyState.Since). A
// driver-day is breached for a row when one of the row's rules has a breach
// for that vehicle that occurred on that fleet day; a week rule lands on the
// day its limit was crossed. Before hours monitoring began, the hours rows
// read "Not monitored", never 100 %.
//
// Alarms are counted as the reports count them, as incidents: No seatbelt and
// On phone repeated within 10 minutes count once (incidents.go). Units with
// no such alarm are what a row's compliance is made of, so folding changes
// the counts, not the %.

import (
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 5.1.6's deadline: a critical alarm reviewed within this is on time.
const reviewWithin = 6 * time.Hour

// speedLimiterKmh is the setting the speed limiters are checked against:
// 70 km/h (operator, 2026-11-23). SPEED_LIMITER_KMH changes it; 0 leaves
// 5.2.2h out.
var speedLimiterKmh = 70.0

type compUnit struct {
	VehicleID string `json:"vehicleId"`
	Plate     string `json:"plate"`
	Driver    string `json:"driver"`
	N         int    `json:"n"`
	// The incidents behind N, newest first (operator, 2026-11-23: a unit
	// opens to show them). At most maxUnitItems.
	Items []compItem `json:"items,omitempty"`
}

// compItem is one incident in a unit's list: when, what happened, who drove,
// and where for a dashcam alarm.
type compItem struct {
	At     string   `json:"at"` // RFC 3339
	What   string   `json:"what"`
	Driver string   `json:"driver,omitempty"`
	Speed  *float64 `json:"speed,omitempty"`
	Lat    *float64 `json:"lat,omitempty"`
	Lon    *float64 `json:"lon,omitempty"`
	// WholeDay: At (and Until) stand for fleet days, not moments.
	WholeDay bool `json:"wholeDay,omitempty"`
	// Until ends the stretch that was checked (a 24 h rest window, a week),
	// RFC 3339, exclusive.
	Until string `json:"until,omitempty"`
}

// short is a duration as the panel says it: "4 h 17 min", "40 min", "6 h".
func short(sec float64) string {
	m := int(math.Round(sec / 60))
	switch {
	case m%60 == 0:
		return fmt.Sprintf("%d h", m/60)
	case m < 60:
		return fmt.Sprintf("%d min", m)
	}
	return fmt.Sprintf("%d h %d min", m/60, m%60)
}

var hmText = regexp.MustCompile(`(\d+) h (\d+) min`)

// textSec reads the first "9 h 05 min" in a breach's text (hours.go hm).
func textSec(s string) (float64, bool) {
	m := hmText.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	return float64(h*3600 + mi*60), true
}

// describeHours rewrites an hours breach for the panel (operator,
// 2026-11-23): the stretch that was checked, and what it came to against the
// limit, "Longest rest was 6 h 43 min. Needed 11 h (4 h 17 min short)." The
// day and week rules use the day's or week's final total from the tally,
// not the figure when the limit was first crossed. Left as it was when the
// breach cannot be read.
func describeHours(it *compItem, e PEvent, duty map[int]dutyView) {
	sec, ok := textSec(e.TypeLabel)
	if !ok {
		return
	}
	period := e.EventID[strings.LastIndex(e.EventID, ":")+1:]
	dayAt := func(day string) (time.Time, bool) {
		t, err := time.ParseInLocation("2006-01-02", day, fleetZone)
		return t, err == nil
	}
	stamp := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	tally := func(day string, drive bool) float64 {
		dd, has := duty[e.VehicleID].Days[day]
		if !has {
			return 0
		}
		if drive {
			return dd.Drive
		}
		return dd.Work
	}
	over := func(verb string, got float64, limit time.Duration, on string) {
		it.What = fmt.Sprintf("%s %s%s. Limit %s (%s over).", verb, short(got), on, short(limit.Seconds()), short(got-limit.Seconds()))
	}
	switch e.Type {
	case ruleWorkDay, ruleTotalDay, ruleDriveDay:
		day, ok := dayAt(period)
		if !ok {
			return
		}
		drive := e.Type == ruleDriveDay
		sec = math.Max(sec, tally(period, drive))
		it.At, it.WholeDay = stamp(day.Add(time.Hour)), true
		switch e.Type {
		case ruleWorkDay:
			over("Worked", sec, workDayLimit, "")
		case ruleTotalDay:
			over("Worked", sec, totalDayLimit, "")
		default:
			over("Drove", sec, driveDayLimit, "")
		}
	case ruleWorkWeek, ruleTotalWeek, ruleDriveWeek:
		mon, ok := dayAt(period)
		if !ok {
			return
		}
		drive := e.Type == ruleDriveWeek
		var week float64
		for i := 0; i < 7; i++ {
			week += tally(fleetDay(mon.AddDate(0, 0, i).Add(time.Hour)), drive)
		}
		sec = math.Max(sec, week)
		it.At, it.Until, it.WholeDay = stamp(mon.Add(time.Hour)), stamp(mon.AddDate(0, 0, 7).Add(time.Hour)), true
		switch e.Type {
		case ruleWorkWeek:
			over("Worked", sec, workWeekLimit, " in the week")
		case ruleTotalWeek:
			over("Worked", sec, totalWeekLimit, " in the week")
		default:
			over("Drove", sec, driveWeekLimit, " in the week")
		}
	case ruleBreak:
		if start, err := time.Parse("20060102T150405", period); err == nil {
			it.At, it.Until = stamp(start), e.OccurredAt
		}
		it.What = fmt.Sprintf("Drove %s without a 30-minute break. Limit 4½ h.", short(sec))
	case ruleRestDay:
		start, err := time.Parse("20060102T150405", period)
		if err != nil {
			return
		}
		it.At, it.Until = stamp(start), stamp(start.Add(24*time.Hour))
		it.What = fmt.Sprintf("Longest rest was %s. Needed 11 h (%s short).", short(sec), short(dailyRestNeeded.Seconds()-sec))
	case ruleRestWeek:
		if mon, ok := dayAt(period); ok {
			it.At, it.Until, it.WholeDay = stamp(mon.Add(time.Hour)), stamp(mon.AddDate(0, 0, 7).Add(time.Hour)), true
		}
		it.What = fmt.Sprintf("Longest rest was %s. Needed 24 h (%s short).", short(sec), short(weekRestNeeded.Seconds()-sec))
	}
}

const maxUnitItems = 50

// itemWhat is an incident's words: an hours breach's detail after its rule
// name ("Daily rest: longest rest 8 h 12 min…" → "longest rest 8 h 12 min…"),
// else the alarm's name.
func itemWhat(e PEvent) string {
	if e.Source == "hours" {
		if _, rest, ok := strings.Cut(e.TypeLabel, ": "); ok {
			return rest
		}
	}
	if e.TypeLabel != "" {
		return e.TypeLabel
	}
	return e.Type
}

type compDay struct {
	Day string `json:"day"`
	N   int    `json:"n"`
}

type compWeek struct {
	From       string `json:"from"` // the Monday, YYYY-MM-DD
	Label      string `json:"label"`
	Compliance *int   `json:"compliance"`
}

// compAlerts is where "Open in Alerts" goes (lib/alertsRequest on the page).
type compAlerts struct {
	Kind  string `json:"kind"`
	Alarm string `json:"alarm,omitempty"`
}

type compRow struct {
	Ref         string `json:"ref"`
	Category    string `json:"category"`
	Requirement string `json:"requirement"`
	Measure     string `json:"measure"`
	Result      string `json:"result"`
	Compliance  *int   `json:"compliance"` // null: not monitored, or nothing to measure
	Monitored   bool   `json:"monitored"`
	Breaches    int    `json:"breaches"`
	// The plain sum behind the figure (operator, 2026-11-23: "make the
	// explanation straightforward"): Passed of Total Noun were OK.
	Passed   int         `json:"passed"`
	Total    int         `json:"total"`
	Noun     string      `json:"noun"`
	UnitWord string      `json:"unitWord,omitempty"` // what byUnit's n counts, when not breaches
	ByUnit   []compUnit  `json:"byUnit"`
	ByDay    []compDay   `json:"byDay"`
	Weeks    []compWeek  `json:"weeks,omitempty"`
	Alerts   *compAlerts `json:"alerts,omitempty"`
}

// dutyView is one vehicle's hours tally as compliance reads it.
type dutyView struct {
	Since time.Time
	Days  map[string]dutyDay
}

// DutyDays copies every vehicle's hours tally (hours.go).
func (s *Store) DutyDays() map[int]dutyView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[int]dutyView{}
	if s.p.Hours == nil {
		return out
	}
	for id, st := range s.p.Hours.Vehicles {
		v := dutyView{Since: st.Since, Days: make(map[string]dutyDay, len(st.Days))}
		for d, dd := range st.Days {
			if dd != nil {
				v.Days[d] = *dd
			}
		}
		out[id] = v
	}
	return out
}

// compInput is everything a period's rows are worked out from.
type compInput struct {
	From, To, Now time.Time
	Vehicles      []PVehicle
	Events        []PEvent                // the partner's, every kept one
	Hours         []PEvent                // hours.go breaches, every kept one
	Duty          map[int]dutyView        // hours.go tallies
	Reporting     map[string]map[int]bool // fleet day → vehicles with a position that day
	Decisions     func(id string) []Decision
	LimiterKmh    float64
}

// monitoredSince is when hours monitoring began: the earliest vehicle's.
func (in compInput) monitoredSince() time.Time {
	var first time.Time
	for _, d := range in.Duty {
		if !d.Since.IsZero() && (first.IsZero() || d.Since.Before(first)) {
			first = d.Since
		}
	}
	return first
}

func (in compInput) periodDays() []string {
	var days []string
	for t := dayStartOf(in.From); t.Before(in.To); t = t.AddDate(0, 0, 1) {
		days = append(days, fleetDay(t))
	}
	return days
}

func (in compInput) within(at time.Time) bool {
	return !at.IsZero() && !at.Before(in.From) && at.Before(in.To)
}

// pct is the share in whole per cent, 100 only when all are within.
func pct(ok, of int) *int {
	if of <= 0 {
		return nil
	}
	n := 100
	if ok < of {
		n = int(math.Floor(100 * float64(ok) / float64(of)))
	}
	return &n
}

// tallies count per vehicle and per day, for byUnit and byDay.
type tallies struct {
	unit    map[int]int
	day     map[string]int
	drivers map[int]string
	plates  map[int]string // from the events, for a unit not (yet) in the vehicle list
	items   map[int][]compItem
	duty    map[int]dutyView // the hours tally, for describeHours
}

func newTallies() *tallies {
	return &tallies{unit: map[int]int{}, day: map[string]int{}, drivers: map[int]string{}, plates: map[int]string{},
		items: map[int][]compItem{}}
}

func (t *tallies) add(e PEvent, at time.Time) {
	t.unit[e.VehicleID]++
	t.day[fleetDay(at)]++
	if what := itemWhat(e); what != "" {
		it := compItem{At: at.UTC().Format(time.RFC3339), What: what, Speed: e.Speed, Lat: e.Latitude, Lon: e.Longitude}
		if e.Driver != "Unassigned" {
			it.Driver = e.Driver
		}
		if e.Source == "hours" {
			describeHours(&it, e, t.duty)
		}
		t.items[e.VehicleID] = append(t.items[e.VehicleID], it)
	}
	if e.Driver != "" && e.Driver != "Unassigned" {
		t.drivers[e.VehicleID] = e.Driver
	}
	if e.Registration != "" {
		t.plates[e.VehicleID] = e.Registration
	}
}

func (t *tallies) units(in compInput) []compUnit {
	plates := map[int]PVehicle{}
	for _, v := range in.Vehicles {
		plates[v.VehicleID] = v
	}
	out := make([]compUnit, 0, len(t.unit))
	for id, n := range t.unit {
		u := compUnit{VehicleID: vehicleKey(id), N: n, Driver: t.drivers[id]}
		if v, ok := plates[id]; ok {
			u.Plate = v.Registration
			if u.Driver == "" {
				if d := driverName(v); d != "Unassigned" {
					u.Driver = d
				}
			}
		}
		if u.Plate == "" {
			u.Plate = t.plates[id]
		}
		if u.Plate == "" {
			u.Plate = vehicleKey(id)
		}
		if items := t.items[id]; len(items) > 0 {
			sorted := append([]compItem(nil), items...)
			sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At > sorted[j].At })
			if len(sorted) > maxUnitItems {
				sorted = sorted[:maxUnitItems]
			}
			u.Items = sorted
		}
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].N != out[j].N {
			return out[i].N > out[j].N
		}
		return out[i].Plate < out[j].Plate
	})
	return out
}

func (t *tallies) days(in compInput) []compDay {
	out := []compDay{}
	for _, d := range in.periodDays() {
		out = append(out, compDay{Day: d, N: t.day[d]})
	}
	return out
}

func nWord(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// ── the rows ────────────────────────────────────────────────────────────

// buildCompliance works out every row for in's period.
func buildCompliance(in compInput) []compRow {
	rows := []compRow{
		alarmRow(in, "5.1.3", "Operational", "No phone use while driving",
			"Dashcam phone-use alarms", isDistraction, &compAlerts{Kind: "camera", Alarm: "phone_use"}),
		driverDayRow(in, "5.1.4a", "No more than 8 hours' work a day", "Engine on or moving, per vehicle", ruleWorkDay, ruleWorkWeek),
		driverDayRow(in, "5.1.4b", "No more than 12 hours' work a day with overtime", "Engine on or moving, per vehicle", ruleTotalDay, ruleTotalWeek),
		overtimeRow(in),
		driverDayRow(in, "5.1.4d", "A 30-minute break after every 4½ hours of driving", "Driving = engine on at ≥ 1 km/h", ruleBreak),
		driverDayRow(in, "5.1.4e", "At least 11 hours' rest in one go", "Longest stop in each 24 h of duty", ruleRestDay),
		weeklyRestRow(in),
		driverDayRow(in, "5.1.4g", "No more than 9 hours' driving a day", "Driving = engine on at ≥ 1 km/h", ruleDriveDay, ruleDriveWeek),
		telematicsRow(in),
		reviewRow(in),
		alarmRow(in, "5.2.2e", "Vehicle", "Seat belts worn",
			"Dashcam no-seatbelt alarms", func(k string) bool { return k == "no_seatbelt" }, &compAlerts{Kind: "camera", Alarm: "no_seatbelt"}),
	}
	if in.LimiterKmh > 0 {
		rows = append(rows, limiterRow(in))
	}
	return rows
}

// isDistraction is 5.1.3's alarms (alarmKind): phone use only. The smoking
// and driver-distracted alarms are left out (operator, 2026-11-23: they are
// false alarms).
func isDistraction(k string) bool { return k == "distraction" }

// alarmKind reads a dashcam alarm as 5.1.3 and 5.2.2e count it: phone use as
// a distraction, no seatbelt on its own; "" for the rest.
func alarmKind(e PEvent) string {
	if e.Source != "device" {
		return ""
	}
	t := strings.ToLower(e.Type)
	switch {
	case strings.Contains(t, "seatbelt"):
		return "no_seatbelt"
	case strings.Contains(t, "phone"):
		return "distraction"
	}
	return ""
}

// dashcamUnits are the units that have sent a dashcam alarm in the kept
// days: only they can raise one. All units when none has.
func dashcamUnits(in compInput) map[int]bool {
	cams := map[int]bool{}
	for _, e := range in.Events {
		if e.Source == "device" {
			cams[e.VehicleID] = true
		}
	}
	if len(cams) == 0 {
		for _, v := range in.Vehicles {
			cams[v.VehicleID] = true
		}
	}
	return cams
}

// alarmRow: % of dashcam units with no such alarm in the period.
func alarmRow(in compInput, ref, cat, req, measure string, match func(string) bool, alerts *compAlerts) compRow {
	t := newTallies()
	n := 0
	for _, e := range foldRepeats(in.Events) {
		if !match(alarmKind(e)) {
			continue
		}
		at := parseTime(e.OccurredAt)
		if !in.within(at) {
			continue
		}
		n++
		t.add(e, at)
	}
	cams := dashcamUnits(in)
	with := 0
	for id := range t.unit {
		if cams[id] {
			with++
		}
	}
	return compRow{
		Ref: ref, Category: cat, Requirement: req, Measure: measure, Monitored: true,
		Result:     fmt.Sprintf("%s · %d of %d trucks had an alarm", nWord(n, "incident", "incidents"), with, len(cams)),
		Compliance: pct(len(cams)-with, len(cams)), Breaches: n,
		Passed: len(cams) - with, Total: len(cams), Noun: "trucks",
		ByUnit: t.units(in), ByDay: t.days(in), Alerts: alerts,
	}
}

// notMonitored is an hours row for a period before monitoring began.
func notMonitored(ref, req, measure string) compRow {
	return compRow{Ref: ref, Category: "Operational", Requirement: req, Measure: measure,
		Result: "Not monitored", ByUnit: []compUnit{}, ByDay: []compDay{}, Alerts: &compAlerts{Kind: "hours"}}
}

// hoursMonitored: the period ends after hours monitoring began.
func (in compInput) hoursMonitored() bool {
	since := in.monitoredSince()
	return !since.IsZero() && in.To.After(since)
}

// driverDays are the period's driver-days: vehicle → fleet day.
func (in compInput) driverDays() map[int]map[string]bool {
	out := map[int]map[string]bool{}
	days := in.periodDays()
	for id, d := range in.Duty {
		first := fleetDay(d.Since)
		for _, day := range days {
			if day < first {
				continue
			}
			if dd, ok := d.Days[day]; ok && dd.Work > 0 {
				if out[id] == nil {
					out[id] = map[string]bool{}
				}
				out[id][day] = true
			}
		}
	}
	return out
}

// driverDayRow: % of driver-days with no breach of the rules.
func driverDayRow(in compInput, ref, req, measure string, rules ...string) compRow {
	if !in.hoursMonitored() {
		return notMonitored(ref, req, measure)
	}
	want := map[string]bool{}
	for _, r := range rules {
		want[r] = true
	}
	dd := in.driverDays()
	breached := map[int]map[string]bool{}
	t := newTallies()
	t.duty = in.Duty
	n := 0
	for _, e := range in.Hours {
		at := parseTime(e.OccurredAt)
		if !want[e.Type] || !in.within(at) {
			continue
		}
		n++
		t.add(e, at)
		day := fleetDay(at)
		if breached[e.VehicleID] == nil {
			breached[e.VehicleID] = map[string]bool{}
		}
		breached[e.VehicleID][day] = true
		// A breach is proof the vehicle worked that day.
		if dd[e.VehicleID] == nil {
			dd[e.VehicleID] = map[string]bool{}
		}
		dd[e.VehicleID][day] = true
	}
	total, bad := 0, 0
	for id, days := range dd {
		total += len(days)
		bad += len(breached[id])
	}
	row := compRow{Ref: ref, Category: "Operational", Requirement: req, Measure: measure, Monitored: true,
		Breaches: n, ByUnit: t.units(in), ByDay: t.days(in), Alerts: &compAlerts{Kind: "hours"}}
	if total == 0 {
		row.Result = "No driver-days in the period"
		return row
	}
	row.Compliance = pct(total-bad, total)
	row.Passed, row.Total, row.Noun = total-bad, total, "working days"
	row.Result = fmt.Sprintf("%s · %d of %d working days OK", nWord(n, "breach", "breaches"), total-bad, total)
	return row
}

// unitWeeks are the Mondays of the weeks the period touches.
func (in compInput) weeks() []time.Time {
	var out []time.Time
	for wk := fleetWeek(in.From); wk.Before(in.To); wk = wk.AddDate(0, 0, 7) {
		out = append(out, wk)
	}
	return out
}

// overtimeRow (5.1.4c): % of unit-weeks with fewer than 3 days over 8 h.
func overtimeRow(in compInput) compRow {
	const ref, req, measure = "5.1.4c", "Overtime is not structural", "Days over 8 h worked, per unit per week"
	if !in.hoursMonitored() {
		return notMonitored(ref, req, measure)
	}
	t := newTallies()
	inPeriod := map[string]bool{}
	for _, d := range in.periodDays() {
		inPeriod[d] = true
	}
	total, ok := 0, 0
	failing := map[int]bool{}
	for id, d := range in.Duty {
		first := fleetDay(d.Since)
		for _, wk := range in.weeks() {
			worked, over := 0, 0
			var overDays []string
			hours := map[string]float64{}
			for i := 0; i < 7; i++ {
				day := fleetDay(wk.AddDate(0, 0, i).Add(time.Hour))
				if !inPeriod[day] || day < first {
					continue
				}
				if dd, has := d.Days[day]; has && dd.Work > 0 {
					worked++
					if dd.Work > workDayLimit.Seconds() {
						over++
						overDays = append(overDays, day)
						hours[day] = dd.Work
					}
				}
			}
			if worked == 0 {
				continue
			}
			total++
			if over < 3 {
				ok++
				continue
			}
			failing[id] = true
			for _, day := range overDays {
				at, _ := time.ParseInLocation("2006-01-02", day, fleetZone)
				t.add(PEvent{VehicleID: id, TypeLabel: fmt.Sprintf("Worked %s. Over 8 h on %d days that week.", short(hours[day]), over)}, at.Add(time.Hour))
			}
		}
	}
	row := compRow{Ref: ref, Category: "Operational", Requirement: req, Measure: measure, Monitored: true,
		Breaches: len(failing), UnitWord: "days", ByUnit: t.units(in), ByDay: t.days(in), Alerts: &compAlerts{Kind: "hours"}}
	for i := range row.ByUnit { // a whole day, not a moment: the page shows no time
		for j := range row.ByUnit[i].Items {
			row.ByUnit[i].Items[j].WholeDay = true
		}
	}
	if total == 0 {
		row.Result = "No driver-days in the period"
		return row
	}
	row.Compliance = pct(ok, total)
	row.Passed, row.Total, row.Noun = ok, total, "truck-weeks"
	row.Result = fmt.Sprintf("%s over 8 h on 3+ days · %d of %d truck-weeks OK", nWord(len(failing), "truck", "trucks"), ok, total)
	return row
}

// weeklyRestRow (5.1.4f): % of unit-weeks with no weekly-rest breach. A
// unit-week counts when the vehicle worked in it and its monitoring had
// begun by the Monday, as hours.go judges weekly rest.
func weeklyRestRow(in compInput) compRow {
	const ref, req, measure = "5.1.4f", "At least one full day (24 hours) of rest every week", "Longest stop Mon–Sun"
	if !in.hoursMonitored() {
		return notMonitored(ref, req, measure)
	}
	t := newTallies()
	t.duty = in.Duty
	breached := map[int]map[string]bool{}
	n := 0
	for _, e := range in.Hours {
		at := parseTime(e.OccurredAt)
		if e.Type != ruleRestWeek || !in.within(at) {
			continue
		}
		n++
		t.add(e, at)
		if breached[e.VehicleID] == nil {
			breached[e.VehicleID] = map[string]bool{}
		}
		breached[e.VehicleID][fleetDay(fleetWeek(at).Add(time.Hour))] = true
	}
	total, bad := 0, 0
	for id, d := range in.Duty {
		for _, wk := range in.weeks() {
			if d.Since.After(wk) {
				continue
			}
			worked := false
			for i := 0; i < 7 && !worked; i++ {
				if dd, has := d.Days[fleetDay(wk.AddDate(0, 0, i).Add(time.Hour))]; has && dd.Work > 0 {
					worked = true
				}
			}
			key := fleetDay(wk.Add(time.Hour))
			if !worked && !breached[id][key] {
				continue
			}
			total++
			if breached[id][key] {
				bad++
			}
		}
	}
	row := compRow{Ref: ref, Category: "Operational", Requirement: req, Measure: measure, Monitored: true,
		Breaches: n, ByUnit: t.units(in), ByDay: t.days(in), Alerts: &compAlerts{Kind: "hours"}}
	if total == 0 {
		row.Result = "No week monitored from its start"
		return row
	}
	row.Compliance = pct(total-bad, total)
	row.Passed, row.Total, row.Noun = total-bad, total, "truck-weeks"
	if bad == 0 {
		row.Result = fmt.Sprintf("0 breaches · all %s OK", nWord(total, "truck-week", "truck-weeks"))
	} else {
		row.Result = fmt.Sprintf("%s · %d of %d truck-weeks OK", nWord(n, "breach", "breaches"), total-bad, total)
	}
	return row
}

// telematicsRow (5.1.5): % of units that sent positions in the period.
func telematicsRow(in compInput) compRow {
	reporting := map[int]bool{}
	for _, d := range in.periodDays() {
		for id := range in.Reporting[d] {
			reporting[id] = true
		}
	}
	cams := map[int]bool{}
	for _, e := range in.Events {
		if e.Source == "device" {
			cams[e.VehicleID] = true
		}
	}
	t := newTallies()
	quiet := 0
	for _, v := range in.Vehicles {
		if !reporting[v.VehicleID] {
			quiet++
			t.unit[v.VehicleID] = 0
		}
	}
	units := len(in.Vehicles)
	if units == 0 { // the vehicle list is read after a start: nothing to judge yet
		return compRow{Ref: "5.1.5", Category: "Operational", Requirement: "Every truck's tracker is working",
			Measure: "Units sending positions · units with dashcam", Monitored: true,
			Result: "The units have not been read yet", ByUnit: []compUnit{}, ByDay: []compDay{}}
	}
	withCam := 0
	for _, v := range in.Vehicles {
		if cams[v.VehicleID] {
			withCam++
		}
	}
	return compRow{
		Ref: "5.1.5", Category: "Operational", Requirement: "Every truck's tracker is working",
		Measure: "Units sending positions · units with dashcam", Monitored: true,
		Result:     fmt.Sprintf("%d of %d reporting · %d of %d with dashcam", units-quiet, units, withCam, units),
		Compliance: pct(units-quiet, units), Breaches: quiet, UnitWord: "not reporting",
		Passed: units - quiet, Total: units, Noun: "trucks",
		ByUnit: t.units(in), ByDay: t.days(in),
	}
}

// reviewRow (5.1.6): % of critical alarms reviewed within 6 h. Only the
// review is known (the Alerts page's decisions), not reports to the client
// or investigations, and the row says so. An alarm still inside its 6 h and
// not yet reviewed is neither on time nor late: it is left out.
func reviewRow(in compInput) compRow {
	t := newTallies()
	ontime, late, waiting := 0, 0, 0
	for _, e := range in.Events {
		at := parseTime(e.OccurredAt)
		if e.Severity != "critical" || !in.within(at) {
			continue
		}
		var first time.Time
		if in.Decisions != nil {
			for _, d := range in.Decisions(e.EventID) {
				if dt := parseTime(d.At); !dt.IsZero() && (first.IsZero() || dt.Before(first)) {
					first = dt
				}
			}
		}
		switch {
		case !first.IsZero() && first.Sub(at) <= reviewWithin:
			ontime++
		case first.IsZero() && in.Now.Sub(at) <= reviewWithin:
			waiting++
		default:
			late++
			t.add(e, at)
		}
	}
	row := compRow{Ref: "5.1.6", Category: "Operational", Requirement: "Critical alarms checked within 6 hours",
		Measure: "Critical alarms reviewed within 6 h", Monitored: true, Breaches: late,
		ByUnit: t.units(in), ByDay: t.days(in), Alerts: &compAlerts{Kind: "camera"}}
	if ontime+late == 0 {
		row.Result = "No critical alarms due a review"
	} else {
		row.Compliance = pct(ontime, ontime+late)
		row.Passed, row.Total, row.Noun = ontime, ontime+late, "critical alarms"
		row.Result = fmt.Sprintf("%d of %d reviewed within 6 h", ontime, ontime+late)
	}
	if waiting > 0 {
		row.Result += fmt.Sprintf(" · %d still inside 6 h", waiting)
	}
	return row
}

// limiterRow (5.2.2h): % of units never above the limiter setting. The
// highest speed is read from what the system holds: the speed on every
// alarm and the current position, not a full trace.
func limiterRow(in compInput) compRow {
	top := map[int]float64{}
	seen := func(id int, kmh float64) {
		if cur, ok := top[id]; !ok || kmh > cur {
			top[id] = kmh
		}
	}
	for _, e := range in.Events {
		if e.Speed != nil && in.within(parseTime(e.OccurredAt)) {
			seen(e.VehicleID, *e.Speed)
		}
	}
	for _, v := range in.Vehicles {
		if p := v.Position; p != nil && in.within(parseTime(p.LastUpdate)) {
			seen(v.VehicleID, p.Speed)
		}
	}
	t := newTallies()
	over := 0
	highest := 0.0
	for id, kmh := range top {
		highest = math.Max(highest, kmh)
		if kmh > in.LimiterKmh {
			over++
			t.unit[id] = int(math.Round(kmh))
		}
	}
	lim := strconv.FormatFloat(in.LimiterKmh, 'f', -1, 64)
	row := compRow{Ref: "5.2.2h", Category: "Vehicle", Requirement: "No truck goes over " + lim + " km/h",
		Measure:   "Highest speed recorded vs " + lim + " km/h limit (alarms and positions)",
		Monitored: true, Breaches: over, UnitWord: "km/h", ByUnit: t.units(in), ByDay: []compDay{},
		Alerts: &compAlerts{Kind: "speeding"}}
	if len(top) == 0 {
		row.Result = "No speed recorded in the period"
		return row
	}
	row.Compliance = pct(len(top)-over, len(top))
	row.Passed, row.Total, row.Noun = len(top)-over, len(top), "trucks"
	if over == 0 {
		row.Result = fmt.Sprintf("No unit above %s km/h · top %.0f km/h", lim, highest)
	} else {
		row.Result = fmt.Sprintf("%s above %s km/h · top %.0f km/h", nWord(over, "unit", "units"), lim, highest)
	}
	return row
}

// ── the route ───────────────────────────────────────────────────────────

// complianceInput reads the store for a period and the four weeks before
// its end (the side panel's "last 4 weeks").
func (s *Server) complianceInput(from, to, now time.Time) compInput {
	in := compInput{From: from, To: to, Now: now, Vehicles: s.store.Vehicles(), Events: s.store.Events(),
		Hours: s.store.HoursEvents(), Duty: s.store.DutyDays(), Decisions: s.store.Decisions, LimiterKmh: speedLimiterKmh}
	start := from
	if w := lastWeeks(to, now)[0]; w.Before(start) {
		start = w
	}
	var days []string
	for t := dayStartOf(start); t.Before(to); t = t.AddDate(0, 0, 1) {
		days = append(days, fleetDay(t))
	}
	in.Reporting = map[string]map[int]bool{}
	for day, m := range s.store.Days(days) {
		in.Reporting[day] = map[int]bool{}
		for id := range m {
			in.Reporting[day][id] = true
		}
	}
	return in
}

// lastWeeks are the Mondays of the four weeks up to the one holding the
// period's end, oldest first.
func lastWeeks(to, now time.Time) []time.Time {
	end := to
	if end.After(now) {
		end = now
	}
	last := fleetWeek(end.Add(-time.Second))
	return []time.Time{last.AddDate(0, 0, -21), last.AddDate(0, 0, -14), last.AddDate(0, 0, -7), last}
}

func weekLabel(wk, end time.Time) string {
	last := end.Add(-time.Second).In(fleetZone)
	a := wk.In(fleetZone)
	if a.Month() == last.Month() {
		return fmt.Sprintf("%d – %d %s", a.Day(), last.Day(), last.Format("Jan"))
	}
	return fmt.Sprintf("%d %s – %d %s", a.Day(), a.Format("Jan"), last.Day(), last.Format("Jan"))
}

// complianceRows is the period's rows, each with its last four weeks.
func complianceRows(in compInput) []compRow {
	rows := buildCompliance(in)
	byRef := map[string]int{}
	for i := range rows {
		byRef[rows[i].Ref] = i
	}
	for _, wk := range lastWeeks(in.To, in.Now) {
		end := wk.AddDate(0, 0, 7)
		if end.After(in.Now) {
			end = in.Now
		}
		w := in
		w.From, w.To = wk, end
		for _, r := range buildCompliance(w) {
			if i, ok := byRef[r.Ref]; ok {
				rows[i].Weeks = append(rows[i].Weeks, compWeek{From: fleetDay(wk.Add(time.Hour)), Label: weekLabel(wk, end), Compliance: r.Compliance})
			}
		}
	}
	return rows
}

// compVehicleList is every unit, for the page's unit picker (operator,
// 2026-11-23: all units, not only those with breaches), plate order.
func compVehicleList(vs []PVehicle) []map[string]string {
	out := make([]map[string]string, 0, len(vs))
	for _, v := range vs {
		plate := v.Registration
		if plate == "" {
			plate = vehicleKey(v.VehicleID)
		}
		out = append(out, map[string]string{"vehicleId": vehicleKey(v.VehicleID), "plate": plate})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["plate"] < out[j]["plate"] })
	return out
}

// GET /compliance?org=&from=&to= (epoch ms): the period's rows.
func (s *Server) compliance(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	now := time.Now()
	from, to, problem := reportPeriod(r, now)
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	in := s.complianceInput(from, to, now)
	since := in.monitoredSince()
	var sinceText any
	if !since.IsZero() {
		sinceText = since.UTC().Format(time.RFC3339)
	}
	writeData(w, map[string]any{
		"from":           from.UTC().Format(time.RFC3339),
		"to":             to.UTC().Format(time.RFC3339),
		"units":          len(in.Vehicles),
		"monitoredSince": sinceText,
		"vehicles":       compVehicleList(in.Vehicles),
		"rows":           complianceRows(in),
	})
}

// ── the summary and the PDF ─────────────────────────────────────────────

// compSummary is the page's cards: the average of the rows that could be
// measured, how many are fully met and how many have breaches, and the
// average per category.
type compSummary struct {
	Overall    *int
	Met, With  int
	Measured   int
	Categories map[string]*int
}

func summarise(rows []compRow) compSummary {
	s := compSummary{Categories: map[string]*int{}}
	sum, n := 0, 0
	cat := map[string][2]int{}
	for _, r := range rows {
		if r.Compliance == nil {
			continue
		}
		c := *r.Compliance
		sum += c
		n++
		if c == 100 {
			s.Met++
		} else {
			s.With++
		}
		v := cat[r.Category]
		cat[r.Category] = [2]int{v[0] + c, v[1] + 1}
	}
	s.Measured = n
	if n > 0 {
		o := int(math.Round(float64(sum) / float64(n)))
		s.Overall = &o
	}
	for k, v := range cat {
		a := int(math.Round(float64(v[0]) / float64(v[1])))
		s.Categories[k] = &a
	}
	return s
}

func pctWords(p *int) string {
	switch {
	case p == nil:
		return "—"
	case *p == 100:
		return "Met (100%)"
	}
	return strconv.Itoa(*p) + "%"
}

// mostBreaches is the table's last column: the units with the most, two.
func mostBreaches(r compRow) string {
	var parts []string
	for i, u := range r.ByUnit {
		if i == 2 {
			break
		}
		switch {
		case r.UnitWord == "not reporting":
			parts = append(parts, u.Plate+" not reporting")
		case r.UnitWord != "":
			parts = append(parts, fmt.Sprintf("%s %d %s", u.Plate, u.N, r.UnitWord))
		default:
			parts = append(parts, fmt.Sprintf("%s %d", u.Plate, u.N))
		}
	}
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, " · ")
}

// complianceDoc is the page's table on the reports' letterhead.
func complianceDoc(in compInput, rows []compRow) *ReportDoc {
	d := &rptData{From: in.From, To: in.To, Now: in.Now}
	sum := summarise(rows)
	doc := newDoc("compliance", "Road Safety Compliance", "RSC", d,
		[]InfoPair{{Label: "Requirements", Value: fmt.Sprintf("%d measured by the system", len(rows))}})
	doc.Orientation = "landscape"
	kpis := []KPI{
		{Label: "Overall compliance", Value: pctWords(sum.Overall)},
		{Label: "Fully met", Value: strconv.Itoa(sum.Met)},
		{Label: "With breaches", Value: strconv.Itoa(sum.With)},
		{Label: "Units monitored", Value: strconv.Itoa(len(in.Vehicles))},
	}
	for _, c := range []string{"Operational", "Vehicle"} {
		kpis = append(kpis, KPI{Label: c, Value: pctWords(sum.Categories[c])})
	}
	doc.Blocks = []Block{{Type: "heading", Text: "1. Overview", Small: periodWords(in.From, in.To)}, {Type: "kpis", KPIs: kpis}}
	// No reference column, as on the page (operator, 2026-11-23).
	cols := []Col{{H: "Requirement", W: 44},
		{H: "Result", W: 40}, {H: "Compliance", W: 14, Right: true}, {H: "Most breaches", W: 32}}
	n := 2
	for _, c := range []string{"Operational", "Vehicle"} {
		var cells [][]Cell
		for _, r := range rows {
			if r.Category != c {
				continue
			}
			comp := pctWords(r.Compliance)
			if !r.Monitored {
				comp = "Not monitored"
			}
			cells = append(cells, []Cell{{Text: r.Requirement, Bold: true, Wrap: true},
				{Text: r.Result, Wrap: true}, {Text: comp, Bold: true}, {Text: mostBreaches(r), Wrap: true}})
		}
		if len(cells) == 0 {
			continue
		}
		doc.Blocks = append(doc.Blocks,
			Block{Type: "heading", Text: fmt.Sprintf("%d. %s", n, c), Small: nWord(len(cells), "requirement", "requirements") + " · " + pctWords(sum.Categories[c])},
			Block{Type: "table", Cols: cols, Rows: cells})
		n++
	}
	doc.Blocks = append(doc.Blocks, Block{Type: "spacer"},
		Block{Type: "note", Text: foldNote})
	doc.Summary = map[string]any{"overall": sum.Overall, "met": sum.Met, "breaches": sum.With, "period": periodWords(in.From, in.To)}
	return doc
}

// GET /compliance/document?org=&from=&to=: the period on the letterhead.
func (s *Server) complianceDocument(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	now := time.Now()
	from, to, problem := reportPeriod(r, now)
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	in := s.complianceInput(from, to, now)
	writeData(w, complianceDoc(in, buildCompliance(in)))
}
