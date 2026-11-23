package main

import (
	"testing"
	"time"
)

// recorded is what a tracker saved: a point every 30 s after from, up to
// (not including) to, at the given ignition and speed.
func recorded(from, to time.Time, ignition bool, speed float64) []PHistoryPoint {
	var out []PHistoryPoint
	for at := from.Add(30 * time.Second); at.Before(to); at = at.Add(30 * time.Second) {
		out = append(out, PHistoryPoint{Timestamp: at.UTC().Format(time.RFC3339), Speed: speed, Ignition: ignition})
	}
	return out
}

func (r *hoursRig) live(engine string, speed float64) []PVehicle {
	return []PVehicle{{VehicleID: 7, Registration: "KDA 001A", Driver: &PPerson{Name: "Jane Driver"},
		Position: &PPosition{Engine: engine, Speed: speed, LastUpdate: r.at.UTC().Format(time.RFC3339)}}}
}

// deadZone: no live reading for d while the tracker recorded (ignition,
// speed). Then the signal returns, as the poller sees it: the silence is
// found and held (fill) or not (as before the fix); the next live readings
// move the map; the worker's history read (up to then) is counted.
func (r *hoursRig) deadZone(d time.Duration, ignition bool, speed float64, fill bool) {
	r.t.Helper()
	last := r.at.Add(-30 * time.Second) // the last live reading counted
	r.at = last.Add(d)
	next := r.live("on", 60)
	if !fill {
		return
	}
	gaps := r.s.HoursGaps(next)
	if len(gaps) != 1 || !gaps[0].From.Equal(last) || !gaps[0].To.Equal(r.at) {
		r.t.Fatalf("the silence: %+v", gaps)
	}
	r.s.HoldHours(7)
	if g := r.s.HoursGaps(next); len(g) != 0 {
		r.t.Errorf("a silence being filled is not handed out again: %+v", g)
	}
	// Two live readings while the history is read: the map moves, the count waits.
	held := r.at
	for i := 0; i < 2; i++ {
		r.s.ApplyPositions(r.live("on", 60))
		if !r.s.hoursLastAt(7).Equal(last) {
			r.t.Fatalf("a held reading was counted")
		}
		if got := r.s.Vehicles(); len(got) != 1 || got[0].Position.LastUpdate != r.at.UTC().Format(time.RFC3339) {
			r.t.Errorf("the map did not move: %+v", got)
		}
		r.at = r.at.Add(30 * time.Second)
	}
	r.at = r.at.Add(-30 * time.Second) // the last live reading
	pts := append(recorded(last, held, ignition, speed), recorded(held.Add(-30*time.Second), r.at.Add(30*time.Second), true, 60)...)
	if n := r.s.FinishHours(7, pts); n != len(pts) {
		r.t.Errorf("counted %d of %d history points", n, len(pts))
	}
	for _, e := range r.s.TakeHours() {
		r.got[e.Type]++
		if at := parseTime(e.OccurredAt); !at.After(last) {
			r.t.Errorf("%s at %s: before the silence", e.Type, e.OccurredAt)
		}
	}
	r.at = r.at.Add(30 * time.Second)
}

// The case found on 2026-11-23: 4 h 45 min of driving with a 45-minute dead
// zone in it. Read live only, the silence was a break and no alert came.
func TestHoursDeadZoneIsNotABreak(t *testing.T) {
	for _, fill := range []bool{false, true} {
		r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
		r.run(2*time.Hour, "on", 60)
		r.deadZone(45*time.Minute, true, 60, fill)
		r.run(2*time.Hour, "on", 60)
		if fill {
			r.want(ruleBreak, 1)
		} else {
			r.want(ruleBreak, 0) // the bug, kept to show what the fill changes
		}
	}
}

// What the tracker saved shows a real stop: still a break.
func TestHoursDeadZoneWithAStop(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(3*time.Hour, "on", 60)
	r.deadZone(40*time.Minute, false, 0, true)
	r.run(3*time.Hour, "on", 60)
	r.want(ruleBreak, 0)
}

// The day's driving counts the dead zone too (the 9 h rule read it short).
func TestHoursDeadZoneCountsTheDriving(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(time.Hour, "on", 60)
	r.deadZone(2*time.Hour, true, 60, true)
	r.run(time.Hour, "on", 60)
	got := r.s.p.Hours.Vehicles[7].Days[fleetDay(r.at)].Drive / 3600
	if got < 3.9 || got > 4.1 {
		t.Errorf("driving that day: %.2f h, want 4", got)
	}
}

// A failed history read: the vehicle counts again, the silence as before.
func TestHoursFillFailed(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(2*time.Hour, "on", 60)
	r.at = r.at.Add(45 * time.Minute)
	r.s.HoldHours(7)
	r.s.ApplyPositions(r.live("on", 60))
	r.s.FinishHours(7, nil)
	if !r.s.hoursLastAt(7).Equal(r.at) {
		t.Errorf("the live reading was not counted after the failed read")
	}
	r.at = r.at.Add(30 * time.Second)
	r.run(2*time.Hour, "on", 60)
	r.want(ruleBreak, 0) // as before the fix
	if r.s.hoursFilling[7] {
		t.Error("still held")
	}
}

// A full queue never blocks the poll: the silence is left as before.
func TestHoursFillQueueFull(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(10*time.Minute, "on", 60)
	r.at = r.at.Add(time.Hour)
	p := &Poller{store: r.s, fills: make(chan hoursGap)} // nobody reading
	p.queueHourFills(r.live("on", 60))
	if r.s.hoursFilling[7] {
		t.Error("held with nowhere to go")
	}
	(&Poller{store: r.s}).queueHourFills(r.live("on", 60)) // no worker: nothing held either
	if r.s.hoursFilling[7] {
		t.Error("held with no worker")
	}
}

func TestHoursGapsOnlyRealSilences(t *testing.T) {
	r := newHoursRig(t, hoursMonday.Add(6*time.Hour))
	r.run(10*time.Minute, "on", 60)
	last := r.at.Add(-30 * time.Second)
	at := func(d time.Duration) []PVehicle {
		return []PVehicle{{VehicleID: 7, Position: &PPosition{LastUpdate: last.Add(d).UTC().Format(time.RFC3339)}}}
	}
	if g := r.s.HoursGaps(at(4 * time.Minute)); len(g) != 0 {
		t.Errorf("4 min is not a silence: %+v", g)
	}
	if g := r.s.HoursGaps(at(6 * time.Minute)); len(g) != 1 {
		t.Errorf("6 min is: %+v", g)
	}
	if g := r.s.HoursGaps(at(40 * time.Hour)); len(g) != 0 {
		t.Errorf("40 h is too long to fill: %+v", g)
	}
	if g := r.s.HoursGaps([]PVehicle{{VehicleID: 99, Position: &PPosition{LastUpdate: last.Add(time.Hour).UTC().Format(time.RFC3339)}}}); len(g) != 0 {
		t.Errorf("a vehicle with no hours yet: %+v", g)
	}
}
