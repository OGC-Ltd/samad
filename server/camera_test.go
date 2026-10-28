package main

import (
	"net/http"
	"testing"
	"time"
)

func TestVehicleCamera(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	h.store.SetVehicles([]PVehicle{{VehicleID: 7, Registration: "KDN506L"}, {VehicleID: 8, Registration: "KDY270P"}})
	h.store.AddEvents([]PEvent{{EventID: "e1", VehicleID: 7, Source: "device"}}, "")

	base := "/api/v1/organisations/samad/vehicles/"
	for id, want := range map[string]string{"7": "not_configured", "8": "no_camera"} {
		rec := h.do("GET", base+id+"/camera", token, nil)
		got := decodeData[map[string]any](t, rec.Body.Bytes())
		if rec.Code != http.StatusOK || got["state"] != want {
			t.Errorf("vehicle %s: %d %v, want %s", id, rec.Code, got, want)
		}
	}
	if rec := h.do("GET", base+"99/camera", token, nil); rec.Code != http.StatusNotFound {
		t.Errorf("unknown vehicle: %d", rec.Code)
	}
}

// The driver panel reads details[id]: who, the window's totals and the overspeeds.
func TestDriverDetails(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	h.store.SetVehicles([]PVehicle{{VehicleID: 7, Registration: "KDN506L", Driver: &PPerson{ID: 3, Name: "MOSES WANYONYI"}}})
	now := time.Now().UTC().Format(time.RFC3339)
	h.store.AddEvents([]PEvent{{EventID: "s1", VehicleID: 7, Type: "over_speeding", OccurredAt: now}}, "")

	out := decodeData[struct {
		Details map[string]struct {
			Driver    map[string]any
			Totals    map[string]any
			Incidents struct{ Overspeeds []map[string]any }
		}
	}](t, h.do("GET", "/api/v1/organisations/samad/analytics/drivers/overview", token, nil).Body.Bytes())
	d, ok := out.Details["d-3"]
	if !ok || d.Driver["fullName"] != "MOSES WANYONYI" || d.Totals["windowDays"].(float64) != 90 ||
		d.Totals["overspeedingCases"].(float64) != 1 || len(d.Incidents.Overspeeds) != 1 || d.Incidents.Overspeeds[0]["plate"] != "KDN506L" {
		t.Fatalf("details %+v", out.Details)
	}
}
