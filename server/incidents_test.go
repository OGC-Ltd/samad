package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

var incT0 = time.Date(2026, 11, 20, 8, 0, 0, 0, time.UTC)

func incEvent(id string, vehicle int, typ string, at time.Time) PEvent {
	return PEvent{EventID: id, Source: "device", Type: typ, VehicleID: vehicle, OccurredAt: at.Format(time.RFC3339)}
}

func ids(evs []PEvent) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.EventID)
	}
	return out
}

func TestFoldFiveInAMinuteIsOne(t *testing.T) {
	var evs []PEvent
	for i := 0; i < 5; i++ {
		evs = append(evs, incEvent(fmt.Sprint(i), 1, "phone_use", incT0.Add(time.Duration(i)*12*time.Second)))
	}
	if got := ids(foldRepeats(evs)); fmt.Sprint(got) != "[0]" {
		t.Fatalf("got %v", got)
	}
}

func TestFoldCountsFromTheFirstAlarm(t *testing.T) {
	// One alarm a minute for 25 minutes: incidents open at 0, 10 and 20.
	var evs []PEvent
	for m := 0; m < 25; m++ {
		evs = append(evs, incEvent(fmt.Sprintf("m%02d", m), 1, "phone_use", incT0.Add(time.Duration(m)*time.Minute)))
	}
	if got := ids(foldRepeats(evs)); fmt.Sprint(got) != "[m00 m10 m20]" {
		t.Fatalf("got %v", got)
	}
}

func TestFoldExactlyTenMinutesOpensANewOne(t *testing.T) {
	evs := []PEvent{
		incEvent("a", 1, "no_seatbelt", incT0),
		incEvent("b", 1, "no_seatbelt", incT0.Add(incidentWindow-time.Second)),
		incEvent("c", 1, "no_seatbelt", incT0.Add(incidentWindow)),
	}
	if got := ids(foldRepeats(evs)); fmt.Sprint(got) != "[a c]" {
		t.Fatalf("got %v", got)
	}
}

func TestFoldPerVehicleAndPerAlarm(t *testing.T) {
	evs := []PEvent{
		incEvent("p1", 1, "phone_use", incT0),
		incEvent("s1", 1, "no_seatbelt", incT0.Add(time.Second)),        // other alarm
		incEvent("p2", 2, "phone_use", incT0.Add(2*time.Second)),        // other vehicle
		incEvent("c1", 1, "camera_occlusion", incT0.Add(3*time.Second)), // camera covered
		incEvent("c2", 1, "camera_covered", incT0.Add(4*time.Second)),   // the same kind: a repeat
		incEvent("p3", 1, "phone_call", incT0.Add(5*time.Second)),       // phone again: a repeat
	}
	if got := ids(foldRepeats(evs)); fmt.Sprint(got) != "[p1 s1 p2 c1]" {
		t.Fatalf("got %v", got)
	}
}

func TestFoldLeavesOtherKindsAlone(t *testing.T) {
	var evs []PEvent
	for i, typ := range []string{"harsh_braking", "harsh_braking", "harsh_acceleration", "over_speeding", "over_speeding", "lane_departure", "lane_departure"} {
		e := incEvent(fmt.Sprint(i), 1, typ, incT0.Add(time.Duration(i)*time.Second))
		if typ == "over_speeding" {
			e.Source = "platform"
		}
		evs = append(evs, e)
	}
	if got := foldRepeats(evs); len(got) != len(evs) {
		t.Fatalf("dropped single events: %v", ids(got))
	}
}

func TestFoldIgnoresInputOrderButKeepsIt(t *testing.T) {
	// Given newest first: the earliest still opens the incident.
	evs := []PEvent{
		incEvent("late", 1, "phone_use", incT0.Add(5*time.Minute)),
		incEvent("x", 2, "harsh_braking", incT0.Add(time.Minute)),
		incEvent("early", 1, "phone_use", incT0),
	}
	if got := ids(foldRepeats(evs)); fmt.Sprint(got) != "[x early]" {
		t.Fatalf("got %v", got)
	}
}

func TestFoldKeepsUndatedEvents(t *testing.T) {
	evs := []PEvent{{EventID: "u1", Source: "device", Type: "phone_use", VehicleID: 1}, {EventID: "u2", Source: "device", Type: "phone_use", VehicleID: 1}}
	if got := foldRepeats(evs); len(got) != 2 {
		t.Fatalf("got %v", ids(got))
	}
}

// Through the routes the Reports page uses: five phone alarms in a minute and
// one twelve minutes later are two incidents; harsh braking counts each.
func TestReportsCountIncidents(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	base := time.Now().Add(-2 * time.Hour).Truncate(time.Minute)
	var evs []PEvent
	for i := 0; i < 5; i++ {
		evs = append(evs, incEvent(fmt.Sprintf("ph%d", i), 7, "phone_use", base.Add(time.Duration(i)*10*time.Second)))
	}
	evs = append(evs,
		incEvent("ph-later", 7, "phone_use", base.Add(12*time.Minute)),
		incEvent("hb1", 7, "harsh_braking", base.Add(time.Minute)),
		incEvent("hb2", 7, "harsh_braking", base.Add(time.Minute+5*time.Second)),
	)
	for i := range evs {
		evs[i].Registration = "KDA 7"
		evs[i].Severity = "critical"
	}
	h.store.AddEvents(evs, "")
	from := fmt.Sprint(time.Now().Add(-24 * time.Hour).UnixMilli())

	for kind, field := range map[string]string{"conduct": "incidents", "breaches": "breaches"} {
		rec := h.do("GET", "/api/v1/reports/"+kind+"/document?org=samad&from="+from, token, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", kind, rec.Code, rec.Body)
		}
		var out struct{ Data ReportDoc }
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out.Data.Summary[field] != float64(4) { // 2 phone incidents + 2 harsh braking
			t.Errorf("%s %s = %v, want 4", kind, field, out.Data.Summary[field])
		}
		if !strings.Contains(rec.Body.String(), "within 10 minutes of the first count once") {
			t.Errorf("%s: no note on how incidents are counted", kind)
		}
	}
}

// Weekly Incidents counts the same way, and an incident that began in one
// week keeps its repeats out of the next.
func TestWeeklyTallyCountsIncidents(t *testing.T) {
	week := weekStart(time.Date(2026, 11, 10, 12, 0, 0, 0, fleetZone))
	next := week.AddDate(0, 0, 7)
	evs := []PEvent{
		incEvent("a", 7, "no_seatbelt", week.Add(time.Hour)),
		incEvent("b", 7, "no_seatbelt", week.Add(time.Hour+time.Minute)),
		incEvent("c", 7, "no_seatbelt", week.Add(time.Hour+2*time.Minute)),
		incEvent("x", 7, "no_seatbelt", next.Add(-time.Minute)),   // opens one just before the week ends
		incEvent("y", 7, "no_seatbelt", next.Add(2*time.Minute)),  // its repeat, in the next week
		incEvent("z", 7, "no_seatbelt", next.Add(20*time.Minute)), // a new one
	}
	this := tallyWeek(week, week, evs, nil, nil)
	if n := this.Units[7].Counts["no_seatbelt"]; n != 2 {
		t.Errorf("this week = %d, want 2", n)
	}
	after := tallyWeek(next, next, evs, nil, nil)
	if n := after.Units[7].Counts["no_seatbelt"]; n != 1 {
		t.Errorf("next week = %d, want 1 (the repeat belongs to last week's incident)", n)
	}
}

// Camera covered is out of every report (operator, 2026-11-23): no column,
// not in the totals, not even from a week tallied before it was left out.
func TestCameraCoveredInNoReport(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	at := time.Now().Add(-2 * time.Hour)
	evs := []PEvent{
		incEvent("cc", 7, "camera_occlusion", at),
		incEvent("ph", 7, "phone_use", at.Add(time.Minute)),
	}
	for i := range evs {
		evs[i].Registration, evs[i].Severity = "KDA 7", "critical"
	}
	h.store.AddEvents(evs, "")
	from := fmt.Sprint(time.Now().Add(-24 * time.Hour).UnixMilli())
	for kind, field := range map[string]string{"conduct": "incidents", "breaches": "breaches"} {
		rec := h.do("GET", "/api/v1/reports/"+kind+"/document?org=samad&from="+from, token, nil)
		if strings.Contains(strings.ToLower(rec.Body.String()), "camera covered") {
			t.Errorf("%s still mentions camera covered", kind)
		}
		var out struct{ Data ReportDoc }
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if out.Data.Summary[field] != float64(1) {
			t.Errorf("%s %s = %v, want 1 (the phone call only)", kind, field, out.Data.Summary[field])
		}
	}
	shift := h.do("GET", "/api/v1/reports/shift/document?org=samad&day="+fleetDay(time.Now())+"&shift=day", token, nil)
	if strings.Contains(strings.ToLower(shift.Body.String()), "camera covered") {
		t.Error("End of Shift still mentions camera covered")
	}
	weekly := h.do("GET", "/api/v1/reports/weekly/document?org=samad&weeks=4", token, nil)
	if strings.Contains(strings.ToLower(weekly.Body.String()), "camera covered") {
		t.Error("Weekly Incidents still mentions camera covered")
	}
	// A week tallied before: its camera covered count stays out of the total.
	if n := sumCounts(map[string]int{"camera_covered": 40, "phone": 2, "no_seatbelt": 1}); n != 3 {
		t.Errorf("old tally total = %d, want 3", n)
	}
}
