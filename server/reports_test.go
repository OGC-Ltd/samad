package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func geoEvent(id, typ, action, zone string, veh int, at time.Time) PEvent {
	e := PEvent{EventID: id, Source: "platform", Type: typ, Severity: "informational", OccurredAt: at.UTC().Format(time.RFC3339), VehicleID: veh, Registration: "KDA1"}
	e.Geofence = &struct {
		ZoneID   int    `json:"zone_id"`
		ZoneName string `json:"zone_name"`
		Action   string `json:"action"`
	}{ZoneName: zone, Action: action}
	return e
}

func TestReportKind(t *testing.T) {
	cases := map[string]string{
		"over_speeding": "overspeed", "geofence_speeding": "overspeed", "harsh_braking": "harsh_braking",
		"harsh_acceleration": "harsh_acceleration", "no_seatbelt": "no_seatbelt", "phone_use": "phone",
		"road_facing_camera_occlusion": "camera_covered", "lane_departure": "other",
	}
	for typ, want := range cases {
		if got := reportKind(PEvent{Type: typ, Severity: "warning"}); got != want {
			t.Errorf("%s: got %s want %s", typ, got, want)
		}
	}
	if got := reportKind(PEvent{Type: "forward_collision", Severity: "critical"}); got != "critical" {
		t.Errorf("critical: %s", got)
	}
	if got := reportKind(geoEvent("g", "geofence_entry", "entry", "Yard", 1, time.Now())); got != "geofence" {
		t.Errorf("geofence: %s", got)
	}
}

func TestCrossing(t *testing.T) {
	for typ, want := range map[string]string{"geofence_entry": "entry", "geofence_exit": "exit"} {
		if got := crossing(PEvent{Type: typ}); got != want {
			t.Errorf("%s: %s", typ, got)
		}
	}
	if got := crossing(geoEvent("g", "geofence_entry", "exit", "Yard", 1, time.Now())); got != "exit" {
		t.Errorf("action wins: %s", got)
	}
}

func TestInsideZone(t *testing.T) {
	r := 500.0
	c := PGeofence{Name: "Yard", Center: &struct {
		Lat float64 `json:"lat"`
		Lng float64 `json:"lng"`
	}{-4.0, 39.6}, RadiusM: &r}
	if !insideZone(c, -4.002, 39.6) || insideZone(c, -4.02, 39.6) {
		t.Error("circle")
	}
	p := PGeofence{Name: "Box"}
	p.Coordinates = &struct {
		Points []struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"points"`
	}{}
	for _, pt := range [][2]float64{{0, 0}, {0, 1}, {1, 1}, {1, 0}} {
		p.Coordinates.Points = append(p.Coordinates.Points, struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		}{pt[0], pt[1]})
	}
	if !insideZone(p, 0.5, 0.5) || insideZone(p, 1.5, 0.5) {
		t.Error("polygon")
	}
	in, near, km := whereNow([]PGeofence{c, p}, -4.1, 39.6)
	if in != "" || near != "Yard" || km < 10 || km > 12 {
		t.Errorf("nearest: %q %q %v", in, near, km)
	}
}

func TestReportFleetRoute(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	now := time.Now()
	h.store.AddEvents([]PEvent{
		geoEvent("old-exit", "geofence_exit", "exit", "Mombasa Yard", 7, now.Add(-72*time.Hour)),
		{EventID: "sb", Source: "device", Type: "no_seatbelt", Severity: "critical", OccurredAt: now.Add(-time.Hour).UTC().Format(time.RFC3339), VehicleID: 7},
		{EventID: "ln", Source: "device", Type: "lane_departure", Severity: "warning", OccurredAt: now.Add(-time.Hour).UTC().Format(time.RFC3339), VehicleID: 7},
	}, "")
	from := strconv.FormatInt(now.Add(-24*time.Hour).UnixMilli(), 10)
	rec := h.do("GET", "/api/v1/reports/fleet?org=samad&from="+from, token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("report: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Data struct {
			Events []map[string]any `json:"events"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Data.Events) != 1 || out.Data.Events[0]["kind"] != "no_seatbelt" {
		t.Errorf("events: %v", out.Data.Events)
	}
	long := strconv.FormatInt(now.Add(-40*24*time.Hour).UnixMilli(), 10)
	if rec := h.do("GET", "/api/v1/reports/fleet?org=samad&from="+long, token, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("40 days: %d", rec.Code)
	}
	if rec := h.do("GET", "/api/v1/reports/fleet?org=samad", "", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("signed out: %d", rec.Code)
	}
}
