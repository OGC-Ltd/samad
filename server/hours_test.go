package main

import (
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
	item := hoursFeedItem(PEvent{EventID: "hours:no_break:7:x", Type: ruleBreak, TypeLabel: "No break: 4 h 31 min driving without a 30 min break",
		OccurredAt: "2026-11-02T10:00:00Z", VehicleID: 7, Registration: "KDA 001A", Driver: "Jane Driver"})
	if item["alertType"] != "HOURS_NO_BREAK" || item["type"] != "warning" || item["source"] != "hours" || item["plate"] != "KDA 001A" {
		t.Fatalf("feed item: %v", item)
	}
	if item["text"] != "No break: 4 h 31 min driving without a 30 min break, Jane Driver" {
		t.Fatalf("text: %v", item["text"])
	}
}
