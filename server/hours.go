package main

// Driver hours (operator, 2026-11-07): the six rules of the client's working
// time sheet, checked live from the 30-second position reads, each breach
// sent once to the notification bell.
//
//	1 working hours   ≤ 8 h a day and 48 h a week (without overtime)
//	2 overtime        ≤ 12 h a day and 60 h a week, overtime included
//	3 breaks          a 30 min break after every 4.5 h of driving
//	4 daily rest      ≥ 11 h in one piece within each 24 h of duty
//	5 weekly rest     ≥ 24 h in one piece each week
//	6 driving time    ≤ 9 h a day and 48 h a week
//
// Working is the engine on or the vehicle moving; driving is the engine on at
// 1 km/h or more (the operator's words). Rest is any time not working,
// including the gaps where a parked tracker sends nothing. Hours are kept per
// vehicle, and each breach names the driver the vehicle had at the time: the
// partner reports vehicles, not driver cards.
//
// Days are fleet days (Nairobi midnight) and weeks run Monday to Sunday, as in
// the weekly report. Monitoring starts with the first live read: nothing is
// filled from history, so a week that began before the server did is not
// judged on its weekly rest.
//
// Breaches are kept apart from the partner's events (persisted.Hours.Events),
// so the reports, driver scores and Alerts page never count them.

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	// A slice between two fixes longer than this is not counted as the state
	// it started in: the tracker went quiet, which a parked vehicle does.
	hoursGapCap = 5 * time.Minute

	workDayLimit    = 8 * time.Hour
	workWeekLimit   = 48 * time.Hour
	totalDayLimit   = 12 * time.Hour
	totalWeekLimit  = 60 * time.Hour
	driveDayLimit   = 9 * time.Hour
	driveWeekLimit  = 48 * time.Hour
	driveBeforeRest = 4*time.Hour + 30*time.Minute
	breakNeeded     = 30 * time.Minute
	dailyRestNeeded = 11 * time.Hour
	weekRestNeeded  = 24 * time.Hour

	hoursKeepDays = 21
)

// The rules, as the feed names them (alertType HOURS_*).
const (
	ruleWorkDay   = "working_hours_day"
	ruleWorkWeek  = "working_hours_week"
	ruleTotalDay  = "overtime_day"
	ruleTotalWeek = "overtime_week"
	ruleBreak     = "no_break"
	ruleRestDay   = "daily_rest"
	ruleRestWeek  = "weekly_rest"
	ruleDriveDay  = "driving_time_day"
	ruleDriveWeek = "driving_time_week"
)

// dutyDay is one vehicle's working and driving seconds in a fleet day.
type dutyDay struct {
	Work  float64 `json:"work"`
	Drive float64 `json:"drive"`
}

// dutyState is one vehicle's running tally.
type dutyState struct {
	Since   time.Time `json:"since"`  // first live read
	LastAt  time.Time `json:"lastAt"` // last fix counted
	Working bool      `json:"working"`
	Driving bool      `json:"driving"`

	RestSince  time.Time `json:"restSince"`  // when the current rest began (zero while working)
	PauseSince time.Time `json:"pauseSince"` // when driving last stopped (zero while driving)
	// Driving since the last 30 min break, and when that stretch began.
	SinceBreak   float64   `json:"sinceBreak"`
	StretchStart time.Time `json:"stretchStart"`

	// The 24 h duty window (rule 4): when it opened and its longest rest.
	WindowStart time.Time `json:"windowStart"`
	WindowRest  float64   `json:"windowRest"`

	Days     map[string]*dutyDay `json:"days"`
	WeekRest map[string]float64  `json:"weekRest"` // longest rest per week (its Monday)
}

type hoursState struct {
	Vehicles map[int]*dutyState `json:"vehicles"`
	Events   []PEvent           `json:"events"`
}

// fleetWeek is the Monday 00:00 (Nairobi) of the week holding t.
func fleetWeek(t time.Time) time.Time {
	d := fleetMidnight(t, 0)
	return d.AddDate(0, 0, -((int(d.Weekday()) + 6) % 7))
}

func overlapSec(a0, a1, b0, b1 time.Time) float64 {
	if a0.Before(b0) {
		a0 = b0
	}
	if a1.After(b1) {
		a1 = b1
	}
	if !a1.After(a0) {
		return 0
	}
	return a1.Sub(a0).Seconds()
}

// hm is "8 h 05 min".
func hm(sec float64) string {
	m := int(sec / 60)
	return fmt.Sprintf("%d h %02d min", m/60, m%60)
}

// working and driving, as the operator defined them.
func dutyOf(p *PPosition) (working, driving bool) {
	on := p.Engine == "on"
	moving := p.Speed >= 1 || p.MotionStatus == "moving"
	return on || moving, on && p.Speed >= 1
}

// hoursFix takes one vehicle's newer fix and returns the breaches it brings.
// Called with s.mu held.
func (s *Store) hoursFix(v PVehicle, at time.Time) []PEvent {
	if s.p.Hours == nil {
		s.p.Hours = &hoursState{}
	}
	h := s.p.Hours
	if h.Vehicles == nil {
		h.Vehicles = map[int]*dutyState{}
	}
	st := h.Vehicles[v.VehicleID]
	working, driving := dutyOf(v.Position)
	if st == nil {
		st = &dutyState{Since: at, LastAt: at, Days: map[string]*dutyDay{}, WeekRest: map[string]float64{}}
		h.Vehicles[v.VehicleID] = st
		if working {
			st.WindowStart = at
		} else {
			st.RestSince = at
		}
		if driving {
			st.StretchStart = at
		} else {
			st.PauseSince = at
		}
		st.Working, st.Driving = working, driving
		return nil
	}
	if !at.After(st.LastAt) {
		return nil
	}

	// The slice since the last fix, in the state it began in.
	dt := at.Sub(st.LastAt)
	counted := dt
	if counted > hoursGapCap {
		counted = hoursGapCap
	}
	day := st.Days[fleetDay(st.LastAt)]
	if day == nil {
		day = &dutyDay{}
		st.Days[fleetDay(st.LastAt)] = day
	}
	if st.Working {
		day.Work += counted.Seconds()
	}
	if st.Driving {
		day.Drive += counted.Seconds()
		st.SinceBreak += counted.Seconds()
	}
	// A quiet tracker: what was running stopped when the count did.
	stopped := st.LastAt.Add(counted)
	if dt > hoursGapCap {
		if st.Working {
			st.Working, st.RestSince = false, stopped
		}
		if st.Driving {
			st.Driving, st.PauseSince = false, stopped
		}
	}

	// Rest ends: measure it against the duty window and the weeks it touched.
	if working && !st.Working && !st.RestSince.IsZero() {
		st.endRest(at)
	}
	if working && st.WindowStart.IsZero() {
		st.WindowStart, st.WindowRest = at, 0
	}
	if !working && st.Working {
		st.RestSince = at
	}
	// Driving resumes: a pause of 30 min or more was the break.
	if driving && !st.Driving {
		if !st.PauseSince.IsZero() && at.Sub(st.PauseSince) >= breakNeeded {
			st.SinceBreak, st.StretchStart = 0, at
		}
		if st.StretchStart.IsZero() {
			st.StretchStart = at
		}
		st.PauseSince = time.Time{}
	}
	if !driving && st.Driving {
		st.PauseSince = at
	}
	st.Working, st.Driving, st.LastAt = working, driving, at
	if working {
		st.RestSince = time.Time{}
	}

	out := s.hoursCheck(v, st, at)
	st.prune(at)
	s.dirty = true
	return out
}

// endRest closes the rest that began at RestSince.
func (st *dutyState) endRest(at time.Time) {
	from := st.RestSince
	if !st.WindowStart.IsZero() {
		end := st.WindowStart.Add(24 * time.Hour)
		if r := overlapSec(from, at, st.WindowStart, end); r > st.WindowRest {
			st.WindowRest = r
		}
	}
	for wk := fleetWeek(from); wk.Before(at); wk = wk.AddDate(0, 0, 7) {
		key := wk.Format("2006-01-02")
		if r := overlapSec(from, at, wk, wk.AddDate(0, 0, 7)); r > st.WeekRest[key] {
			st.WeekRest[key] = r
		}
	}
	// A full daily rest closes the duty window; the next one opens with work.
	if at.Sub(from) >= dailyRestNeeded {
		st.WindowStart, st.WindowRest = time.Time{}, 0
	}
}

func (st *dutyState) weekTotals(wk time.Time) (work, drive float64) {
	for d := 0; d < 7; d++ {
		if dd := st.Days[fleetDay(wk.AddDate(0, 0, d).Add(time.Hour))]; dd != nil {
			work += dd.Work
			drive += dd.Drive
		}
	}
	return work, drive
}

func (st *dutyState) prune(at time.Time) {
	floor := fleetDay(at.AddDate(0, 0, -hoursKeepDays))
	for d := range st.Days {
		if d < floor {
			delete(st.Days, d)
		}
	}
	for w := range st.WeekRest {
		if w < floor {
			delete(st.WeekRest, w)
		}
	}
}

// hoursCheck tests the six rules after a fix. Each breach has an id made of
// the rule, the vehicle and its period, so it is sent once.
func (s *Store) hoursCheck(v PVehicle, st *dutyState, at time.Time) []PEvent {
	var out []PEvent
	driver := driverName(v)
	add := func(rule, period, label, text string) {
		id := fmt.Sprintf("hours:%s:%d:%s", rule, v.VehicleID, period)
		if s.byHours(id) {
			return
		}
		e := PEvent{
			EventID: id, Source: "hours", Type: rule, TypeLabel: label + ": " + text,
			Severity: "warning", OccurredAt: at.UTC().Format(time.RFC3339),
			ReceivedAt: time.Now().UTC().Format(time.RFC3339), VehicleID: v.VehicleID, Registration: v.Registration,
			Driver: driver,
		}
		s.p.Hours.Events = append(s.p.Hours.Events, e)
		out = append(out, e)
	}
	today := fleetDay(at)
	d := st.Days[today]
	if d == nil {
		d = &dutyDay{}
	}
	wk := fleetWeek(at)
	wkKey := wk.Format("2006-01-02")
	work, drive := st.weekTotals(wk)

	// 1 and 2: working hours, then with overtime.
	if d.Work > workDayLimit.Seconds() {
		add(ruleWorkDay, today, "Working hours", fmt.Sprintf("%s today, over the 8 h day", hm(d.Work)))
	}
	if work > workWeekLimit.Seconds() {
		add(ruleWorkWeek, wkKey, "Working hours", fmt.Sprintf("%s this week, over the 48 h week", hm(work)))
	}
	if d.Work > totalDayLimit.Seconds() {
		add(ruleTotalDay, today, "Overtime", fmt.Sprintf("%s worked today, over 12 h with overtime", hm(d.Work)))
	}
	if work > totalWeekLimit.Seconds() {
		add(ruleTotalWeek, wkKey, "Overtime", fmt.Sprintf("%s worked this week, over 60 h with overtime", hm(work)))
	}

	// 3: 4.5 h of driving with no 30 min break.
	if st.SinceBreak > driveBeforeRest.Seconds() && !st.StretchStart.IsZero() {
		add(ruleBreak, st.StretchStart.UTC().Format("20060102T150405"), "No break",
			fmt.Sprintf("%s driving without a 30 min break", hm(st.SinceBreak)))
	}

	// 4: the 24 h duty window closed without 11 h of rest in one piece.
	if !st.WindowStart.IsZero() && !at.Before(st.WindowStart.Add(24*time.Hour)) {
		end := st.WindowStart.Add(24 * time.Hour)
		longest := st.WindowRest
		if !st.Working && !st.RestSince.IsZero() {
			if r := overlapSec(st.RestSince, at, st.WindowStart, end); r > longest {
				longest = r
			}
		}
		if longest < dailyRestNeeded.Seconds() {
			add(ruleRestDay, st.WindowStart.UTC().Format("20060102T150405"), "Daily rest",
				fmt.Sprintf("longest rest %s in 24 h, under 11 h", hm(longest)))
		}
		// The next window opens now if working, else with the next work.
		st.WindowStart, st.WindowRest = time.Time{}, 0
		if st.Working {
			st.WindowStart = at
		}
	}

	// 5: the week can no longer hold 24 h of rest in one piece. Only judged
	// on a week monitored from its start, and one the vehicle worked in.
	if !st.Since.After(wk) && work > 0 {
		longest := st.WeekRest[wkKey]
		start := at
		if !st.Working && !st.RestSince.IsZero() {
			start = st.RestSince
			if start.Before(wk) {
				start = wk
			}
			if r := at.Sub(start).Seconds(); r > longest {
				longest = r
			}
		}
		if longest < weekRestNeeded.Seconds() && wk.AddDate(0, 0, 7).Sub(start) < weekRestNeeded {
			add(ruleRestWeek, wkKey, "Weekly rest",
				fmt.Sprintf("no 24 h rest this week, longest %s", hm(longest)))
		}
	}

	// 6: driving time.
	if d.Drive > driveDayLimit.Seconds() {
		add(ruleDriveDay, today, "Driving time", fmt.Sprintf("%s today, over the 9 h day", hm(d.Drive)))
	}
	if drive > driveWeekLimit.Seconds() {
		add(ruleDriveWeek, wkKey, "Driving time", fmt.Sprintf("%s this week, over the 48 h week", hm(drive)))
	}
	return out
}

func (s *Store) byHours(id string) bool {
	for i := len(s.p.Hours.Events) - 1; i >= 0; i-- {
		if s.p.Hours.Events[i].EventID == id {
			return true
		}
	}
	return false
}

// TakeHours returns the breaches found since the last call.
func (s *Store) TakeHours() []PEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.hoursNew
	s.hoursNew = nil
	return out
}

// HoursEvents returns the stored breaches, oldest first.
func (s *Store) HoursEvents() []PEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.p.Hours == nil {
		return nil
	}
	out := append([]PEvent(nil), s.p.Hours.Events...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].OccurredAt < out[j].OccurredAt })
	return out
}

// pruneHours drops breaches older than the events' keep window, with their
// decisions and read marks (they are listed on the Alerts page).
func (s *Store) pruneHours(floor time.Time) {
	if s.p.Hours == nil {
		return
	}
	kept := s.p.Hours.Events[:0]
	for _, e := range s.p.Hours.Events {
		if t := parseTime(e.OccurredAt); !t.IsZero() && t.Before(floor) {
			delete(s.p.Decisions, e.EventID)
			for _, r := range s.p.Reads {
				delete(r, e.EventID)
			}
			continue
		}
		kept = append(kept, e)
	}
	s.p.Hours.Events = kept
}

// hoursFeedItem is a breach as the bell's feed draws it: a warning, its words
// as written (not upper-cased like the partner's types).
func hoursFeedItem(e PEvent) map[string]any {
	text := e.TypeLabel
	if e.Driver != "" {
		text += ", " + e.Driver
	}
	return map[string]any{
		"id":        e.EventID,
		"orgId":     OrgID,
		"ts":        e.OccurredAt,
		"type":      "warning",
		"alertType": "HOURS_" + strings.ToUpper(e.Type),
		"severity":  "warning",
		"text":      text,
		"plate":     e.Registration,
		"vehicleId": vehicleKey(e.VehicleID),
		"source":    "hours",
	}
}
