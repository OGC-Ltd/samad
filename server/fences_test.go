package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

var fenceNow = time.Date(2026, 11, 26, 9, 0, 0, 0, time.UTC)

// The depot: about 500 m by 390 m.
func depotRing() [][]float64 {
	return [][]float64{{36.8500, -1.3090}, {36.8545, -1.3090}, {36.8545, -1.3125}, {36.8500, -1.3125}, {36.8500, -1.3090}}
}

func ptr[T any](v T) *T { return &v }

func rawColour(s *string) *json.RawMessage {
	b, _ := json.Marshal(s)
	m := json.RawMessage(b)
	return &m
}

func TestFenceShapesAndChecks(t *testing.T) {
	f := NewFences(t.TempDir())
	poly, err := f.Create(fenceBody{Name: ptr(" Depot "), Purpose: ptr("yard"), Type: ptr("POLYGON"),
		PolygonCoords: depotRing()[:4]}, "Tester", fenceNow) // sent open: stored closed
	if err != nil {
		t.Fatal(err)
	}
	if poly.Name != "Depot" || len(poly.Coords) != 5 || poly.Coords[0] != poly.Coords[4] || poly.ID == "" {
		t.Fatalf("polygon: %+v", poly)
	}
	if ha := poly.areaHa(); math.Abs(ha-19.5) > 0.5 {
		t.Errorf("depot area %.2f ha, want about 19.5", ha)
	}
	circle, err := f.Create(fenceBody{Name: ptr("Yard"), Purpose: ptr("parking"), Type: ptr("circle"),
		CenterLat: ptr(-1.456), CenterLng: ptr(36.978), RadiusM: ptr(300.4)}, "Tester", fenceNow)
	if err != nil || circle.Type != "CIRCLE" || circle.RadiusM != 300 {
		t.Fatalf("circle: %+v %v", circle, err)
	}
	road, err := f.Create(fenceBody{Name: ptr("Mombasa Rd"), Purpose: ptr("road"), Type: ptr("LINE"),
		PolygonCoords: [][]float64{{36.856, -1.32}, {36.87, -1.333}}, WidthM: ptr(20.0)}, "Tester", fenceNow)
	if err != nil || road.WidthM != 20 || len(road.Coords) != 2 {
		t.Fatalf("road: %+v %v", road, err)
	}

	bad := []struct {
		name string
		b    fenceBody
		want string
	}{
		{"no name", fenceBody{Name: ptr("  "), Purpose: ptr("yard"), Type: ptr("POLYGON"), PolygonCoords: depotRing()}, "name"},
		{"no purpose", fenceBody{Name: ptr("x"), Type: ptr("POLYGON"), PolygonCoords: depotRing()}, "for"},
		{"odd purpose", fenceBody{Name: ptr("x"), Purpose: ptr("farm"), Type: ptr("POLYGON"), PolygonCoords: depotRing()}, "for"},
		{"no shape", fenceBody{Name: ptr("x"), Purpose: ptr("yard")}, "shape"},
		{"two corners", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Type: ptr("POLYGON"), PolygonCoords: [][]float64{{36, -1}, {36.1, -1}, {36, -1}}}, "3 different"},
		{"off Earth", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Type: ptr("POLYGON"), PolygonCoords: [][]float64{{36, -1}, {36.1, -1}, {36, 91}}}, "on Earth"},
		{"lat lng swapped wrong", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Type: ptr("POLYGON"), PolygonCoords: [][]float64{{36}, {36.1, -1}, {36, -1.1}}}, "on Earth"},
		{"tiny circle", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Type: ptr("CIRCLE"), CenterLat: ptr(-1.0), CenterLng: ptr(36.0), RadiusM: ptr(5.0)}, "radius"},
		{"circle no centre", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Type: ptr("CIRCLE"), RadiusM: ptr(50.0)}, "centre"},
		{"road no width", fenceBody{Name: ptr("x"), Purpose: ptr("road"), Type: ptr("LINE"), PolygonCoords: [][]float64{{36, -1}, {36.1, -1}}}, "width"},
		{"bad colour", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Color: rawColour(ptr("red")), Type: ptr("POLYGON"), PolygonCoords: depotRing()}, "colour"},
		{"bad type", fenceBody{Name: ptr("x"), Purpose: ptr("yard"), Type: ptr("HEXAGON")}, "POLYGON"},
	}
	for _, c := range bad {
		_, err := f.Create(c.b, "Tester", fenceNow)
		var bf badFence
		if err == nil || !strings.Contains(err.Error(), c.want) || !errorsAs(err, &bf) {
			t.Errorf("%s: got %v, want a bad-fence error about %q", c.name, err, c.want)
		}
	}
	if n := len(f.Live()); n != 3 {
		t.Errorf("%d fences kept, want 3 (the bad ones not)", n)
	}
}

func errorsAs(err error, bf *badFence) bool {
	b, ok := err.(badFence)
	if ok {
		*bf = b
	}
	return ok
}

func TestFenceChangeRemoveAndReload(t *testing.T) {
	dir := t.TempDir()
	f := NewFences(dir)
	x, err := f.Create(fenceBody{Name: ptr("Depot"), Purpose: ptr("yard"), Color: rawColour(ptr("#DC2626")), Type: ptr("POLYGON"),
		PolygonCoords: depotRing()}, "Ann", fenceNow)
	if err != nil || x.Color != "#dc2626" {
		t.Fatalf("%+v %v", x, err)
	}
	// A change of name only keeps the shape and colour; who and when move on.
	later := fenceNow.Add(time.Hour)
	y, err := f.Update(x.ID, fenceBody{Name: ptr("Main depot")}, "Bob", later)
	if err != nil || y.Name != "Main depot" || len(y.Coords) != 5 || y.Color != "#dc2626" || y.CreatedBy != "Ann" || y.UpdatedBy != "Bob" {
		t.Fatalf("rename: %+v %v", y, err)
	}
	// color: null clears it.
	if y, err = f.Update(x.ID, fenceBody{Color: rawColour(nil)}, "Bob", later); err != nil || y.Color != "" {
		t.Fatalf("clear colour: %+v %v", y, err)
	}
	// A bad change leaves the fence as it was.
	if _, err := f.Update(x.ID, fenceBody{Name: ptr("New"), Type: ptr("CIRCLE")}, "Bob", later); err == nil {
		t.Fatal("a circle with no centre was saved")
	}
	if got := f.Live()[0]; got.Name != "Main depot" || got.Type != "POLYGON" {
		t.Fatalf("after a refused change: %+v", got)
	}
	// Reshaped into a circle.
	if y, err = f.Update(x.ID, fenceBody{Type: ptr("CIRCLE"), CenterLat: ptr(-1.31), CenterLng: ptr(36.85), RadiusM: ptr(250.0)}, "Bob", later); err != nil || y.Type != "CIRCLE" || y.Coords != nil {
		t.Fatalf("reshape: %+v %v", y, err)
	}

	// Saved to disk: a new server sees it.
	if g := NewFences(dir).Live(); len(g) != 1 || g[0].Type != "CIRCLE" || g[0].UpdatedBy != "Bob" {
		t.Fatalf("reloaded: %+v", g)
	}

	// Removed: off the list, kept in the file, and not changeable.
	if err := f.Remove(x.ID, "Cat", later); err != nil {
		t.Fatal(err)
	}
	if len(f.Live()) != 0 {
		t.Fatal("a removed fence is still listed")
	}
	if err := f.Remove(x.ID, "Cat", later); err != errNoFence {
		t.Fatalf("second removal: %v", err)
	}
	if _, err := f.Update(x.ID, fenceBody{Name: ptr("x")}, "Cat", later); err != errNoFence {
		t.Fatalf("change after removal: %v", err)
	}
	g := NewFences(dir)
	if len(g.list) != 1 || g.list[0].RemovedBy != "Cat" || g.list[0].RemovedAt == "" {
		t.Fatalf("the file should keep the removed fence: %+v", g.list)
	}
}

// Over HTTP: drawn, shown beside the partner's, changed, removed.
func TestFenceEndpoints(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	h.store.SetGeofences([]PGeofence{{ZoneID: 501, Name: "Partner depot", ZoneType: "circle", Status: "active",
		Center: &struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		}{-1.3, 36.8}, RadiusM: ptr(200.0)}})

	rec := h.do("POST", "/api/v1/organisations/samad/geofences", token, map[string]any{
		"name": "Depot", "purpose": "yard", "mode": "ALLOWLIST", "type": "POLYGON", "polygonCoords": depotRing()})
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var made struct {
		Data struct {
			Properties map[string]any `json:"properties"`
		} `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &made)
	id, _ := made.Data.Properties["id"].(string)
	if id == "" || made.Data.Properties["source"] != "samad" || made.Data.Properties["createdBy"] != "Test" {
		t.Fatalf("created: %s", rec.Body)
	}

	if rec = h.do("POST", "/api/v1/organisations/samad/geofences", token, map[string]any{"name": "x", "purpose": "yard", "type": "POLYGON"}); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "A shape needs") {
		t.Fatalf("bad create: %d %s", rec.Code, rec.Body)
	}

	geo := func() []map[string]any {
		rec := h.do("GET", "/api/v1/organisations/samad/geofences/geojson", token, nil)
		var out struct {
			Data struct {
				Features []map[string]any `json:"features"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != http.StatusOK {
			t.Fatalf("geojson: %d %s", rec.Code, rec.Body)
		}
		return out.Data.Features
	}
	fs := geo()
	if len(fs) != 2 || fs[0]["properties"].(map[string]any)["source"] != "provider" || fs[1]["properties"].(map[string]any)["id"] != id {
		t.Fatalf("geojson features: %v", fs)
	}
	if g := fs[1]["geometry"].(map[string]any); g["type"] != "Polygon" {
		t.Fatalf("drawn geometry: %v", g)
	}

	if rec = h.do("PATCH", "/api/v1/organisations/samad/geofences/"+id, token, map[string]any{"name": "Main depot", "color": nil}); rec.Code != http.StatusOK {
		t.Fatalf("change: %d %s", rec.Code, rec.Body)
	}
	if n := geo()[1]["properties"].(map[string]any)["name"]; n != "Main depot" {
		t.Fatalf("renamed: %v", n)
	}
	// The partner's fences are not ours to change.
	if rec = h.do("PATCH", "/api/v1/organisations/samad/geofences/501", token, map[string]any{"name": "x"}); rec.Code != http.StatusNotFound {
		t.Fatalf("partner fence change: %d", rec.Code)
	}
	if rec = h.do("DELETE", "/api/v1/organisations/samad/geofences/"+id, token, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("remove: %d %s", rec.Code, rec.Body)
	}
	if fs := geo(); len(fs) != 1 {
		t.Fatalf("after removal: %v", fs)
	}
	// Another organisation's path is refused.
	if rec = h.do("POST", "/api/v1/organisations/other/geofences", token, map[string]any{}); rec.Code == http.StatusOK {
		t.Fatalf("other org: %d", rec.Code)
	}
	// Signed out: refused.
	if rec = h.do("POST", "/api/v1/organisations/samad/geofences", "", map[string]any{}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", rec.Code)
	}
}

// Anyone signed in may draw: every role that has the map (where fences are
// drawn) holds the geofence permissions. Roles with no map (HR, accounts)
// have no place to draw one.
func TestEveryRoleMayDrawFences(t *testing.T) {
	n := 0
	for _, r := range roleDefs {
		if !holds(r.Permissions, "map:read") {
			continue
		}
		n++
		for _, p := range []string{"geofence:create", "geofence:update", "geofence:delete"} {
			if !holds(r.Permissions, p) {
				t.Errorf("role %s has the map but lacks %s", r.Slug, p)
			}
		}
	}
	if n < 10 {
		t.Fatalf("only %d roles have the map", n)
	}
}
