package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A Monday 00:00 in Nairobi, so days and weeks start where the test says.
var hoursMonday = time.Date(2026, 11, 2, 0, 0, 0, 0, fleetZone)

type hoursRig struct {
	t  *testing.T
	s  *Store
	at time.Time
	// rule → how many times it fired
	got map[string]int
}

func newHoursRig(t *testing.T, start time.Time) *hoursRig {
	return &hoursRig{t: t, s: NewStore(t.TempDir()), at: start, got: map[string]int{}}
}

// run sends a fix every 30 s for d: engine on/off at a speed.
func (r *hoursRig) run(d time.Duration, engine string, speed float64) {
	end := r.at.Add(d)
	for ; r.at.Before(end); r.at = r.at.Add(30 * time.Second) {
		r.fix(engine, speed)
	}
}

// silent moves the clock with no fixes at all: a parked tracker.
func (r *hoursRig) silent(d time.Duration) { r.at = r.at.Add(d) }

func (r *hoursRig) fix(engine string, speed float64) {
	r.s.ApplyPositions([]PVehicle{{
		VehicleID: 7, Registration: "KDA 001A", Driver: &PPerson{Name: "Jane Driver"},
		Position: &PPosition{Engine: engine, Speed: speed, LastUpdate: r.at.UTC().Format(time.RFC3339)},
	}})
	for _, e := range r.s.TakeHours() {
		r.got[e.Type]++
		if e.Driver != "Jane Driver" || !strings.Contains(hoursFeedItem(e)["text"].(string), "Jane Driver") {
			r.t.Errorf("%s does not name the driver: %q", e.Type, e.Driver)
		}
	}
}

func (r *hoursRig) want(rule string, n int) {
	r.t.Helper()
	if r.got[rule] != n {
		r.t.Errorf("%s fired %d times, want %d (all: %v)", rule, r.got[rule], n, r.got)
	}
}

func TestHoursBreakAfterFourAndAHalfHours(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(4*time.Hour+20*time.Minute, "on", 60)
	r.want(ruleBreak, 0)
	r.run(15*time.Minute, "on", 60)
	r.want(ruleBreak, 1)
	// Still driving: the same stretch, sent once.
	r.run(time.Hour, "on", 60)
	r.want(ruleBreak, 1)
}

func TestHoursBreakTaken(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(4*time.Hour, "on", 60)
	r.run(30*time.Minute, "off", 0) // the break
	r.run(4*time.Hour, "on", 60)
	r.want(ruleBreak, 0)
	// A 20 minute stop is not a break: the count goes on.
	r.run(20*time.Minute, "on", 0)
	r.run(40*time.Minute, "on", 60)
	r.want(ruleBreak, 1)
}

func TestHoursDayLimits(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(5*time.Hour))
	// Breaks every 4 h so only the day limits are at stake.
	for i := 0; i < 3; i++ {
		r.run(4*time.Hour, "on", 50)
		r.run(30*time.Minute, "on", 0) // idling: working, not driving
	}
	// 13.5 h worked, 12 h driven.
	r.want(ruleWorkDay, 1)
	r.want(ruleTotalDay, 1)
	r.want(ruleDriveDay, 1)
	r.want(ruleBreak, 0)
}

func TestHoursUnderTheDayLimits(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(4*time.Hour, "on", 50)
	r.run(time.Hour, "off", 0)
	r.run(3*time.Hour+50*time.Minute, "on", 50)
	r.want(ruleWorkDay, 0)
	r.want(ruleDriveDay, 0)
}

func TestHoursDailyRestTooShort(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(4*time.Hour, "on", 50)
	r.run(time.Hour, "off", 0)
	r.run(3*time.Hour, "on", 50)
	r.silent(8 * time.Hour) // parked, tracker quiet: 8 h of rest
	r.run(9*time.Hour, "on", 0)
	r.want(ruleRestDay, 1)
}

func TestHoursDailyRestTaken(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(4*time.Hour, "on", 50)
	r.run(time.Hour, "off", 0)
	r.run(3*time.Hour, "on", 50)
	r.silent(11*time.Hour + 5*time.Minute)
	r.run(10*time.Hour, "on", 0)
	r.want(ruleRestDay, 0)
}

func TestHoursQuietTrackerIsRest(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(time.Hour, "on", 50)
	r.silent(10 * time.Hour) // the last fix said engine on, then nothing
	r.run(time.Minute, "on", 50)
	day := r.s.p.Hours.Vehicles[7].Days[fleetDay(hoursMonday)]
	if got := time.Duration(day.Work * float64(time.Second)); got > time.Hour+6*time.Minute {
		t.Fatalf("worked %v, want about 1 h 05 min (the quiet 10 h is rest)", got)
	}
}

func TestHoursWeek(t *testing.T) {
	r := newHoursRig(t, hoursMonday)
	r.fix("off", 0) // monitored from the week's start
	// Six days of 10 h work, 4 h driving then a break, each followed by 14 h
	// of rest: the 48 h week and its driving pass at 60 h.
	for d := 0; d < 6; d++ {
		r.silent(6*time.Hour - 30*time.Second)
		r.run(4*time.Hour, "on", 50)
		r.run(time.Hour, "on", 0)
		r.run(4*time.Hour, "on", 50)
		r.run(time.Hour, "on", 0)
		r.fix("off", 0) // parked: exactly 10 h worked
		r.at = hoursMonday.AddDate(0, 0, d+1)
		r.fix("off", 0)
	}
	r.want(ruleWorkWeek, 1)
	r.want(ruleDriveWeek, 0) // 48 h exactly is within it
	r.want(ruleTotalWeek, 0)
	// Sunday from 06:00 on the road: no 24 h rest anywhere in the week.
	r.silent(6 * time.Hour)
	r.run(2*time.Hour, "on", 50)
	r.want(ruleRestWeek, 1)
}

func TestHoursWeeklyRestTaken(t *testing.T) {
	r := newHoursRig(t, hoursMonday)
	r.fix("off", 0)
	r.silent(30 * time.Hour) // Monday and into Tuesday off the road
	for d := 1; d < 7; d++ {
		r.at = hoursMonday.AddDate(0, 0, d).Add(7 * time.Hour)
		r.run(4*time.Hour, "on", 50)
	}
	r.want(ruleRestWeek, 0)
}

func TestHoursFeedItem(t *testing.T) {
	// Stored with the old words: the bell shows today's.
	item := hoursFeedItem(PEvent{EventID: "hours:no_break:7:20261102T055800", Type: ruleBreak, TypeLabel: "No break: 4 h 31 min driving without a 30 min break",
		OccurredAt: "2026-11-02T10:28:00Z", VehicleID: 7, Registration: "KDA 001A", Driver: "Jane Driver"})
	if item["alertType"] != "HOURS_NO_BREAK" || item["type"] != "warning" || item["source"] != "hours" || item["plate"] != "KDA 001A" {
		t.Fatalf("feed item: %v", item)
	}
	want := "No break after 4.5 h driving: Driving since 08:58 with no 30 min stop, Jane Driver"
	if item["text"] != want {
		t.Fatalf("text:\n got %v\nwant %v", item["text"], want)
	}
}

// Every rule's words, as the bell shows them (no running figure), from
// breaches stored with the old words (as on the Alerts page on 2026-11-26)
// and from new ones with their figures.
func TestHoursWords(t *testing.T) {
	ev := func(rule, period, at, label string) PEvent {
		return PEvent{EventID: "hours:" + rule + ":7:" + period, Type: rule, TypeLabel: label, OccurredAt: at}
	}
	with := func(e PEvent, f hoursFacts) PEvent { e.Hours = &f; return e }
	cases := []struct {
		e             PEvent
		title, detail string
	}{
		{ev(ruleBreak, "20261126T055800", "2026-11-26T10:28:00Z", "No break: 4 h 30 min driving without a 30 min break"),
			"No break after 4.5 h driving", "Driving since 08:58 with no 30 min stop"},
		{ev(ruleBreak, "20261125T201000", "2026-11-26T01:00:00Z", ""), // began the evening before
			"No break after 4.5 h driving", "Driving since 25 Nov 23:10 with no 30 min stop"},

		// Daily rest: an old breach (no times kept), then new ones.
		{ev(ruleRestDay, "20261125T074100", "2026-11-26T07:41:00Z", "Daily rest: longest rest 2 h 45 min in 24 h, under 11 h"),
			"Daily rest too short", "Rested only 2 h 45 min in the 24 h from 25 Nov 10:41, short of the 11 h needed"},
		{with(ev(ruleRestDay, "20261125T074100", "2026-11-26T07:41:00Z", ""), hoursFacts{Longest: 9900, RestFrom: "2026-11-26T04:56:00Z", RestTo: "2026-11-26T07:41:00Z"}),
			"Daily rest too short", "Rested only 2 h 45 min (07:56 – 10:41), short of the 11 h needed"},
		{with(ev(ruleRestDay, "20261125T074100", "2026-11-26T07:41:00Z", ""), hoursFacts{Longest: 9900, RestFrom: "2026-11-25T19:10:00Z", RestTo: "2026-11-25T21:55:00Z"}),
			"Daily rest too short", "Rested only 2 h 45 min (25 Nov 22:10 – 26 Nov 00:55), short of the 11 h needed"},
		{with(ev(ruleRestDay, "20261125T074100", "2026-11-26T07:41:00Z", ""), hoursFacts{Longest: 9900, RestFrom: "2026-11-25T11:00:00Z", RestTo: "2026-11-25T13:45:00Z"}),
			"Daily rest too short", "Rested only 2 h 45 min (25 Nov 14:00 – 16:45), short of the 11 h needed"},
		{with(ev(ruleRestDay, "20261125T074100", "2026-11-26T07:41:00Z", ""), hoursFacts{Longest: 2700, RestFrom: "2026-11-26T06:56:00Z", RestTo: "2026-11-26T07:41:00Z"}),
			"Daily rest too short", "Rested only 45 min (09:56 – 10:41), short of the 11 h needed"},
		{with(ev(ruleRestDay, "20261125T074100", "2026-11-26T07:41:00Z", ""), hoursFacts{}),
			"Daily rest too short", "No rest in the 24 h from 25 Nov 10:41"},

		{ev(ruleRestWeek, "2026-11-23", "2026-11-29T09:00:00Z", "Weekly rest: no 24 h rest this week, longest 9 h 10 min"),
			"No 24 h weekly rest", "Rested only 9 h 10 min at most in the week from Mon 23 Nov, short of the 24 h needed"},
		{with(ev(ruleRestWeek, "2026-11-23", "2026-11-29T09:00:00Z", ""), hoursFacts{Longest: 33000}),
			"No 24 h weekly rest", "Rested only 9 h 10 min at most in the week from Mon 23 Nov, short of the 24 h needed"},

		{ev(ruleWorkDay, "2026-11-26", "2026-11-26T12:20:00Z", "Working hours: 8 h 00 min today, over the 8 h day"),
			"Over 8 h work in a day", "Reached 8 h of work at 15:20 on 26 Nov"},
		{ev(ruleWorkWeek, "2026-11-23", "2026-11-26T12:20:00Z", ""),
			"Over 48 h work in a week", "Reached 48 h of work at 15:20 on Thu 26 Nov"},
		{ev(ruleTotalDay, "2026-11-26", "2026-11-26T16:40:00Z", ""),
			"Over 12 h work in a day", "Reached 12 h of work at 19:40 on 26 Nov, overtime included"},
		{ev(ruleTotalWeek, "2026-11-23", "2026-11-28T16:40:00Z", ""),
			"Over 60 h work in a week", "Reached 60 h of work at 19:40 on Sat 28 Nov, overtime included"},
		{ev(ruleDriveDay, "2026-11-26", "2026-11-26T14:05:00Z", ""),
			"Over 9 h driving in a day", "Reached 9 h of driving at 17:05 on 26 Nov"},
		{ev(ruleDriveWeek, "2026-11-23", "2026-11-28T14:05:00Z", ""),
			"Over 48 h driving in a week", "Reached 48 h of driving at 17:05 on Sat 28 Nov"},
		// A rule these words don't know keeps its stored words.
		{ev("something_new", "x", "2026-11-26T10:00:00Z", "Something: as stored"), "Something", "as stored"},
	}
	for _, c := range cases {
		title, detail := hoursText(c.e, nil)
		if title != c.title || detail != c.detail {
			t.Errorf("%s:\n got %q / %q\nwant %q / %q", c.e.Type, title, detail, c.title, c.detail)
		}
	}
}

// The running figure, as the Alerts page adds it.
func TestHoursWordsRunningFigure(t *testing.T) {
	at := time.Date(2026, 11, 26, 15, 20, 0, 0, fleetZone)
	words := func(rule, period string, live *hoursLive) string {
		_, d := hoursWords(rule, period, at, hoursFacts{}, live)
		return d
	}
	h := func(hrs, mins int) float64 { return float64(hrs*3600 + mins*60) }
	cases := []struct{ got, want string }{
		{words(ruleWorkDay, "2026-11-26", &hoursLive{Total: h(9, 40), Ongoing: true}),
			"Reached 8 h of work at 15:20 on 26 Nov · 9 h 40 min so far, 1 h 40 min over"},
		{words(ruleWorkDay, "2026-11-26", &hoursLive{Total: h(10, 15)}),
			"Reached 8 h of work at 15:20 on 26 Nov · 10 h 15 min that day, 2 h 15 min over"},
		{words(ruleDriveDay, "2026-11-26", &hoursLive{Total: h(9, 50), Ongoing: true}),
			"Reached 9 h of driving at 15:20 on 26 Nov · 9 h 50 min so far, 50 min over"},
		{words(ruleTotalDay, "2026-11-26", &hoursLive{Total: h(12, 30), Ongoing: true}),
			"Reached 12 h of work at 15:20 on 26 Nov, overtime included · 12 h 30 min so far, 30 min over"},
		{words(ruleWorkWeek, "2026-11-23", &hoursLive{Total: h(52, 10), Ongoing: true}),
			"Reached 48 h of work at 15:20 on Thu 26 Nov · 52 h 10 min so far this week, 4 h 10 min over"},
		{words(ruleDriveWeek, "2026-11-23", &hoursLive{Total: h(50, 0)}),
			"Reached 48 h of driving at 15:20 on Thu 26 Nov · 50 h 00 min that week, 2 h 00 min over"},
		// Just reached: under a minute over says nothing more.
		{words(ruleWorkDay, "2026-11-26", &hoursLive{Total: h(8, 0) + 30, Ongoing: true}),
			"Reached 8 h of work at 15:20 on 26 Nov"},
		{words(ruleBreak, "20261126T055800", &hoursLive{Total: h(5, 10), Ongoing: true}),
			"Driving since 08:58 with no 30 min stop · 5 h 10 min driven so far"},
		{words(ruleBreak, "20261126T055800", &hoursLive{Total: h(5, 25)}),
			"Driving since 08:58 with no 30 min stop · 5 h 25 min driven before the break"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("\n got %q\nwant %q", c.got, c.want)
		}
	}
}

// A new breach is stored with its figures and today's words, which read back
// the same; the daily rest names when the rest was.
func TestHoursNewBreachWords(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(4*time.Hour, "on", 50)
	r.run(time.Hour, "off", 0)
	r.run(3*time.Hour, "on", 50)
	r.silent(8 * time.Hour) // 7 h 55 min of rest: the quiet's first 5 min count as work
	r.run(9*time.Hour, "on", 0)
	for _, e := range r.s.HoursEvents() {
		if e.Type != ruleRestDay {
			continue
		}
		title, detail := hoursText(e, nil)
		want := "Rested only 7 h 55 min (2 Nov 14:04 – 22:00), short of the 11 h needed"
		if e.TypeLabel != title+": "+detail || detail != want || e.Hours == nil {
			t.Fatalf("stored %q (%+v), reads %q / %q, want %q", e.TypeLabel, e.Hours, title, detail, want)
		}
		return
	}
	t.Fatal("no daily rest breach")
}

// The Alerts page's running figures, read from the vehicle's tally.
func TestHoursLiveFromTally(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(5*time.Hour))
	for i := 0; i < 2; i++ {
		r.run(4*time.Hour, "on", 50)
		r.run(30*time.Minute, "on", 0) // idling: working, not driving
	}
	r.run(time.Hour, "on", 50) // 8 h worked at 13:00 (idling counts); 9 h 59 min worked, 8 h 59 min driven by 14:59:30
	var work, drive PEvent
	for _, e := range r.s.HoursEvents() {
		switch e.Type {
		case ruleWorkDay:
			work = e
		case ruleDriveDay:
			drive = e
		}
	}
	if work.EventID == "" || drive.EventID != "" {
		t.Fatalf("want an 8 h work breach and no 9 h driving one yet: %v / %v", work.EventID, drive.EventID)
	}
	_, d := r.s.HoursText(work, r.at)
	if want := "Reached 8 h of work at 13:00 on 2 Nov · 9 h 59 min so far, 1 h 59 min over"; d != want {
		t.Errorf("same day:\n got %q\nwant %q", d, want)
	}
	_, d = r.s.HoursText(work, r.at.Add(12*time.Hour))
	if want := "Reached 8 h of work at 13:00 on 2 Nov · 9 h 59 min that day, 1 h 59 min over"; d != want {
		t.Errorf("next day:\n got %q\nwant %q", d, want)
	}
	// A vehicle the tally doesn't know: the words without the figure.
	work.VehicleID = 99
	if _, d = r.s.HoursText(work, r.at); d != "Reached 8 h of work at 13:00 on 2 Nov" {
		t.Errorf("unknown vehicle: %q", d)
	}
}

// No break: driven so far while the stretch goes on, the stretch's total once
// a break begins, and still after driving resumes.
func TestHoursLiveBreak(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(5*time.Hour, "on", 60)
	var e PEvent
	find := func() {
		for _, x := range r.s.HoursEvents() {
			if x.Type == ruleBreak {
				e = x
			}
		}
	}
	find()
	if e.EventID == "" {
		t.Fatal("no break breach")
	}
	_, d := r.s.HoursText(e, r.at)
	if want := "Driving since 06:00 with no 30 min stop · 4 h 59 min driven so far"; d != want {
		t.Errorf("driving:\n got %q\nwant %q", d, want)
	}
	r.run(40*time.Minute, "off", 0) // the break
	_, d = r.s.HoursText(e, r.at)
	if want := "Driving since 06:00 with no 30 min stop · 5 h 00 min driven before the break"; d != want {
		t.Errorf("on the break:\n got %q\nwant %q", d, want)
	}
	r.run(time.Hour, "on", 60) // a new stretch: the old one's total is kept on its breach
	find()
	_, d = r.s.HoursText(e, r.at)
	if want := "Driving since 06:00 with no 30 min stop · 5 h 00 min driven before the break"; d != want {
		t.Errorf("after:\n got %q\nwant %q", d, want)
	}
	// The kept total needs no tally (found testing locally: it was dropped).
	e.VehicleID = 99
	if _, d = r.s.HoursText(e, r.at); d != "Driving since 06:00 with no 30 min stop · 5 h 00 min driven before the break" {
		t.Errorf("no tally: %q", d)
	}
}

// State saved before these figures were kept loads and goes on as before.
func TestHoursOldStateLoads(t *testing.T) {
	dir := t.TempDir()
	old := `{"hours":{"vehicles":{"7":{"since":"2026-11-02T03:00:00Z","lastAt":"2026-11-02T08:00:00Z","working":true,"driving":true,` +
		`"restSince":"0001-01-01T00:00:00Z","pauseSince":"0001-01-01T00:00:00Z","sinceBreak":3600,"stretchStart":"2026-11-02T07:00:00Z",` +
		`"windowStart":"2026-11-02T03:00:00Z","windowRest":1800,"days":{"2026-11-02":{"work":18000,"drive":14400}},"weekRest":{}}},` +
		`"events":[{"event_id":"hours:daily_rest:7:20261101T030000","source":"hours","type":"daily_rest",` +
		`"type_label":"Daily rest: longest rest 2 h 45 min in 24 h, under 11 h","occurred_at":"2026-11-02T03:00:00Z","vehicle_id":7}]}}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir)
	evs := s.HoursEvents()
	if len(evs) != 1 {
		t.Fatalf("events: %v", evs)
	}
	if _, d := s.HoursText(evs[0], time.Date(2026, 11, 2, 12, 0, 0, 0, fleetZone)); d != "Rested only 2 h 45 min in the 24 h from 1 Nov 06:00, short of the 11 h needed" {
		t.Errorf("old breach: %q", d)
	}
	st := s.p.Hours.Vehicles[7]
	if st.WindowRest != 1800 || !st.WindowRestFrom.IsZero() || st.SinceBreak != 3600 {
		t.Errorf("tally: %+v", st)
	}
}
