package main

// The words of a driver-hours breach (operator, 2026-11-26: the old ones "are
// not making sense"; then: no explanations after the full stop, the daily
// rest as "rested only x (from – to), short of the 11 h", and how far over a
// limit the driver has gone so far).
//
// The words are made each time a breach is shown, from its rule, its period
// (the last part of its id), when it fired and its figures, so breaches
// stored with the old words read the new way too. Nothing stored is changed.
//
//   - Figures (hoursFacts) are kept on breaches from now on. An older breach
//     has none: its longest rest is read back from its stored words, which
//     carry it as the first "N h MM min", and its rest's times are not known.
//   - The Alerts page adds the running figure (hoursLive): the day's or week's
//     total so far and how far over the limit it is, or the stretch driven
//     without a break. The bell shows a breach as it fired, without them.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// stampLayout is how a stretch's or duty window's start is written in a
// breach's id (UTC).
const stampLayout = "20060102T150405"

// hoursFacts are the figures a breach's words are made from, kept on it.
type hoursFacts struct {
	Longest  float64 `json:"longest,omitempty"`  // seconds: the rest rules' longest rest
	RestFrom string  `json:"restFrom,omitempty"` // daily rest: when that rest began and ended (RFC 3339)
	RestTo   string  `json:"restTo,omitempty"`
	Driven   float64 `json:"driven,omitempty"` // no break: the stretch's driving once a break ended it
}

// hoursLive is a breach's running figure: the day's or week's total (work or
// driving, as the rule counts), or the stretch's driving; Ongoing while the
// day, week or stretch is still going.
type hoursLive struct {
	Total   float64
	Ongoing bool
}

var firstHM = regexp.MustCompile(`(\d+) h (\d{2}) min`)

// The limit each over-the-limit rule's figure is measured against.
var hoursLimitOf = map[string]time.Duration{
	ruleWorkDay: workDayLimit, ruleWorkWeek: workWeekLimit,
	ruleTotalDay: totalDayLimit, ruleTotalWeek: totalWeekLimit,
	ruleDriveDay: driveDayLimit, ruleDriveWeek: driveWeekLimit,
}

func isWeekRule(rule string) bool {
	return rule == ruleWorkWeek || rule == ruleTotalWeek || rule == ruleDriveWeek
}

// dur is "45 min" or "2 h 05 min".
func dur(sec float64) string {
	m := int(sec / 60)
	if m < 60 {
		return fmt.Sprintf("%d min", m)
	}
	return fmt.Sprintf("%d h %02d min", m/60, m%60)
}

// hoursWords is a breach's headline and detail. `at` is when it fired,
// `period` the start of what it judges (as in its id), live its running
// figure or nil. A rule it doesn't know gives "".
func hoursWords(rule, period string, at time.Time, f hoursFacts, live *hoursLive) (title, detail string) {
	at = at.In(fleetZone)
	day := func(t time.Time) string { return t.In(fleetZone).Format("2 Jan") }
	wday := func(t time.Time) string { return t.In(fleetZone).Format("Mon 2 Jan") }
	clock := func(t time.Time) string { return t.In(fleetZone).Format("15:04") }
	// "08:58", or "25 Nov 23:10" when it is not the day the breach fired.
	near := func(t time.Time) string {
		if fleetDay(t) == fleetDay(at) {
			return clock(t)
		}
		return day(t) + " " + clock(t)
	}
	stamp, _ := time.Parse(stampLayout, period) // stretch or duty window start (UTC); zero otherwise
	week := fleetWeek(at)

	// The over-the-limit rules: when the limit was reached, then the running
	// figure once it is a minute or more over.
	reached := func(what string, weekly bool, extra string) string {
		on := day(at)
		if weekly {
			on = wday(at)
		}
		s := fmt.Sprintf("Reached %s at %s on %s%s", what, clock(at), on, extra)
		if live == nil {
			return s
		}
		over := live.Total - hoursLimitOf[rule].Seconds()
		if over < 60 {
			return s
		}
		span := "that day"
		switch {
		case weekly && live.Ongoing:
			span = "so far this week"
		case weekly:
			span = "that week"
		case live.Ongoing:
			span = "so far"
		}
		return fmt.Sprintf("%s · %s %s, %s over", s, dur(live.Total), span, dur(over))
	}

	switch rule {
	case ruleWorkDay:
		return "Over 8 h work in a day", reached("8 h of work", false, "")
	case ruleWorkWeek:
		return "Over 48 h work in a week", reached("48 h of work", true, "")
	case ruleTotalDay:
		return "Over 12 h work in a day", reached("12 h of work", false, ", overtime included")
	case ruleTotalWeek:
		return "Over 60 h work in a week", reached("60 h of work", true, ", overtime included")
	case ruleDriveDay:
		return "Over 9 h driving in a day", reached("9 h of driving", false, "")
	case ruleDriveWeek:
		return "Over 48 h driving in a week", reached("48 h of driving", true, "")

	case ruleBreak:
		s := "Driving with no 30 min stop"
		if !stamp.IsZero() {
			s = "Driving since " + near(stamp) + " with no 30 min stop"
		}
		if live != nil && live.Total > 0 {
			if live.Ongoing {
				s += " · " + dur(live.Total) + " driven so far"
			} else {
				s += " · " + dur(live.Total) + " driven before the break"
			}
		}
		return "No break after 4.5 h driving", s

	case ruleRestDay:
		window := "in the 24 h before " + day(at) + " " + clock(at)
		if !stamp.IsZero() {
			window = "in the 24 h from " + day(stamp) + " " + clock(stamp)
		}
		if f.Longest < 60 {
			return "Daily rest too short", "No rest " + window
		}
		from, to := parseTime(f.RestFrom), parseTime(f.RestTo)
		if from.IsZero() || to.IsZero() {
			return "Daily rest too short", fmt.Sprintf("Rested only %s %s, short of the 11 h needed", dur(f.Longest), window)
		}
		// "07:56 – 10:41" on the day it fired, "2 Nov 14:04 – 22:00" on
		// another, "25 Nov 22:10 – 26 Nov 00:55" across midnight.
		span := day(from) + " " + clock(from) + " – " + day(to) + " " + clock(to)
		if fleetDay(from) == fleetDay(to) {
			span = near(from) + " – " + clock(to)
		}
		return "Daily rest too short", fmt.Sprintf("Rested only %s (%s), short of the 11 h needed", dur(f.Longest), span)

	case ruleRestWeek:
		if f.Longest < 60 {
			return "No 24 h weekly rest", "No rest in the week from " + wday(week)
		}
		return "No 24 h weekly rest", fmt.Sprintf(
			"Rested only %s at most in the week from %s, short of the 24 h needed", dur(f.Longest), wday(week))
	}
	return "", ""
}

// hoursPeriod is the period part of a breach's id ("hours:rule:vehicle:period").
func hoursPeriod(e PEvent) string {
	if parts := strings.SplitN(e.EventID, ":", 4); len(parts) == 4 {
		return parts[3]
	}
	return ""
}

// hoursFactsOf is a breach's figures: kept on it, or for an older breach its
// longest rest read back from its stored words.
func hoursFactsOf(e PEvent) hoursFacts {
	if e.Hours != nil {
		return *e.Hours
	}
	var f hoursFacts
	if m := firstHM.FindStringSubmatch(e.TypeLabel); m != nil {
		h, _ := strconv.Atoi(m[1]) // digits only: the pattern says so
		mins, _ := strconv.Atoi(m[2])
		f.Longest = float64(h*3600 + mins*60)
	}
	return f
}

// hoursText is a breach's headline and detail with its running figure (nil
// for none, as the bell shows it). A breach whose rule these words don't know
// keeps the words it was stored with.
func hoursText(e PEvent, live *hoursLive) (title, detail string) {
	if at := parseTime(e.OccurredAt); !at.IsZero() {
		if title, detail = hoursWords(e.Type, hoursPeriod(e), at, hoursFactsOf(e), live); title != "" {
			return title, detail
		}
	}
	title, detail, _ = strings.Cut(e.TypeLabel, ": ")
	return title, detail
}

// HoursText is a breach's words as the Alerts page shows them: with its
// running figure from the vehicle's tally, as of now.
func (s *Store) HoursText(e PEvent, now time.Time) (title, detail string) {
	s.mu.RLock()
	live := s.hoursLive(e, now)
	s.mu.RUnlock()
	return hoursText(e, live)
}

// hoursLive is a breach's running figure from the vehicle's tally, or nil
// when the tally no longer holds it (pruned, another stretch, an unknown
// rule). Called with s.mu held.
func (s *Store) hoursLive(e PEvent, now time.Time) *hoursLive {
	// A stretch a break has ended carries its own total: no tally needed.
	if e.Type == ruleBreak && e.Hours != nil && e.Hours.Driven > 0 {
		return &hoursLive{Total: e.Hours.Driven}
	}
	if s.p.Hours == nil {
		return nil
	}
	st := s.p.Hours.Vehicles[e.VehicleID]
	if st == nil {
		return nil
	}
	period := hoursPeriod(e)
	// Days older than the tally keeps are gone: a total over them is short.
	floor := fleetDay(st.LastAt.AddDate(0, 0, -hoursKeepDays))
	drives := e.Type == ruleDriveDay || e.Type == ruleDriveWeek

	switch {
	case e.Type == ruleBreak:
		if st.StretchStart.IsZero() || st.StretchStart.UTC().Format(stampLayout) != period {
			return nil // another stretch since, and this one's total not kept
		}
		// Stopped 30 min or more ago (or the tracker quiet that long while
		// driving): the break is under way, the stretch is over.
		pause := st.PauseSince
		if st.Driving {
			pause = time.Time{}
			if now.Sub(st.LastAt) > hoursGapCap {
				pause = st.LastAt.Add(hoursGapCap)
			}
		}
		ended := !pause.IsZero() && now.Sub(pause) >= breakNeeded
		return &hoursLive{Total: st.SinceBreak, Ongoing: !ended}

	case isWeekRule(e.Type):
		wk, err := time.ParseInLocation("2006-01-02", period, fleetZone)
		if err != nil || period < floor {
			return nil
		}
		work, drive := st.weekTotals(wk)
		total := work
		if drives {
			total = drive
		}
		return &hoursLive{Total: total, Ongoing: fleetWeek(now).Equal(wk)}

	case hoursLimitOf[e.Type] > 0: // the day rules
		dd := st.Days[period]
		if dd == nil || period < floor {
			return nil
		}
		total := dd.Work
		if drives {
			total = dd.Drive
		}
		return &hoursLive{Total: total, Ongoing: fleetDay(now) == period}
	}
	return nil
}
