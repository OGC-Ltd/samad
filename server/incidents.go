package main

// Incidents, not alarms (operator, 2026-11-23): the dashcams repeat No
// seatbelt, On phone and Camera covered many times a minute for one and the
// same thing (21 Oct–19 Nov: 8,336 of them; one phone call of 68 minutes
// sent 122). The reports count incidents: the first alarm of a kind from a
// vehicle opens one, and the same alarm from that vehicle in the next
// incidentWindow belongs to it; the first after that opens the next. So a
// long phone call still counts once per 10 minutes, and five alarms in a
// minute count once.
//
// Every report reads its events through foldRepeats, so they all count the
// same. The Alerts page and the pop-ups are untouched: they list every alarm.

import (
	"sort"
	"time"
)

const incidentWindow = 10 * time.Minute

// The alarms counted as incidents (reportKind keys). Harsh braking, harsh
// acceleration and overspeeding are single events and count one by one.
// Camera covered is no longer in any report (2026-11-23) but folds the same,
// should it come back.
var foldedKinds = map[string]bool{"no_seatbelt": true, "phone": true, "camera_covered": true}

// foldNote is said in every report that counts the folded alarms.
const foldNote = "No seatbelt and On phone count incidents: repeats of the same alarm from one vehicle within 10 minutes of the first count once."

// foldRepeats returns the events with the repeats of each incident left
// out, in the order given. It needs every event, not just a period's: an
// incident that began before a period keeps its repeats out of it, so two
// periods side by side never count one incident twice.
func foldRepeats(events []PEvent) []PEvent {
	type key struct {
		vehicle int
		kind    string
	}
	idx := make([]int, len(events))
	at := make([]time.Time, len(events))
	for i := range events {
		idx[i] = i
		at[i] = parseTime(events[i].OccurredAt)
	}
	sort.SliceStable(idx, func(a, b int) bool { return at[idx[a]].Before(at[idx[b]]) })

	drop := make([]bool, len(events))
	opened := map[key]time.Time{}
	for _, i := range idx {
		if at[i].IsZero() {
			continue
		}
		k := reportKind(events[i])
		if !foldedKinds[k] {
			continue
		}
		kk := key{events[i].VehicleID, k}
		if first, ok := opened[kk]; ok && at[i].Sub(first) < incidentWindow {
			drop[i] = true
			continue
		}
		opened[kk] = at[i]
	}
	out := make([]PEvent, 0, len(events))
	for i, e := range events {
		if !drop[i] {
			out = append(out, e)
		}
	}
	return out
}
