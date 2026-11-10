package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const consignURL = "/api/v1/reports/consignments?org=samad"

// One reefer trip, start to finish: entered by hand, the movement times
// found from geofence crossings, a typed time winning over GPS, and the
// report drawn to every format.
func TestReeferConsignmentTrip(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	h.store.SetVehicles([]PVehicle{{VehicleID: 7, Registration: "KDN506L"}})

	day := func(d, hm string) time.Time {
		at, _ := time.ParseInLocation("2006-01-02 15:04", d+" "+hm, fleetZone)
		return at
	}
	rec := h.do("POST", consignURL, token, map[string]any{
		"truck": "kdn 506l", "client": "KIBIDULA", "container": "mcau6035570", "seal": "MLKE0270925",
		"booking": "280617480", "zone": "MAFINGA", "size": "40", "emptyPickup": "2026-10-30",
		"stuffing": "2026-11-02", "gensetOn": "2026-11-03T17:35", "packTemp": "4.8", "midTemp": "4.9",
		"originZone": "Mombasa Empty Depot", "clientZone": "Kibidula Farm", "portZone": "Alpha Bonje",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rec.Code, rec.Body)
	}
	added := decodeData[Consignment](t, rec.Body.Bytes())
	if added.Truck != "KDN 506L" || added.Container != "MCAU6035570" || added.ID == "" {
		t.Fatalf("added: %+v", added)
	}

	h.store.AddEvents([]PEvent{
		// Before the trip: not this consignment's.
		geoEvent("g0", "geofence_exit", "exit", "Mombasa Empty Depot", 7, day("2026-10-20", "08:00")),
		geoEvent("g1", "geofence_exit", "exit", "Mombasa Empty Depot", 7, day("2026-10-30", "11:10")),
		geoEvent("g2", "geofence_entry", "entry", "Kibidula Farm", 7, day("2026-11-01", "20:50")),
		// At the port before leaving the client cannot count.
		geoEvent("g3", "geofence_exit", "exit", "Kibidula Farm", 7, day("2026-11-03", "18:00")),
		geoEvent("g4", "geofence_entry", "entry", "Alpha Bonje", 7, day("2026-11-07", "06:00")),
		geoEvent("g5", "geofence_exit", "exit", "Alpha Bonje", 7, day("2026-11-08", "10:00")),
	}, "")

	list := decodeData[struct {
		Consignments []consignView `json:"consignments"`
	}](t, h.do("GET", consignURL, token, nil).Body.Bytes()).Consignments
	if len(list) != 1 {
		t.Fatalf("list: %d", len(list))
	}
	v := list[0]
	want := map[string]string{"left": "2026-10-30T11:10", "arrivedClient": "2026-11-01T20:50",
		"arrivedPort": "2026-11-07T06:00", "departedPort": "2026-11-08T10:00"}
	for k, w := range want {
		if v.Show[k] != w {
			t.Errorf("%s: %q, want %q", k, v.Show[k], w)
		}
	}
	if len(v.FromGPS) != 4 || v.Delay != "1d 4h" {
		t.Errorf("from GPS %v, delay %q", v.FromGPS, v.Delay)
	}

	// A time typed by hand beats GPS; the GPS times are kept for the rest.
	edit := v.Consignment
	edit.ArrivedClient = "2026-11-01T21:30"
	if rec := h.do("PUT", "/api/v1/reports/consignments/"+v.ID+"?org=samad", token, edit); rec.Code != http.StatusOK {
		t.Fatalf("edit: %d %s", rec.Code, rec.Body)
	}
	v = decodeData[struct {
		Consignments []consignView `json:"consignments"`
	}](t, h.do("GET", consignURL, token, nil).Body.Bytes()).Consignments[0]
	if v.Show["arrivedClient"] != "2026-11-01T21:30" || v.Show["left"] != "2026-10-30T11:10" {
		t.Errorf("after edit: %v", v.Show)
	}

	// Saved to disk, so a restart keeps the register and what GPS found.
	if again := NewConsignments(h.cfg.DataDir).All(); len(again) != 1 || again[0].GPS.DepartedPort == "" {
		t.Errorf("reloaded: %+v", again)
	}

	doc := decodeData[ReportDoc](t, h.do("GET", "/api/v1/reports/reefer/document?org=samad", token, nil).Body.Bytes())
	if doc.Paper != "A3" || doc.Orientation != "landscape" || len(doc.Blocks) == 0 || len(doc.Blocks[0].Rows) != 1 {
		t.Fatalf("doc: paper %s %s, blocks %d", doc.Paper, doc.Orientation, len(doc.Blocks))
	}
	row := doc.Blocks[0].Rows[0]
	if row[0].Text != "KDN 506L" || row[11].Text != "30-10-26" || row[12].Text != "30-10-26 1110HRS" || row[13].Text != "01-11-26 2130HRS" ||
		row[16].Text != "03-11-26 1735HRS" || row[20].Text != "1d 4h" || row[22].Text != "4.8" {
		t.Errorf("row: %v", row)
	}
	for _, f := range []string{"pdf", "csv", "preview"} {
		if rec := h.do("POST", "/api/v1/reports/render?org=samad&format="+f, token, doc); rec.Code != http.StatusOK {
			t.Errorf("%s: %d %s", f, rec.Code, rec.Body)
		}
	}

	// Offloaded on another day: off the daily report.
	edit = v.Consignment
	edit.Offloaded = "2026-11-08"
	h.do("PUT", "/api/v1/reports/consignments/"+v.ID+"?org=samad", token, edit)
	doc = decodeData[ReportDoc](t, h.do("GET", "/api/v1/reports/reefer/document?org=samad", token, nil).Body.Bytes())
	if doc.Blocks[0].Type != "empty" {
		t.Errorf("offloaded trip still listed: %v", doc.Blocks[0])
	}

	if rec := h.do("DELETE", "/api/v1/reports/consignments/"+v.ID+"?org=samad", token, nil); rec.Code != http.StatusOK {
		t.Fatalf("delete: %d", rec.Code)
	}
	if b, _ := os.ReadFile(filepath.Join(h.cfg.DataDir, "consignments.json")); strings.Contains(string(b), "MCAU6035570") {
		t.Error("deleted consignment still on disk")
	}
}

func TestConsignmentCheck(t *testing.T) {
	for _, c := range []struct {
		n    Consignment
		want string
	}{
		{Consignment{}, "pick the truck"},
		{Consignment{Truck: "KDN506L", GensetOn: "3-11-2026"}, "Genset on"},
		{Consignment{Truck: "KDN506L", PackTemp: "hot"}, "Pack-house"},
		{Consignment{Truck: "KDN506L", MidTemp: "90"}, "Mid-stop"},
		{Consignment{Truck: "KDN506L", PortTemp: "4.4°C", Left: "2026-10-30"}, ""},
	} {
		err := c.n.check()
		if (err == nil) != (c.want == "") || err != nil && !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: %v, want %q", c.n, err, c.want)
		}
	}
}

// A role without operations rights reads the register but cannot change it.
func TestConsignmentsNeedOperations(t *testing.T) {
	h := newHarness(t)
	admin, _ := h.login()
	_, tok := h.invite(admin, "hr@samad.test", "hr")
	if rec := h.do("POST", consignURL, tok, map[string]any{"truck": "KDN506L"}); rec.Code != http.StatusForbidden {
		t.Errorf("hr add: %d", rec.Code)
	}
}
