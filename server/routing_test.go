package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeGoogle answers computeRoutes, computeRouteMatrix and weather lookups,
// counting the calls.
func fakeGoogle(t *testing.T) (*Google, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var routes, weather atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/directions/v2:computeRoutes":
			if r.Header.Get("X-Goog-Api-Key") != "k" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"message":"API key not valid"}}`))
				return
			}
			routes.Add(1)
			_, _ = w.Write([]byte(`{"routes":[{"distanceMeters":1200,"duration":"300s","staticDuration":"240s","polyline":{"encodedPolyline":"_p~iF~ps|U_ulLnnqC_mqNvxq` + "`" + `@"}}]}`))
		case r.URL.Path == "/distanceMatrix/v2:computeRouteMatrix":
			_, _ = w.Write([]byte(`[{"originIndex":0,"duration":"900s","staticDuration":"800s","distanceMeters":9000,"condition":"ROUTE_EXISTS"}]`))
		case strings.HasPrefix(r.URL.Path, "/v1/currentConditions:lookup"):
			weather.Add(1)
			_, _ = w.Write([]byte(`{"weatherCondition":{"type":"LIGHT_RAIN","description":{"text":"Light rain"}},"temperature":{"degrees":21.5},"precipitation":{"probability":{"percent":60}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	g := NewGoogle("k")
	g.routesBase, g.weatherBase = srv.URL, srv.URL
	return g, &routes, &weather
}

func TestDecodePolyline(t *testing.T) {
	// Google's documented example.
	got := decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
	want := [][2]float64{{38.5, -120.2}, {40.7, -120.95}, {43.252, -126.453}}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("point %d: %v, want %v", i, got[i], want[i])
		}
	}
}

func TestRoutingAndWeather(t *testing.T) {
	h := newHarness(t)
	g, routeCalls, weather := fakeGoogle(t)
	srv := &Server{cfg: h.cfg, store: h.store, hub: NewHub(), routing: NewRouting(g, h.store)}
	h.h = routes(srv, h.auth)
	token, _ := h.login()

	now := time.Now().UTC().Format(time.RFC3339)
	h.store.SetVehicles([]PVehicle{{VehicleID: 7, Registration: "KDN506L"}})
	h.store.ApplyPositions([]PVehicle{{VehicleID: 7, Registration: "KDN506L", Position: &PPosition{Latitude: 0.5, Longitude: 34.5, LastUpdate: now}}})
	h.store.SetGeofences([]PGeofence{{ZoneID: 1, Name: "Bungoma Yard", Center: &struct {
		Lat float64 `json:"lat"`
		Lng float64 `json:"lng"`
	}{0.56, 34.56}}})

	base := "/api/v1/organisations/samad"
	// No destination: says so rather than guessing one.
	var ra map[string]any
	ra = decodeData[map[string]any](t, h.do("GET", base+"/vehicles/7/route-ahead", token, nil).Body.Bytes())
	if ra["enabled"] != true || ra["route"] != nil || !strings.Contains(ra["reason"].(string), "Pick one") {
		t.Fatalf("no destination: %v", ra)
	}
	// A picked point: Google's road, with a traffic ETA; asked again, cached.
	for range 2 {
		rec := h.do("GET", base+"/vehicles/7/route-ahead?destLat=0.6&destLng=34.6&destName=Mill", token, nil)
		ra = decodeData[map[string]any](t, rec.Body.Bytes())
	}
	if ra["route"] == nil || ra["etaAt"] == nil || routeCalls.Load() != 1 {
		t.Fatalf("route %v (%d calls)", ra, routeCalls.Load())
	}
	if rec := h.do("GET", base+"/vehicles/7/route-ahead?destLat=0.6", token, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("half a destination: %d", rec.Code)
	}

	// Weather: a grid over the view, each point asked once.
	q := "?south=0.4&west=34.4&north=0.6&east=34.6"
	for range 2 {
		h.do("GET", base+"/weather/grid"+q, token, nil)
	}
	wg := decodeData[struct {
		Enabled bool
		Step    float64
		Points  []weatherPoint
	}](t, h.do("GET", base+"/weather/grid"+q, token, nil).Body.Bytes())
	if !wg.Enabled || wg.Step != 0.05 || len(wg.Points) == 0 || wg.Points[0].Type != "LIGHT_RAIN" || int(weather.Load()) != len(wg.Points) {
		t.Fatalf("weather %+v (%d lookups)", wg, weather.Load())
	}

	// Hubs from the geofences, and the drive time from every unit to one.
	hubs := decodeData[struct {
		Enabled bool
		Hubs    []hub
		Classes map[string]int
	}](t, h.do("GET", base+"/routing/hubs", token, nil).Body.Bytes())
	if !hubs.Enabled || len(hubs.Hubs) != 1 || hubs.Hubs[0].Key != "yard-bungoma-yard" || hubs.Classes["TRUCK"] != 1 {
		t.Fatalf("hubs %+v", hubs)
	}
	in := decodeData[map[string]any](t, h.do("GET", base+"/routing/hubs/yard-bungoma-yard/inbound", token, nil).Body.Bytes())
	units, _ := in["units"].([]any)
	if len(units) != 1 || units[0].(map[string]any)["etaS"].(float64) != 900 || units[0].(map[string]any)["withinMin"].(float64) != 15 {
		b, _ := json.Marshal(in)
		t.Fatalf("inbound %s", b)
	}
}

func TestRoutingWithoutKey(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	for _, p := range []string{"/routing/hubs", "/weather/grid?south=0&west=0&north=1&east=1", "/routing/status"} {
		out := decodeData[map[string]any](t, h.do("GET", "/api/v1/organisations/samad"+p, token, nil).Body.Bytes())
		if out["enabled"] != false {
			t.Errorf("%s without a key: %v", p, out)
		}
	}
}

func TestGoogleKeyOrder(t *testing.T) {
	defer func(k string) { builtGoogleKey = k }(builtGoogleKey)
	builtGoogleKey = "built"
	for _, c := range []struct {
		cfg  Config
		want string
	}{
		{Config{GoogleRoutingAPIKey: "routing", GoogleMapsAPIKey: "maps"}, "routing"},
		{Config{GoogleMapsAPIKey: "maps"}, "maps"},
		{Config{}, "built"},
	} {
		if got := c.cfg.GoogleKey(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.cfg, got, c.want)
		}
	}
}
