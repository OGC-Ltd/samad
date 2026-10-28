package main

// Weather over the map, the road ahead of a unit, and arrivals at a hub:
// fleet-server's route-ahead module (route-ahead.routes.ts, route-ahead.service.ts,
// hub-arrivals.ts) and its weather grid, in the same shapes, on google.go.
//
// What Samad lacks changes three things. There are no dispatches, so a
// unit's road ahead runs only to a point picked on the map, and no arrival is
// "dispatched" or "returning". The hubs are the partner's geofences. And no
// unit class has a measured speed yet, so Google's drive time is used as it is.
//
// Every Google call is billed, so answers are cached as fleet-server caches
// them, and concurrent asks for one answer share one request.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

const (
	routeMinAge  = 30 * time.Second // never re-asked sooner
	routeMaxAge  = 3 * time.Minute
	routeReuseM  = 250.0 // moved less than this: the cached route stands
	arrivedM     = 300.0 // this close to the destination is there
	weatherTTL   = 15 * time.Minute
	weatherPar   = 6
	cellsAcross  = 5
	matrixTTL    = 2 * time.Minute
	freshFix     = 6 * time.Hour    // older fixes are not routed
	availableFix = 30 * time.Minute // a free unit has reported within this
	farM         = 250_000.0        // further than this is left out
	atHubM       = 500.0            // inside this the unit is at the hub
	bandFromMin  = 60
)

var (
	weatherSteps   = []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5}
	arrivalMinutes = []int{15, 30, 60}
)

// Routing holds the Google client and the caches.
type Routing struct {
	g     *Google
	store *Store

	mu       sync.Mutex
	routes   map[int]routeEntry
	weather  map[string]weatherEntry
	matrices map[string]matrixEntry
	inflight map[string]*call
}

type routeEntry struct {
	destKey string
	origin  latLng
	at      time.Time
	route   *roadRoute
}

type weatherEntry struct {
	at    time.Time
	point *weatherPoint
}

type matrixEntry struct {
	at  time.Time
	out map[string]any
}

type call struct {
	done chan struct{}
	val  any
	err  error
}

func NewRouting(g *Google, store *Store) *Routing {
	return &Routing{
		g: g, store: store,
		routes: map[int]routeEntry{}, weather: map[string]weatherEntry{},
		matrices: map[string]matrixEntry{}, inflight: map[string]*call{},
	}
}

func (rt *Routing) enabled() bool { return rt != nil && rt.g != nil }

// shared runs f once for concurrent callers asking the same key.
func (rt *Routing) shared(key string, f func() (any, error)) (any, error) {
	rt.mu.Lock()
	if c, ok := rt.inflight[key]; ok {
		rt.mu.Unlock()
		<-c.done
		return c.val, c.err
	}
	c := &call{done: make(chan struct{})}
	rt.inflight[key] = c
	rt.mu.Unlock()
	c.val, c.err = f()
	rt.mu.Lock()
	delete(rt.inflight, key)
	rt.mu.Unlock()
	close(c.done)
	return c.val, c.err
}

func distM(a, b latLng) float64 { return haversineKm(a.Lat, a.Lng, b.Lat, b.Lng) * 1000 }

// googleFailed answers a Google failure as fleet-server does: 502 with
// Google's own words, 504 for a timeout.
func googleFailed(w http.ResponseWriter, err error) {
	var ge *GoogleError
	switch {
	case errors.As(err, &ge):
		log.Printf("google refused: %d %s", ge.Status, ge.Msg)
		writeError(w, http.StatusBadGateway, "Google: "+ge.Msg)
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Client.Timeout"):
		writeError(w, http.StatusGatewayTimeout, "Google did not answer in time")
	default:
		log.Printf("google: %v", err)
		writeError(w, http.StatusBadGateway, "Google could not be reached")
	}
}

func queryFloat(r *http.Request, k string, lo, hi float64) (float64, bool, error) {
	s := r.URL.Query().Get(k)
	if s == "" {
		return 0, false, nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || f < lo || f > hi {
		return 0, true, fmt.Errorf("%s: a number from %g to %g", k, lo, hi)
	}
	return f, true, nil
}

// ── routing status ──

func (rt *Routing) status(w http.ResponseWriter, _ *http.Request) {
	writeData(w, map[string]any{"enabled": rt.enabled()})
}

// ── weather ──

type cell struct {
	i, j     int
	lat, lng float64
}

// gridFor is the finest grid keeping the view to at most cellsAcross cells a
// side; cells are snapped, so everyone looking at an area asks the same points.
func gridFor(south, west, north, east float64) (float64, []cell) {
	span := math.Max(north-south, east-west)
	step := weatherSteps[len(weatherSteps)-1]
	for _, s := range weatherSteps {
		if span/s <= cellsAcross {
			step = s
			break
		}
	}
	var cells []cell
	for i := int(math.Floor(south / step)); i <= int(math.Floor(north/step)); i++ {
		for j := int(math.Floor(west / step)); j <= int(math.Floor(east/step)); j++ {
			lat := math.Round((float64(i)+0.5)*step*1e4) / 1e4
			lng := math.Round((float64(j)+0.5)*step*1e4) / 1e4
			if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
				continue
			}
			cells = append(cells, cell{i, j, lat, lng})
		}
	}
	return step, cells
}

func (rt *Routing) conditions(ctx context.Context, step float64, c cell) *weatherPoint {
	key := fmt.Sprintf("%g:%d:%d", step, c.i, c.j)
	rt.mu.Lock()
	hit, ok := rt.weather[key]
	rt.mu.Unlock()
	if ok && time.Since(hit.at) < weatherTTL {
		return hit.point
	}
	v, err := rt.shared("weather:"+key, func() (any, error) {
		p, err := rt.g.Conditions(ctx, c.lat, c.lng)
		var ge *GoogleError
		if errors.As(err, &ge) {
			// Google has no conditions for some places; not worth a retry.
			log.Printf("google weather: refused at %g,%g: %s", c.lat, c.lng, ge.Msg)
			p, err = nil, nil
		}
		if err != nil {
			return nil, err
		}
		rt.mu.Lock()
		rt.weather[key] = weatherEntry{at: time.Now(), point: p}
		rt.mu.Unlock()
		return p, nil
	})
	if err != nil {
		log.Printf("google weather: %v", err)
		return hit.point // the last answer, however old, beats none
	}
	p, _ := v.(*weatherPoint)
	return p
}

func (rt *Routing) weatherGrid(w http.ResponseWriter, r *http.Request) {
	if !rt.enabled() {
		writeData(w, map[string]any{"enabled": false, "step": nil, "points": []any{}})
		return
	}
	var b [4]float64
	for i, k := range []string{"south", "west", "north", "east"} {
		lim := 90.0
		if k == "west" || k == "east" {
			lim = 180
		}
		f, ok, err := queryFloat(r, k, -lim, lim)
		if err == nil && !ok {
			err = fmt.Errorf("%s is required", k)
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		b[i] = f
	}
	if b[2] <= b[0] || b[3] <= b[1] {
		writeError(w, http.StatusBadRequest, "bounds: north above south, east of west")
		return
	}
	step, cells := gridFor(b[0], b[1], b[2], b[3])
	out := make([]*weatherPoint, len(cells))
	var wg sync.WaitGroup
	next := make(chan int)
	for range min(weatherPar, len(cells)) {
		wg.Go(func() {
			for k := range next {
				out[k] = rt.conditions(r.Context(), step, cells[k])
			}
		})
	}
	for k := range cells {
		next <- k
	}
	close(next)
	wg.Wait()
	points := []*weatherPoint{}
	for _, p := range out {
		if p != nil {
			points = append(points, p)
		}
	}
	writeData(w, map[string]any{"enabled": true, "step": step, "points": points})
}

// ── the road ahead of one unit ──

func fixOf(v PVehicle) (latLng, string, bool) {
	p := v.Position
	if p == nil || (p.Latitude == 0 && p.Longitude == 0) {
		return latLng{}, "", false
	}
	return latLng{p.Latitude, p.Longitude}, p.LastUpdate, true
}

func (rt *Routing) routeAhead(s *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rt.enabled() {
			writeData(w, map[string]any{"enabled": false})
			return
		}
		v, ok := s.vehicleParam(w, r)
		if !ok {
			return
		}
		lat, hasLat, err1 := queryFloat(r, "destLat", -90, 90)
		lng, hasLng, err2 := queryFloat(r, "destLng", -180, 180)
		if err := errors.Join(err1, err2); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if hasLat != hasLng {
			writeError(w, http.StatusBadRequest, "destLat and destLng go together")
			return
		}
		var origin any
		o, fixAt, hasFix := fixOf(v)
		if hasFix {
			origin = map[string]any{"lat": o.Lat, "lng": o.Lng, "fixAt": fixAt}
		}
		var dest any
		d := latLng{lat, lng}
		if hasLat {
			name := strings.TrimSpace(r.URL.Query().Get("destName"))
			var n any
			if name != "" {
				n = name[:min(len(name), 80)]
			}
			dest = map[string]any{"lat": lat, "lng": lng, "name": n, "source": "custom"}
		}
		none := func(reason string, arrived bool) {
			writeData(w, map[string]any{
				"enabled": true, "origin": origin, "destination": dest, "route": nil,
				"etaAt": nil, "computedAt": nil, "arrived": arrived, "reason": reason,
			})
		}
		switch {
		case !hasFix:
			none("This unit has no position yet.", false)
			return
		case !hasLat:
			none("No destination: Samad has no dispatches yet. Pick one on the map.", false)
			return
		case distM(o, d) < arrivedM:
			none("At the destination.", true)
			return
		}

		destKey := fmt.Sprintf("%.5f,%.5f", d.Lat, d.Lng)
		rt.mu.Lock()
		e, had := rt.routes[v.VehicleID]
		rt.mu.Unlock()
		age := time.Since(e.at)
		reuse := had && e.destKey == destKey && (age < routeMinAge || (age < routeMaxAge && distM(e.origin, o) < routeReuseM))
		if !reuse {
			val, err := rt.shared(fmt.Sprintf("route:%d:%s", v.VehicleID, destKey), func() (any, error) {
				return rt.g.Route(r.Context(), o, d)
			})
			if err != nil {
				googleFailed(w, err)
				return
			}
			route, _ := val.(*roadRoute)
			e = routeEntry{destKey: destKey, origin: o, at: time.Now(), route: route}
			rt.mu.Lock()
			rt.routes[v.VehicleID] = e
			rt.mu.Unlock()
		}
		if e.route == nil {
			none("Google found no road route to this destination.", false)
			return
		}
		writeData(w, map[string]any{
			"enabled": true, "origin": origin, "destination": dest, "route": e.route,
			"etaAt":      e.at.Add(time.Duration(e.route.DurationS * float64(time.Second))).UTC().Format(time.RFC3339),
			"computedAt": e.at.UTC().Format(time.RFC3339), "arrived": false, "reason": nil,
		})
	}
}

// ── arrivals at a hub ──

type hub struct {
	Key  string  `json:"key"`
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
	Kind string  `json:"kind"`
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// hubs are the partner's geofences: a circle's centre, a polygon's centroid.
func (rt *Routing) hubs() []hub {
	var out []hub
	for _, g := range rt.store.Geofences() {
		var p latLng
		switch {
		case g.Center != nil:
			p = latLng{g.Center.Lat, g.Center.Lng}
		case g.Coordinates != nil && len(g.Coordinates.Points) > 0:
			for _, q := range g.Coordinates.Points {
				p.Lat += q.Lat
				p.Lng += q.Lng
			}
			n := float64(len(g.Coordinates.Points))
			p = latLng{p.Lat / n, p.Lng / n}
		default:
			continue
		}
		name := strings.TrimSpace(g.Name)
		if name == "" || slices.ContainsFunc(out, func(h hub) bool { return distM(latLng{h.Lat, h.Lng}, p) < 1000 }) {
			continue
		}
		key := "yard-" + strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
		for slices.ContainsFunc(out, func(h hub) bool { return h.Key == key }) {
			key += "-2"
		}
		out = append(out, hub{Key: key, Name: name, Lat: p.Lat, Lng: p.Lng, Kind: "yard"})
	}
	return out
}

// unitClass is fleet-server's class from the vehicle type alone.
func unitClass(v PVehicle) string {
	switch vehicleType(v) {
	case "TRUCK", "LORRY":
		return "TRUCK"
	case "TRACTOR":
		return "TRACTOR"
	case "MOTORCYCLE", "MOTORBIKE":
		return "MOTORBIKE"
	case "GENERATOR":
		return "FIXED"
	default:
		return "CAR"
	}
}

func inClass(c, cls string) bool {
	switch {
	case c == "FIXED":
		return false
	case cls == "all" || cls == "MOTORBIKE":
		return true
	case cls == "VEHICLE":
		return c == "TRUCK" || c == "CAR"
	}
	return c == cls
}

func (rt *Routing) classCounts() map[string]int {
	out := map[string]int{"TRACTOR": 0, "TRUCK": 0, "CAR": 0, "PLANT": 0, "VEHICLE": 0}
	for _, v := range rt.store.Vehicles() {
		for w := range out {
			if inClass(unitClass(v), w) {
				out[w]++
			}
		}
	}
	return out
}

func (rt *Routing) listHubs(w http.ResponseWriter, _ *http.Request) {
	writeData(w, map[string]any{"enabled": rt.enabled(), "hubs": rt.hubs(), "classes": rt.classCounts()})
}

type inboundOpts struct {
	minutes   []int
	cls       string
	available bool
}

func parseInbound(r *http.Request) (inboundOpts, error) {
	q := r.URL.Query()
	o := inboundOpts{minutes: arrivalMinutes, cls: q.Get("cls"), available: q.Get("available") == "1"}
	if s := q.Get("minutes"); s != "" {
		o.minutes = nil
		for _, p := range strings.Split(s, ",") {
			m, err := strconv.Atoi(p)
			if err != nil || m < 1 || m > 60 {
				return o, errors.New("minutes: up to three whole numbers from 1 to 60")
			}
			if !slices.Contains(o.minutes, m) {
				o.minutes = append(o.minutes, m)
			}
		}
		if len(o.minutes) > 3 {
			return o, errors.New("minutes: up to three whole numbers from 1 to 60")
		}
	}
	slices.Sort(o.minutes)
	if o.cls == "" {
		o.cls = "all"
		if q.Get("mode") == "TWO_WHEELER" {
			o.cls = "MOTORBIKE"
		}
	}
	if !slices.Contains([]string{"all", "VEHICLE", "TRACTOR", "TRUCK", "CAR", "PLANT", "MOTORBIKE"}, o.cls) {
		return o, errors.New("cls: all, VEHICLE, TRACTOR, TRUCK, CAR, PLANT or MOTORBIKE")
	}
	return o, nil
}

func etaBand(etaS int) any {
	switch {
	case etaS <= bandFromMin*60:
		return nil
	case etaS <= 2*3600:
		return "1–2 h"
	case etaS <= 4*3600:
		return "2–4 h"
	}
	return "4 h+"
}

func (rt *Routing) arrivals(ctx context.Context, h hub, o inboundOpts) (map[string]any, error) {
	now := time.Now()
	mk := fmt.Sprintf("%.4f,%.4f:%s:%t:%v", h.Lat, h.Lng, o.cls, o.available, o.minutes)
	rt.mu.Lock()
	hit, ok := rt.matrices[mk]
	rt.mu.Unlock()
	if ok && now.Sub(hit.at) < matrixTTL {
		return hit.out, nil
	}
	val, err := rt.shared("matrix:"+mk, func() (any, error) {
		target := latLng{h.Lat, h.Lng}
		mode := "DRIVE"
		if o.cls == "MOTORBIKE" {
			mode = "TWO_WHEELER"
		}
		type cand struct {
			v         PVehicle
			p         latLng
			fixAt     string
			straightM float64
			status    string
			cls       string
		}
		var cands []cand
		atHub := []any{}
		leftOut, filteredOut := 0, 0
		for _, v := range rt.store.Vehicles() {
			p, fixAt, ok := fixOf(v)
			at := parseTime(fixAt)
			if !ok || at.IsZero() || now.Sub(at) > freshFix {
				continue
			}
			c := unitClass(v)
			if !inClass(c, o.cls) {
				continue
			}
			straight := distM(target, p)
			if straight <= atHubM {
				atHub = append(atHub, map[string]any{"vehicleId": vehicleKey(v.VehicleID), "plate": v.Registration})
				continue
			}
			status := "free"
			if now.Sub(at) > availableFix {
				status = "stale"
			}
			if o.available && status != "free" {
				filteredOut++
				continue
			}
			if straight > farM {
				leftOut++
				continue
			}
			cands = append(cands, cand{v, p, fixAt, straight, status, c})
		}
		slices.SortFunc(cands, func(a, b cand) int {
			if (a.status == "free") != (b.status == "free") {
				if a.status == "free" {
					return -1
				}
				return 1
			}
			return int(a.straightM - b.straightM)
		})
		if len(cands) > matrixMax {
			leftOut += len(cands) - matrixMax
			cands = cands[:matrixMax]
		}
		origins := make([]latLng, len(cands))
		for i, c := range cands {
			origins[i] = c.p
		}
		cells, err := rt.g.MatrixTo(ctx, origins, target, mode)
		if err != nil {
			return nil, err
		}
		units := []map[string]any{}
		for _, cell := range cells {
			if cell.Index < 0 || cell.Index >= len(cands) {
				continue
			}
			c := cands[cell.Index]
			staticS := int(math.Round(cell.StaticDurationS))
			delayS := max(0, int(math.Round(cell.DurationS-cell.StaticDurationS)))
			etaS := staticS + delayS
			var within any
			for _, m := range o.minutes {
				if etaS <= m*60 {
					within = m
					break
				}
			}
			var speed any
			if c.v.Position != nil {
				speed = c.v.Position.Speed
			}
			units = append(units, map[string]any{
				"vehicleId": vehicleKey(c.v.VehicleID), "plate": c.v.Registration, "unitClass": c.cls,
				"lat": c.p.Lat, "lng": c.p.Lng, "fixAt": c.fixAt, "speedKmh": speed,
				"straightM": int(math.Round(c.straightM)), "distanceM": cell.DistanceM,
				"etaS": etaS, "staticS": staticS, "delayS": delayS, "googleS": int(math.Round(cell.DurationS)),
				"factor": 1, "factorRuns": 0,
				"arriveAt":  now.Add(time.Duration(etaS) * time.Second).UTC().Format(time.RFC3339),
				"withinMin": within, "band": etaBand(etaS),
				"run": nil, "status": c.status, "destination": nil,
			})
		}
		slices.SortFunc(units, func(a, b map[string]any) int { return a["etaS"].(int) - b["etaS"].(int) })
		out := map[string]any{
			"enabled": true, "mode": mode, "cls": o.cls, "available": o.available, "minutes": o.minutes,
			"units": units, "atHub": atHub, "noRoute": len(cands) - len(cells),
			"leftOut": leftOut, "filteredOut": filteredOut, "computedAt": now.UTC().Format(time.RFC3339),
		}
		rt.mu.Lock()
		rt.matrices[mk] = matrixEntry{at: now, out: out}
		rt.mu.Unlock()
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return val.(map[string]any), nil
}

func (rt *Routing) answerInbound(w http.ResponseWriter, r *http.Request, h hub) {
	o, err := parseInbound(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	out, err := rt.arrivals(r.Context(), h, o)
	if err != nil {
		googleFailed(w, err)
		return
	}
	res := map[string]any{"hub": h}
	for k, v := range out {
		res[k] = v
	}
	writeData(w, res)
}

func (rt *Routing) inbound(w http.ResponseWriter, r *http.Request) {
	if !rt.enabled() {
		writeData(w, map[string]any{"enabled": false})
		return
	}
	key := mux.Vars(r)["hubKey"]
	for _, h := range rt.hubs() {
		if h.Key == key {
			rt.answerInbound(w, r, h)
			return
		}
	}
	writeError(w, http.StatusNotFound, "no such hub")
}

// inboundAt is "suggest a unit" for a spot picked on the map.
func (rt *Routing) inboundAt(w http.ResponseWriter, r *http.Request) {
	if !rt.enabled() {
		writeData(w, map[string]any{"enabled": false})
		return
	}
	lat, okLat, err1 := queryFloat(r, "lat", -90, 90)
	lng, okLng, err2 := queryFloat(r, "lng", -180, 180)
	if err := errors.Join(err1, err2); err != nil || !okLat || !okLng {
		writeError(w, http.StatusBadRequest, "lat and lng are required")
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Picked point"
	}
	rt.answerInbound(w, r, hub{Key: "point", Name: name[:min(len(name), 80)], Lat: lat, Lng: lng, Kind: "point"})
}
