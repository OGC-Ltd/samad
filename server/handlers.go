package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

type Server struct {
	cfg    Config
	client *PartnerClient
	store  *Store
	hub    *Hub
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write: %v", err)
	}
}

func writeData(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": data})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"success": false, "message": msg})
}

// partnerFailed passes a partner 404 on and calls anything else a 502.
func partnerFailed(w http.ResponseWriter, err error) {
	var pe *PartnerError
	if errors.As(err, &pe) && pe.Status == http.StatusNotFound {
		writeError(w, http.StatusNotFound, "no such vehicle")
		return
	}
	log.Printf("partner: %v", err)
	writeError(w, http.StatusBadGateway, "the tracking provider did not answer")
}

// vehicleParam reads {vehicleId} and checks it is one of ours.
func (s *Server) vehicleParam(w http.ResponseWriter, r *http.Request) (PVehicle, bool) {
	id, err := strconv.Atoi(mux.Vars(r)["vehicleId"])
	if err == nil {
		if v, ok := s.store.Vehicle(id); ok {
			return v, true
		}
	}
	writeError(w, http.StatusNotFound, "no such vehicle")
	return PVehicle{}, false
}

// GET /bootstrap: the organisation roster the UI resolves its company by.
func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	writeData(w, map[string]any{"orgs": []any{map[string]any{"id": OrgID, "code": OrgCode, "name": OrgName}}})
}

// GET /organisations/{org}/vehicles/snapshot
func (s *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	list := s.store.Vehicles()
	rows := make([]map[string]any, 0, len(list))
	for _, v := range list {
		rows = append(rows, snapshotRow(v))
	}
	writeData(w, rows)
}

// GET /organisations/{org}/live: server-sent events. Every vehicle's position
// on connect, then whatever the poller sees change, plus the newest feed
// items. A comment every 20 s keeps proxies from closing an idle stream.
func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")

	ch := s.hub.Subscribe()
	defer s.hub.Unsubscribe(ch)

	send := func(event string, v any) {
		b, err := json.Marshal(v)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
	}
	for _, v := range s.store.Vehicles() {
		if v.Position != nil {
			send("position", positionFrame(v))
		}
	}
	events := s.store.Events()
	for i := len(events) - 1; i >= 0 && i >= len(events)-40; i-- {
		send("feed", feedItem(events[i]))
	}
	fl.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case f := <-ch:
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", f.Event, f.Data)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

type trackPoint struct {
	T         int64   `json:"t"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	Spd       float64 `json:"spd"`
	Hdg       float64 `json:"hdg"`
	Eng       bool    `json:"eng"`
	GapBefore bool    `json:"gapBefore,omitempty"`
}

// A silence longer than this is drawn as a gap, not a straight line.
const gapAfter = 10 * time.Minute

func toPoints(list []PHistoryPoint) []trackPoint {
	pts := make([]trackPoint, 0, len(list))
	var prev time.Time
	for _, p := range list {
		t := parseTime(p.Timestamp)
		if t.IsZero() {
			continue
		}
		tp := trackPoint{T: t.UnixMilli(), Lat: p.Latitude, Lng: p.Longitude, Spd: p.Speed, Hdg: p.Course, Eng: p.Ignition}
		if !prev.IsZero() && t.Sub(prev) > gapAfter {
			tp.GapBefore = true
		}
		prev = t
		pts = append(pts, tp)
	}
	sort.SliceStable(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	return pts
}

// GET /organisations/{org}/vehicles/{vehicleId}/track?from=&to=
// The breadcrumb line behind a unit on the map. Defaults to today.
func (s *Server) track(w http.ResponseWriter, r *http.Request) {
	v, ok := s.vehicleParam(w, r)
	if !ok {
		return
	}
	now := time.Now()
	from, to := fleetMidnight(now, 0), now
	if t := parseTime(r.URL.Query().Get("from")); !t.IsZero() {
		from = t
	}
	if t := parseTime(r.URL.Query().Get("to")); !t.IsZero() {
		to = t
	}
	if to.Sub(from) > 72*time.Hour {
		from = to.Add(-72 * time.Hour)
	}
	hist, err := s.client.History(r.Context(), v.VehicleID, from, to)
	if err != nil {
		partnerFailed(w, err)
		return
	}
	pts := toPoints(hist)
	// When the key last came out, if it is still out.
	var offSince any
	for i := len(pts) - 1; i >= 0 && !pts[i].Eng; i-- {
		offSince = pts[i].T
	}
	writeData(w, map[string]any{"points": pts, "engineOffSinceMs": offSince, "engineOffRunsPastWindow": false})
}

// GET /organisations/{org}/vehicles/{vehicleId}/playback?day=YYYY-MM-DD
// One fleet day of fixes for the replay, with the day's alarms on the timeline.
func (s *Server) playback(w http.ResponseWriter, r *http.Request) {
	v, ok := s.vehicleParam(w, r)
	if !ok {
		return
	}
	now := time.Now()
	day := r.URL.Query().Get("day")
	if day == "" {
		day = fleetDay(now)
	}
	start, err := time.ParseInLocation("2006-01-02", day, fleetZone)
	if err != nil {
		writeError(w, http.StatusBadRequest, "day must be YYYY-MM-DD")
		return
	}
	if start.After(now) {
		writeError(w, http.StatusBadRequest, "that day has not started yet")
		return
	}
	end := start.Add(24 * time.Hour)
	to := end
	if to.After(now) {
		to = now
	}
	hist, err := s.client.History(r.Context(), v.VehicleID, start, to)
	if err != nil {
		partnerFailed(w, err)
		return
	}
	pts := toPoints(hist)
	events := []map[string]any{}
	for _, e := range s.store.Events() {
		at := parseTime(e.OccurredAt)
		if e.VehicleID != v.VehicleID || at.Before(start) || !at.Before(end) {
			continue
		}
		kind := "alarm"
		if isSpeeding(e) {
			kind = "speeding"
		}
		label := e.TypeLabel
		if label == "" {
			label = strings.ReplaceAll(e.Type, "_", " ")
		}
		ev := map[string]any{"t": at.UnixMilli(), "kind": kind, "severity": severityOf(e), "label": label}
		if e.Speed != nil {
			ev["detail"] = fmt.Sprintf("%.0f km/h", *e.Speed)
		}
		events = append(events, ev)
	}
	sort.Slice(events, func(i, j int) bool { return events[i]["t"].(int64) < events[j]["t"].(int64) })
	var firstAt, lastAt any
	if len(pts) > 0 {
		firstAt, lastAt = pts[0].T, pts[len(pts)-1].T
	}
	writeData(w, map[string]any{
		"day": day, "from": start.UnixMilli(), "to": end.UnixMilli(),
		"complete": !end.After(now), "truncated": false,
		"fixes": len(hist), "rawPoints": len(hist), "points": pts,
		"firstAt": firstAt, "lastAt": lastAt, "events": events,
	})
}

// GET /organisations/{org}/geofences/geojson
func (s *Server) geofencesGeoJSON(w http.ResponseWriter, r *http.Request) {
	features := []map[string]any{}
	for _, g := range s.store.Geofences() {
		props := map[string]any{
			"id": strconv.Itoa(g.ZoneID), "name": g.Name, "category": "zone",
			"fenceType": strings.ToUpper(g.ZoneType), "mode": g.ZoneAction,
			"isActive": g.Status == "active", "widthM": nil, "radiusM": g.RadiusM,
			"areaHa": nil, "source": "provider",
		}
		switch {
		case g.Center != nil && g.RadiusM != nil:
			features = append(features, map[string]any{"type": "Feature", "properties": props,
				"geometry": map[string]any{"type": "Point", "coordinates": []float64{g.Center.Lng, g.Center.Lat}}})
		case g.Coordinates != nil && len(g.Coordinates.Points) >= 3:
			ring := make([][]float64, 0, len(g.Coordinates.Points)+1)
			for _, p := range g.Coordinates.Points {
				ring = append(ring, []float64{p.Lng, p.Lat})
			}
			if f, l := ring[0], ring[len(ring)-1]; f[0] != l[0] || f[1] != l[1] {
				ring = append(ring, ring[0])
			}
			features = append(features, map[string]any{"type": "Feature", "properties": props,
				"geometry": map[string]any{"type": "Polygon", "coordinates": [][][]float64{ring}}})
		}
	}
	writeData(w, map[string]any{"type": "FeatureCollection", "features": features})
}

// GET /organisations/{org}/analytics/drivers/overview?days=
// The drivers the partner assigns to vehicles, with the trips and distance
// this server has tallied for their vehicle (see Store.tally) and the
// overspeeds raised on it.
func (s *Server) driversOverview(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 || days > 90 {
		days = 90
	}
	now := time.Now()
	keys := make([]string, 0, days)
	for i := days - 1; i >= 0; i-- {
		keys = append(keys, fleetDay(fleetMidnight(now, i)))
	}
	tallies := s.store.Days(keys)
	floor := fleetMidnight(now, days-1)

	type driver struct {
		row   map[string]any
		byDay map[string]*struct {
			trips int
			km    float64
		}
	}
	drivers := map[string]*driver{}
	order := []string{}
	for _, v := range s.store.Vehicles() {
		if v.Driver == nil || v.Driver.Name == "" {
			continue
		}
		id := "d-" + strconv.Itoa(v.Driver.ID)
		d := drivers[id]
		if d == nil {
			d = &driver{row: map[string]any{
				"id": id, "fullName": v.Driver.Name, "employeeId": nil, "licenceNumber": nil,
				"status": "ACTIVE", "rating": nil, "vehicle": v.Registration, "vehicleFrom": nil,
				"trips": 0, "mileageKm": 0.0, "tonnes": 0, "overspeedingCases": 0, "fuelTheftCases": 0,
			}, byDay: map[string]*struct {
				trips int
				km    float64
			}{}}
			drivers[id] = d
			order = append(order, id)
		} else if !strings.Contains(d.row["vehicle"].(string), v.Registration) {
			d.row["vehicle"] = d.row["vehicle"].(string) + ", " + v.Registration
		}
		for _, day := range keys {
			st, ok := tallies[day][v.VehicleID]
			if !ok || (st.Trips == 0 && st.Km < 0.5) {
				continue
			}
			b := d.byDay[day]
			if b == nil {
				b = &struct {
					trips int
					km    float64
				}{}
				d.byDay[day] = b
			}
			b.trips += st.Trips
			b.km += st.Km
			d.row["trips"] = d.row["trips"].(int) + st.Trips
			d.row["mileageKm"] = d.row["mileageKm"].(float64) + st.Km
		}
		for _, e := range s.store.Events() {
			if e.VehicleID == v.VehicleID && isSpeeding(e) && !parseTime(e.OccurredAt).Before(floor) {
				d.row["overspeedingCases"] = d.row["overspeedingCases"].(int) + 1
			}
		}
	}
	rows := []map[string]any{}
	details := map[string]any{}
	for _, id := range order {
		d := drivers[id]
		d.row["mileageKm"] = float64(int(d.row["mileageKm"].(float64)*10)) / 10
		rows = append(rows, d.row)
		byDay := []map[string]any{}
		for _, day := range keys {
			if b := d.byDay[day]; b != nil {
				byDay = append(byDay, map[string]any{"day": day, "trips": b.trips, "km": float64(int(b.km*10)) / 10})
			}
		}
		details[id] = map[string]any{"byDay": byDay}
	}
	writeData(w, map[string]any{"drivers": rows, "details": details})
}

// GET /organisations/{org}/dashboard/ai-insight: the Fleet summary card.
// Worked out from the live positions and today's alarms; source "facts"
// tells the card it is not a model's brief.
func (s *Server) fleetInsight(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	var moving, idle, offline int
	list := s.store.Vehicles()
	for _, v := range list {
		switch {
		case v.Position == nil || v.Position.MotionStatus == "offline":
			offline++
		case v.Position.MotionStatus == "moving":
			moving++
		default:
			idle++
		}
	}
	today := fleetMidnight(now, 0)
	byType := map[string]int{}
	labels := map[string]string{}
	critical := 0
	for _, e := range s.store.Events() {
		if parseTime(e.OccurredAt).Before(today) {
			continue
		}
		byType[e.Type]++
		labels[e.Type] = e.TypeLabel
		if e.Severity == "critical" {
			critical++
		}
	}
	total := len(list)
	headline := fmt.Sprintf("%d of %d units moving, %d idle, %d offline.", moving, total, idle, offline)
	findings := []map[string]any{}
	types := make([]string, 0, len(byType))
	for t := range byType {
		types = append(types, t)
	}
	sort.Slice(types, func(i, j int) bool { return byType[types[i]] > byType[types[j]] })
	for i, t := range types {
		if i == 3 {
			break
		}
		label := labels[t]
		if label == "" {
			label = strings.ReplaceAll(t, "_", " ")
		}
		findings = append(findings, map[string]any{"kind": t, "text": fmt.Sprintf("%d %s alarm%s today.", byType[t], strings.ToLower(label), plural(byType[t]))})
	}
	risk, action := "LOW", "No action needed."
	switch {
	case critical >= 10:
		risk, action = "HIGH", "Review today's critical alarms with the drivers involved."
	case critical > 0:
		risk, action = "MEDIUM", "Check today's critical alarms on the Alerts and unit cards."
	}
	if total > 0 && offline*2 > total {
		findings = append(findings, map[string]any{"kind": "offline", "text": fmt.Sprintf("%d of %d units are not reporting.", offline, total)})
	}
	msg := headline
	for _, f := range findings {
		msg += " " + f["text"].(string)
	}
	writeData(w, map[string]any{"insight": map[string]any{
		"msg": msg, "headline": headline, "findings": findings, "action": action,
		"risk": risk, "source": "facts", "generatedAt": now.UTC().Format(time.RFC3339),
	}})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// emptyRoute answers the UI's routes for features Samad does not carry yet
// (fuel, repairs, weighments, routing): an empty list, never an error page.
func emptyRoute(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeData(w, []any{})
		return
	}
	writeData(w, nil)
}
