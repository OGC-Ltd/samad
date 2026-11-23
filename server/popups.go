package main

// Pop-ups: the bottom-corner cards for the driver alarms people must see as
// they happen (operator, 2026-11-23: Phone Use, No Seatbelt, Driver
// Distracted and Overspeeding, "like the unauthorised stops" in raitrack).
// The Alerts page still lists every alert; a pop-up only points to it.
//
// The cameras fire in bursts (21 Oct–19 Nov: 247 of these a day, 90 in the
// busiest minute, one run of 274 from one truck), so the server decides once
// for everybody what is worth a card:
//
//   - One card per truck and alarm, then quiet until that truck has gone
//     popupQuiet without that alarm. Repeats in between are only counted.
//   - One follow-up when the count reaches popupFollowUp in that run:
//     "Phone Use, 5 times in 4 min".
//   - Only alerts that reached us in the last popupFresh: the catch-up after
//     a restart or a deploy never pops up.
//   - At most popupPerMinute cards a minute across the fleet; the rest of
//     that minute's become one summary card.
//
// No Seatbelt pops up silently: it is the most frequent and least urgent.
// Everything here is in memory: a restart starts the runs afresh.

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	popupQuiet     = 30 * time.Minute
	popupFollowUp  = 5
	popupFresh     = 2 * time.Minute
	popupPerMinute = 3
)

// The alarms that pop up, in the order a summary names them.
var popupAlarms = []string{"phone_use", "no_seatbelt", "driver_distracted", "overspeeding"}

var popupLabel = map[string]string{
	"phone_use":         "Phone Use",
	"no_seatbelt":       "No Seatbelt",
	"driver_distracted": "Driver Distracted",
	"overspeeding":      "Overspeeding",
}

// popupAlarm is which pop-up an event answers to, or "".
func popupAlarm(e PEvent) string {
	if isSpeeding(e) {
		return "overspeeding"
	}
	return cameraAlarm(e)
}

// Toast is one card, sent down the live stream as a `toast` frame.
type Toast struct {
	ID    string    `json:"id"`
	Kind  string    `json:"kind"`  // "alarm", or "alarms" for a summary
	Level string    `json:"level"` // "critical" | "warning"
	Title string    `json:"title"`
	Body  string    `json:"body"`
	Sound bool      `json:"sound"`
	Data  ToastData `json:"data"`
}

type ToastData struct {
	Alarm     string         `json:"alarm,omitempty"`
	Plate     string         `json:"plate,omitempty"`
	VehicleID string         `json:"vehicleId,omitempty"`
	EventID   string         `json:"eventId,omitempty"`
	Count     int            `json:"count,omitempty"`
	Counts    map[string]int `json:"counts,omitempty"` // a summary: alarm → cards it stands for
}

type popupKey struct {
	vehicle int
	alarm   string
}

type popupRun struct {
	start, last time.Time
	count       int
	shown       bool // a card went out for this run
	followed    bool // and its follow-up
}

// Popups holds the runs. Safe for one poller; the lock is for tests and
// any later second caller.
type Popups struct {
	mu       sync.Mutex
	runs     map[popupKey]*popupRun
	minute   time.Time
	inMinute int
}

func NewPopups() *Popups { return &Popups{runs: map[popupKey]*popupRun{}} }

// Namer gives a vehicle's plate and driver for the card's words.
type Namer func(vehicleID int) (plate, driver string)

// Take reads newly arrived events (oldest first, as the feed gives them)
// and returns the cards to send now.
func (p *Popups) Take(events []PEvent, now time.Time, name Namer) []Toast {
	p.mu.Lock()
	defer p.mu.Unlock()

	sorted := make([]PEvent, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool {
		return parseTime(sorted[i].ReceivedAt).Before(parseTime(sorted[j].ReceivedAt))
	})

	var cards []Toast
	for _, e := range sorted {
		alarm := popupAlarm(e)
		if alarm == "" {
			continue
		}
		at := parseTime(e.ReceivedAt)
		if at.IsZero() {
			continue
		}
		fresh := now.Sub(at) <= popupFresh && !at.After(now.Add(popupFresh))
		k := popupKey{e.VehicleID, alarm}
		run := p.runs[k]
		if run != nil && at.Sub(run.last) < popupQuiet {
			run.count++
			if at.After(run.last) {
				run.last = at
			}
			switch {
			case fresh && !run.shown:
				// The run began with alerts too old to show (a catch-up):
				// its first fresh one is the card nobody has seen yet.
				run.shown = true
				cards = append(cards, popupCard(e, alarm, 1, 0, name))
			case fresh && !run.followed && run.count >= popupFollowUp:
				run.followed = true
				cards = append(cards, popupCard(e, alarm, run.count, run.last.Sub(run.start), name))
			}
			continue
		}
		p.runs[k] = &popupRun{start: at, last: at, count: 1, shown: fresh}
		if fresh {
			cards = append(cards, popupCard(e, alarm, 1, 0, name))
		}
	}
	p.forget(now)
	return p.limit(cards, now)
}

// forget drops runs that have gone quiet, so the map stays the size of the
// fleet's current trouble.
func (p *Popups) forget(now time.Time) {
	for k, r := range p.runs {
		if now.Sub(r.last) >= popupQuiet {
			delete(p.runs, k)
		}
	}
}

// limit keeps popupPerMinute cards a minute; the rest become one summary.
func (p *Popups) limit(cards []Toast, now time.Time) []Toast {
	if m := now.Truncate(time.Minute); !m.Equal(p.minute) {
		p.minute, p.inMinute = m, 0
	}
	var out, over []Toast
	for _, c := range cards {
		if p.inMinute < popupPerMinute {
			p.inMinute++
			out = append(out, c)
		} else {
			over = append(over, c)
		}
	}
	if len(over) == 0 {
		return out
	}
	counts := map[string]int{}
	sound := false
	for _, c := range over {
		counts[c.Data.Alarm]++
		sound = sound || c.Sound
	}
	var parts []string
	for _, a := range popupAlarms {
		if n := counts[a]; n > 0 {
			parts = append(parts, fmt.Sprintf("%s ×%d", popupLabel[a], n))
		}
	}
	title := fmt.Sprintf("%d more alerts", len(over))
	if len(over) == 1 {
		title = "1 more alert"
	}
	return append(out, Toast{
		ID: "pop-sum-" + over[0].ID, Kind: "alarms", Level: "critical",
		Title: title, Body: strings.Join(parts, " · "), Sound: sound,
		Data: ToastData{Counts: counts},
	})
}

func popupCard(e PEvent, alarm string, count int, span time.Duration, name Namer) Toast {
	plate, driver := e.Registration, ""
	if name != nil {
		if pl, dr := name(e.VehicleID); pl != "" {
			plate, driver = pl, dr
		} else {
			driver = dr
		}
	}
	label := popupLabel[alarm]
	id := "pop-" + e.EventID
	title := fmt.Sprintf("%s: %s", plate, label)
	if count > 1 {
		id += "-x"
		title = fmt.Sprintf("%s: %s %d times in %s", plate, label, count, popupSpan(span))
	}
	var bits []string
	if driver != "" && driver != "Unassigned" {
		bits = append(bits, driver)
	}
	if e.Speed != nil {
		bits = append(bits, fmt.Sprintf("%.0f km/h", *e.Speed))
	}
	if t := parseTime(e.OccurredAt); !t.IsZero() {
		bits = append(bits, t.In(fleetZone).Format("15:04"))
	}
	level := "critical"
	if severityOf(e) == "warning" {
		level = "warning"
	}
	return Toast{
		ID: id, Kind: "alarm", Level: level, Title: title,
		Body:  strings.Join(bits, " · "),
		Sound: alarm != "no_seatbelt",
		Data: ToastData{
			Alarm: alarm, Plate: plate, VehicleID: vehicleKey(e.VehicleID),
			EventID: e.EventID, Count: count,
		},
	}
}

func popupSpan(d time.Duration) string {
	m := int(d.Round(time.Minute) / time.Minute)
	if m < 1 {
		return "under a minute"
	}
	if m == 1 {
		return "1 min"
	}
	return fmt.Sprintf("%d min", m)
}
