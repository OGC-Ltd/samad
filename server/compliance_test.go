package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// at is a time on a fleet day, Nairobi time.
func at(day string, hour int) time.Time {
	t, err := time.ParseInLocation("2006-01-02", day, fleetZone)
	if err != nil {
		panic(err)
	}
	return t.Add(time.Duration(hour) * time.Hour)
}

func hrs(h float64) dutyDay { return dutyDay{Work: h * 3600, Drive: h * 3600} }

func compVehicles(ids ...int) []PVehicle {
	var out []PVehicle
	for _, id := range ids {
		out = append(out, PVehicle{VehicleID: id, Registration: fmt.Sprintf("KD%d", id)})
	}
	return out
}

func breach(rule string, vehicle int, t time.Time) PEvent {
	return PEvent{EventID: fmt.Sprintf("hours:%s:%d:%d", rule, vehicle, t.Unix()), Source: "hours", Type: rule,
		VehicleID: vehicle, OccurredAt: t.UTC().Format(time.RFC3339), Driver: fmt.Sprintf("Driver %d", vehicle)}
}

func alarm(id string, vehicle int, typ string, t time.Time) PEvent {
	return PEvent{EventID: id, Source: "device", Type: typ, Severity: "critical", VehicleID: vehicle,
		OccurredAt: t.UTC().Format(time.RFC3339)}
}

func rowOf(t *testing.T, rows []compRow, ref string) compRow {
	t.Helper()
	for _, r := range rows {
		if r.Ref == ref {
			return r
		}
	}
	t.Fatalf("no row %s", ref)
	return compRow{}
}

func is(p *int, want int) bool { return p != nil && *p == want }

// Mon 9 Nov 2026 to Fri 13 Nov 2026.
func hoursInput() compInput {
	return compInput{
		From: at("2026-11-10", 0), To: at("2026-11-13", 0), Now: at("2026-11-20", 12),
		Vehicles: compVehicles(1, 2),
		Duty: map[int]dutyView{
			1: {Since: at("2026-11-07", 6), Days: map[string]dutyDay{
				"2026-11-09": hrs(9), "2026-11-10": hrs(9), "2026-11-11": hrs(5), "2026-11-12": {},
			}},
			// Monitored from the 11th: its work on the 10th is not a driver-day.
			2: {Since: at("2026-11-11", 6), Days: map[string]dutyDay{
				"2026-11-10": hrs(4), "2026-11-11": hrs(4),
			}},
		},
		Hours: []PEvent{
			breach(ruleWorkDay, 1, at("2026-11-10", 15)),
			breach(ruleWorkDay, 1, at("2026-11-09", 15)), // before the period
			breach(ruleBreak, 2, at("2026-11-11", 10)),
		},
	}
}

func TestComplianceDriverDays(t *testing.T) {
	rows := buildCompliance(hoursInput())
	// Driver-days: vehicle 1 on the 10th and 11th, vehicle 2 on the 11th = 3.
	a := rowOf(t, rows, "5.1.4a")
	if !is(a.Compliance, 66) || a.Result != "1 breach · 2 of 3 working days OK" || !a.Monitored {
		t.Fatalf("5.1.4a = %+v", a)
	}
	if a.Passed != 2 || a.Total != 3 || a.Noun != "working days" {
		t.Errorf("the plain sum: %d of %d %s", a.Passed, a.Total, a.Noun)
	}
	if len(a.ByUnit) != 1 || a.ByUnit[0].Plate != "KD1" || a.ByUnit[0].N != 1 || a.ByUnit[0].Driver != "Driver 1" {
		t.Errorf("by unit: %+v", a.ByUnit)
	}
	if len(a.ByDay) != 3 || a.ByDay[0] != (compDay{"2026-11-10", 1}) {
		t.Errorf("by day: %+v", a.ByDay)
	}
	d := rowOf(t, rows, "5.1.4d")
	if !is(d.Compliance, 66) || d.Breaches != 1 {
		t.Errorf("5.1.4d = %+v", d)
	}
	if g := rowOf(t, rows, "5.1.4g"); !is(g.Compliance, 100) || g.Result != "0 breaches · 3 of 3 working days OK" {
		t.Errorf("5.1.4g = %+v", g)
	}
}

// A unit opens to its incidents: newest first, in the breach's own words.
func TestComplianceUnitItems(t *testing.T) {
	in := hoursInput()
	// As hours.go raises them: the id ends with the 24 h window's start, the
	// breach comes when the window closes.
	rest := func(start time.Time, text string) PEvent {
		e := breach(ruleRestDay, 1, start.Add(24*time.Hour))
		e.EventID = "hours:daily_rest:1:" + start.UTC().Format("20060102T150405")
		e.TypeLabel = "Daily rest: " + text
		return e
	}
	in.Hours = append(in.Hours,
		rest(at("2026-11-09", 7), "longest rest 8 h 12 min in 24 h, under 11 h"),
		rest(at("2026-11-10", 9), "longest rest 6 h 43 min in 24 h, under 11 h"))
	e := rowOf(t, buildCompliance(in), "5.1.4e")
	if len(e.ByUnit) != 1 || len(e.ByUnit[0].Items) != 2 {
		t.Fatalf("5.1.4e by unit: %+v", e.ByUnit)
	}
	it := e.ByUnit[0].Items
	stamp := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	if it[0].What != "Longest rest was 6 h 43 min. Needed 11 h (4 h 17 min short)." ||
		it[1].What != "Longest rest was 8 h 12 min. Needed 11 h (2 h 48 min short)." ||
		it[0].At != stamp(at("2026-11-10", 9)) || it[0].Until != stamp(at("2026-11-11", 9)) ||
		it[0].Driver != "Driver 1" || it[0].WholeDay {
		t.Errorf("items: %+v", it)
	}

	// A day rule: the day's final total, not the figure when it first went over.
	in = hoursInput()
	work := breach(ruleWorkDay, 1, at("2026-11-10", 15))
	work.EventID, work.TypeLabel = "hours:working_hours_day:1:2026-11-10", "Working hours: 8 h 01 min today, over the 8 h day"
	in.Hours = []PEvent{work}
	a := rowOf(t, buildCompliance(in), "5.1.4a").ByUnit[0].Items[0]
	if a.What != "Worked 9 h. Limit 8 h (1 h over)." || !a.WholeDay || a.At != stamp(at("2026-11-10", 1)) {
		t.Errorf("5.1.4a item: %+v", a)
	}
	if short(40*60) != "40 min" || short(4*3600+17*60) != "4 h 17 min" || short(6*3600) != "6 h" {
		t.Errorf("short: %s, %s, %s", short(40*60), short(4*3600+17*60), short(6*3600))
	}

	in = hoursInput()
	in.Duty[1].Days["2026-11-11"] = hrs(10)
	in.Duty[1].Days["2026-11-12"] = hrs(9.5)
	c := rowOf(t, buildCompliance(in), "5.1.4c")
	if len(c.ByUnit) != 1 || len(c.ByUnit[0].Items) != 3 || !c.ByUnit[0].Items[0].WholeDay ||
		c.ByUnit[0].Items[0].What != "Worked 9 h 30 min. Over 8 h on 3 days that week." {
		t.Errorf("5.1.4c items: %+v", c.ByUnit)
	}

	phone := alarm("p1", 2, "phone_use", at("2026-11-11", 9))
	phone.TypeLabel, phone.Speed = "Phone Use", new(54.0)
	in = hoursInput()
	in.Events = []PEvent{phone}
	p := rowOf(t, buildCompliance(in), "5.1.3")
	if len(p.ByUnit) != 1 || len(p.ByUnit[0].Items) != 1 || p.ByUnit[0].Items[0].What != "Phone Use" || *p.ByUnit[0].Items[0].Speed != 54 {
		t.Errorf("5.1.3 items: %+v", p.ByUnit)
	}
}

func TestComplianceNotMonitored(t *testing.T) {
	in := hoursInput()
	in.From, in.To = at("2026-11-01", 0), at("2026-11-06", 0)
	for _, r := range buildCompliance(in) {
		hours := r.Ref >= "5.1.4a" && r.Ref <= "5.1.4g"
		if hours && (r.Compliance != nil || r.Monitored || r.Result != "Not monitored") {
			t.Errorf("%s before monitoring: %+v", r.Ref, r)
		}
		if !hours && !r.Monitored {
			t.Errorf("%s is not an hours row: always monitored", r.Ref)
		}
	}
}

func TestComplianceOvertimeNotStructural(t *testing.T) {
	in := hoursInput()
	in.From, in.To = at("2026-11-09", 0), at("2026-11-16", 0)
	in.Duty[1].Days["2026-11-11"] = hrs(9) // three days over 8 h: 9th, 10th, 11th
	in.Duty[2].Days["2026-11-12"] = hrs(9) // one
	c := rowOf(t, buildCompliance(in), "5.1.4c")
	if !is(c.Compliance, 50) || c.Result != "1 truck over 8 h on 3+ days · 1 of 2 truck-weeks OK" {
		t.Fatalf("5.1.4c = %+v", c)
	}
	if len(c.ByUnit) != 1 || c.ByUnit[0].N != 3 || c.UnitWord != "days" {
		t.Errorf("by unit: %+v", c.ByUnit)
	}
}

func TestComplianceWeeklyRest(t *testing.T) {
	in := hoursInput()
	in.From, in.To = at("2026-11-09", 0), at("2026-11-16", 0)
	in.Hours = append(in.Hours, breach(ruleRestWeek, 1, at("2026-11-14", 8)))
	// Vehicle 2 began after the Monday: its week is not judged.
	f := rowOf(t, buildCompliance(in), "5.1.4f")
	if !is(f.Compliance, 0) || f.Result != "1 breach · 0 of 1 truck-weeks OK" {
		t.Fatalf("5.1.4f = %+v", f)
	}
}

func TestComplianceAlarmsPerUnit(t *testing.T) {
	t0 := at("2026-11-10", 9)
	var evs []PEvent
	for i := 0; i < 5; i++ { // one phone incident: five alarms in a minute
		evs = append(evs, alarm(fmt.Sprintf("p%d", i), 1, "phone_use", t0.Add(time.Duration(i)*10*time.Second)))
	}
	evs = append(evs,
		alarm("s", 2, "smoking_detected", t0),           // left out: false alarms
		alarm("dd", 2, "driver_distracted", t0),         // left out too
		alarm("l", 3, "lane_departure", t0),             // unit 3 has a dashcam, no distraction
		alarm("x", 4, "phone_use", at("2026-11-13", 1)), // after the period
	)
	in := compInput{From: at("2026-11-10", 0), To: at("2026-11-13", 0), Now: at("2026-11-20", 0), Vehicles: compVehicles(1, 2, 3, 4), Events: evs}
	rows := buildCompliance(in)
	d := rowOf(t, rows, "5.1.3")
	// Phone use only (operator, 2026-11-23): dashcam units 1-4, with a phone
	// alarm in the period: unit 1. Unit 2's smoking and distraction do not count.
	if !is(d.Compliance, 75) || d.Result != "1 incident · 1 of 4 trucks had an alarm" || d.Alerts.Alarm != "phone_use" || d.Measure != "Dashcam phone-use alarms" || d.Requirement != "No phone use while driving" {
		t.Fatalf("5.1.3 = %+v", d)
	}
	if s := rowOf(t, rows, "5.2.2e"); !is(s.Compliance, 100) || s.Result != "0 incidents · 0 of 4 trucks had an alarm" {
		t.Errorf("5.2.2e = %+v", s)
	}
}

func TestCompliancePeriodBounds(t *testing.T) {
	from, to := at("2026-11-10", 0), at("2026-11-11", 0)
	in := compInput{From: from, To: to, Now: at("2026-11-20", 0), Vehicles: compVehicles(1, 2, 3),
		Events: []PEvent{
			alarm("in", 1, "no_seatbelt", from),                       // the first instant: in
			alarm("out", 2, "no_seatbelt", to),                        // the end is not in the period
			alarm("before", 3, "no_seatbelt", from.Add(-time.Second)), // nor before it
		}}
	if s := rowOf(t, buildCompliance(in), "5.2.2e"); s.Breaches != 1 || s.ByUnit[0].Plate != "KD1" {
		t.Fatalf("bounds: %+v", s)
	}
}

func TestComplianceTelematics(t *testing.T) {
	in := compInput{From: at("2026-11-10", 0), To: at("2026-11-11", 0), Now: at("2026-11-20", 0), Vehicles: compVehicles(1, 2, 3),
		Events:    []PEvent{alarm("a", 1, "lane_departure", at("2026-11-02", 0))},
		Reporting: map[string]map[int]bool{"2026-11-10": {1: true, 2: true}, "2026-11-09": {3: true}}}
	r := rowOf(t, buildCompliance(in), "5.1.5")
	if !is(r.Compliance, 66) || r.Result != "2 of 3 reporting · 1 of 3 with dashcam" {
		t.Fatalf("5.1.5 = %+v", r)
	}
	if len(r.ByUnit) != 1 || r.ByUnit[0].Plate != "KD3" || mostBreaches(r) != "KD3 not reporting" {
		t.Errorf("not reporting: %+v", r.ByUnit)
	}
}

func TestComplianceReviewedWithin6h(t *testing.T) {
	t0 := at("2026-11-10", 8)
	now := at("2026-11-10", 20)
	decided := map[string][]Decision{
		"on":   {{Outcome: "DEESCALATED", At: t0.Add(time.Hour).UTC().Format(time.RFC3339)}},
		"late": {{Outcome: "ESCALATED", At: t0.Add(7 * time.Hour).UTC().Format(time.RFC3339)}, {Outcome: "x", At: t0.Add(30 * time.Minute).UTC().Format(time.RFC3339)}},
	}
	in := compInput{From: at("2026-11-10", 0), To: at("2026-11-11", 0), Now: now, Vehicles: compVehicles(1, 2),
		Events: []PEvent{
			alarm("on", 1, "phone_use", t0),
			alarm("late", 1, "phone_use", t0.Add(time.Minute)),      // its first decision was at 30 min: on time
			alarm("never", 2, "no_seatbelt", t0),                    // never reviewed, 12 h on: late
			alarm("waiting", 2, "no_seatbelt", now.Add(-time.Hour)), // still inside its 6 h
			{EventID: "w", Source: "device", Type: "lane_departure", Severity: "warning", VehicleID: 1, OccurredAt: t0.UTC().Format(time.RFC3339)},
		},
		Decisions: func(id string) []Decision { return decided[id] }}
	r := rowOf(t, buildCompliance(in), "5.1.6")
	if !is(r.Compliance, 66) || r.Result != "2 of 3 reviewed within 6 h · 1 still inside 6 h" || r.Measure != "Critical alarms reviewed within 6 h" {
		t.Fatalf("5.1.6 = %+v", r)
	}
	if len(r.ByUnit) != 1 || r.ByUnit[0].Plate != "KD2" {
		t.Errorf("late by unit: %+v", r.ByUnit)
	}
}

func TestComplianceSpeedLimiter(t *testing.T) {
	kmh := func(v float64) *float64 { return &v }
	in := compInput{From: at("2026-11-10", 0), To: at("2026-11-11", 0), Now: at("2026-11-20", 0), Vehicles: compVehicles(1, 2)}
	e1 := alarm("a", 1, "over_speeding", at("2026-11-10", 9))
	e1.Speed = kmh(85)
	e2 := alarm("b", 2, "lane_departure", at("2026-11-10", 9))
	e2.Speed = kmh(70)
	in.Events = []PEvent{e1, e2}
	for _, r := range buildCompliance(in) {
		if r.Ref == "5.2.2h" {
			t.Fatal("5.2.2h shown with no limiter setting")
		}
	}
	in.LimiterKmh = 80
	h := rowOf(t, buildCompliance(in), "5.2.2h")
	if !is(h.Compliance, 50) || h.Result != "1 unit above 80 km/h · top 85 km/h" || mostBreaches(h) != "KD1 85 km/h" {
		t.Fatalf("5.2.2h = %+v", h)
	}
}

func TestComplianceSummary(t *testing.T) {
	p := func(n int) *int { return &n }
	s := summarise([]compRow{
		{Category: "Operational", Compliance: p(100)},
		{Category: "Operational", Compliance: p(80)},
		{Category: "Operational", Compliance: nil}, // not monitored: not in any figure
		{Category: "Vehicle", Compliance: p(75)},
	})
	if !is(s.Overall, 85) || s.Met != 1 || s.With != 2 || !is(s.Categories["Operational"], 90) || !is(s.Categories["Vehicle"], 75) {
		t.Fatalf("summary = %+v", s)
	}
}

func TestComplianceLastWeeks(t *testing.T) {
	wks := lastWeeks(at("2026-11-23", 0), at("2026-11-23", 10)) // a Monday's midnight: the week before
	if fleetDay(wks[3].Add(time.Hour)) != "2026-11-16" || fleetDay(wks[0].Add(time.Hour)) != "2026-10-26" {
		t.Fatalf("weeks: %v", wks)
	}
	if got := weekLabel(wks[3], wks[3].AddDate(0, 0, 7)); got != "16 – 22 Nov" {
		t.Errorf("label %q", got)
	}
	if got := weekLabel(wks[0], wks[0].AddDate(0, 0, 7)); got != "26 Oct – 1 Nov" {
		t.Errorf("label %q", got)
	}
}

func TestComplianceRoute(t *testing.T) {
	h := newHarness(t)
	q := fmt.Sprintf("/api/v1/compliance?org=samad&from=%d&to=%d", time.Now().Add(-48*time.Hour).UnixMilli(), time.Now().UnixMilli())
	if rec := h.do("GET", q, "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", rec.Code)
	}
	admin, _ := h.login()
	_, dispatcher := h.invite(admin, "dispatch@samad.test", "dispatcher") // live map, no alerts
	if rec := h.do("GET", q, dispatcher, nil); rec.Code != http.StatusForbidden {
		t.Errorf("dispatcher: %d", rec.Code)
	}
	// Whoever opens Alerts opens Compliance: a fleet manager has the
	// fuel-theft grant, not alerts:read.
	_, manager := h.invite(admin, "fleet@samad.test", "fleet_manager")
	if rec := h.do("GET", q, manager, nil); rec.Code != http.StatusOK {
		t.Errorf("fleet manager: %d", rec.Code)
	}
	rec := h.do("GET", q, admin, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Data struct {
			Rows     []compRow           `json:"rows"`
			Units    int                 `json:"units"`
			Vehicles []map[string]string `json:"vehicles"`
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Data.Vehicles == nil || len(out.Data.Vehicles) != out.Data.Units {
		t.Errorf("every unit for the picker: %v of %d", out.Data.Vehicles, out.Data.Units)
	}
	if got := compVehicleList(compVehicles(3, 1, 2)); got[0]["plate"] != "KD1" || got[2]["vehicleId"] != "3" || len(got) != 3 {
		t.Errorf("vehicle list: %v", got)
	}
	if len(out.Data.Rows) != 12 { // 5.2.2h too: the limiter is 70 km/h
		t.Errorf("rows: %d", len(out.Data.Rows))
	}
	if h := rowOf(t, out.Data.Rows, "5.2.2h"); h.Measure != "Highest speed recorded vs 70 km/h limit (alarms and positions)" {
		t.Errorf("5.2.2h measure: %q", h.Measure)
	}
	for _, r := range out.Data.Rows {
		if len(r.Weeks) != 4 {
			t.Errorf("%s weeks: %d", r.Ref, len(r.Weeks))
		}
	}
	if rec := h.do("GET", "/api/v1/compliance?org=samad&from=1&to=0", admin, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("backwards period: %d", rec.Code)
	}

	// The PDF's document: the reports' letterhead, and a kind render accepts.
	doc := h.do("GET", q[:len("/api/v1/compliance")]+"/document"+q[len("/api/v1/compliance"):], admin, nil)
	var d struct{ Data ReportDoc }
	if err := json.Unmarshal(doc.Body.Bytes(), &d); err != nil || doc.Code != http.StatusOK {
		t.Fatalf("document: %d %s", doc.Code, doc.Body)
	}
	if d.Data.Kind != "compliance" || d.Data.Orientation != "landscape" || d.Data.Check() != nil {
		t.Errorf("document: %+v", d.Data)
	}
	if rec := h.do("POST", "/api/v1/reports/render?org=samad&format=csv", admin, d.Data); rec.Code != http.StatusOK {
		t.Errorf("render: %d %s", rec.Code, rec.Body)
	}
}

// Right after a start the vehicle list is not read yet: the plates come from
// the alarms themselves, and 5.1.5 says it cannot judge yet.
func TestComplianceBeforeTheVehicleList(t *testing.T) {
	e := alarm("a", 396, "no_seatbelt", at("2026-11-10", 9))
	e.Registration = "KDT953D"
	in := compInput{From: at("2026-11-10", 0), To: at("2026-11-11", 0), Now: at("2026-11-20", 0), Events: []PEvent{e}}
	rows := buildCompliance(in)
	if s := rowOf(t, rows, "5.2.2e"); mostBreaches(s) != "KDT953D 1" {
		t.Errorf("plate from the alarm: %q", mostBreaches(s))
	}
	if r := rowOf(t, rows, "5.1.5"); r.Compliance != nil || r.Result != "The units have not been read yet" {
		t.Errorf("5.1.5 with no vehicle list: %+v", r)
	}
}
