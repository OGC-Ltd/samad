package main

// GET /reports/fleet?org=&from=&to= — what the Reports page's three reports
// are made from (operator, 2026-11-03: "the movements, policy breach and end
// of shift reports, the same for Samad"):
//
//	events    every partner event that happened in [from, to): dashcam and
//	          tracker alarms, overspeeds and geofence crossings, each with the
//	          kind the reports count it under (reportKind) and, for a
//	          crossing, the zone and whether it was an entry or an exit
//	vehicles  every unit now: where it is, whether it is inside one of the
//	          organisation's zones (or how far it is from the nearest), and
//	          its last crossing whenever it was (so "out since" can reach back
//	          before the period, as far as events are kept)
//
// The page builds the reports and their PDFs from this (src/lib/samadReports).
// No fuel: the partner has none, so the reports carry none either.

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The longest period one request may ask for: events are kept 30 days.
const reportMaxDays = 31

// reportKind is the report heading an event counts under, or "" for one the
// reports leave out. Read from the partner's type key, so a type it adds that
// says what it is still lands under the right heading.
func reportKind(e PEvent) string {
	t := strings.ToLower(e.Type)
	switch {
	case e.Geofence != nil || strings.HasPrefix(t, "geofence_entr") || strings.HasPrefix(t, "geofence_exit"):
		if t == "geofence_speeding" {
			return "overspeed"
		}
		return "geofence"
	case t == "over_speeding" || strings.Contains(t, "speeding"):
		return "overspeed"
	case strings.Contains(t, "harsh_brak"):
		return "harsh_braking"
	case strings.Contains(t, "harsh_accel"):
		return "harsh_acceleration"
	case strings.Contains(t, "seatbelt"):
		return "no_seatbelt"
	case strings.Contains(t, "phone"):
		return "phone"
	case strings.Contains(t, "occlusion") || strings.Contains(t, "cover"):
		return "camera_covered"
	}
	if e.Severity == "critical" {
		return "critical"
	}
	return "other"
}

// crossing says whether a geofence event was an entry or an exit, from the
// partner's action word or, failing that, its type key.
func crossing(e PEvent) string {
	words := strings.ToLower(e.Type)
	if e.Geofence != nil && e.Geofence.Action != "" {
		words = strings.ToLower(e.Geofence.Action)
	}
	switch {
	case strings.Contains(words, "exit") || strings.Contains(words, "out") || strings.Contains(words, "leave") || strings.Contains(words, "left"):
		return "exit"
	case strings.Contains(words, "ent") || strings.Contains(words, "in"):
		return "entry"
	}
	return ""
}

// insideZone: is the point inside the geofence (circle or polygon)?
func insideZone(g PGeofence, lat, lng float64) bool {
	if g.Center != nil && g.RadiusM != nil {
		return haversineKm(lat, lng, g.Center.Lat, g.Center.Lng)*1000 <= *g.RadiusM
	}
	if g.Coordinates == nil || len(g.Coordinates.Points) < 3 {
		return false
	}
	pts := g.Coordinates.Points
	in := false
	for i, j := 0, len(pts)-1; i < len(pts); j, i = i, i+1 {
		a, b := pts[i], pts[j]
		if (a.Lat > lat) != (b.Lat > lat) && lng < (b.Lng-a.Lng)*(lat-a.Lat)/(b.Lat-a.Lat)+a.Lng {
			in = !in
		}
	}
	return in
}

// zoneCentre: a circle's centre, or the average of a polygon's corners.
func zoneCentre(g PGeofence) (float64, float64, bool) {
	if g.Center != nil {
		return g.Center.Lat, g.Center.Lng, true
	}
	if g.Coordinates == nil || len(g.Coordinates.Points) == 0 {
		return 0, 0, false
	}
	var la, ln float64
	for _, p := range g.Coordinates.Points {
		la += p.Lat
		ln += p.Lng
	}
	n := float64(len(g.Coordinates.Points))
	return la / n, ln / n, true
}

// whereNow: the zone a point is inside, else the nearest zone and how far it is (km).
func whereNow(zones []PGeofence, lat, lng float64) (inside string, nearest string, km float64) {
	km = math.Inf(1)
	for _, g := range zones {
		if insideZone(g, lat, lng) {
			return g.Name, "", 0
		}
		if cl, cn, ok := zoneCentre(g); ok {
			if d := haversineKm(lat, lng, cl, cn); d < km {
				nearest, km = g.Name, d
			}
		}
	}
	if nearest == "" {
		km = 0
	}
	return "", nearest, km
}

func zoneName(e PEvent) string {
	if e.Geofence != nil {
		return e.Geofence.ZoneName
	}
	return ""
}

// reportEvent is one event as the reports read it.
func reportEvent(e PEvent) map[string]any {
	label := e.TypeLabel
	if label == "" {
		label = strings.ReplaceAll(e.Type, "_", " ")
	}
	road, cabin := clipsOf(e)
	out := map[string]any{
		"id":         e.EventID,
		"kind":       reportKind(e),
		"type":       e.Type,
		"label":      label,
		"source":     e.Source,
		"severity":   e.Severity,
		"occurredAt": e.OccurredAt,
		"vehicleId":  vehicleKey(e.VehicleID),
		"plate":      e.Registration,
		"lat":        e.Latitude,
		"lng":        e.Longitude,
		"speed":      e.Speed,
		"hasClip":    road != "" || cabin != "",
		"zone":       nil,
		"action":     nil,
	}
	if out["kind"] == "geofence" {
		out["zone"] = zoneName(e)
		out["action"] = crossing(e)
	}
	return out
}

// reportVehicles: every unit now, with its zone and its last crossing (any time kept).
func reportVehicles(vehicles []PVehicle, zones []PGeofence, events []PEvent) []map[string]any {
	last := map[int]PEvent{}
	for _, e := range events {
		if reportKind(e) != "geofence" || crossing(e) == "" {
			continue
		}
		if p, ok := last[e.VehicleID]; !ok || parseTime(e.OccurredAt).After(parseTime(p.OccurredAt)) {
			last[e.VehicleID] = e
		}
	}
	out := make([]map[string]any, 0, len(vehicles))
	for _, v := range vehicles {
		row := map[string]any{
			"vehicleId": vehicleKey(v.VehicleID), "plate": v.Registration, "driver": driverName(v),
			"type": vehicleType(v), "lat": nil, "lng": nil, "speedKmh": nil, "capturedAt": nil,
			"online": false, "moving": false, "zoneNow": nil, "nearestZone": nil, "nearestKm": nil,
			"lastCrossing": nil,
		}
		if p := v.Position; p != nil {
			row["lat"], row["lng"], row["speedKmh"], row["capturedAt"] = p.Latitude, p.Longitude, liveSpeed(p), p.LastUpdate
			row["online"] = online(p)
			row["moving"] = p.MotionStatus == "moving"
			if p.Latitude != 0 || p.Longitude != 0 {
				in, near, km := whereNow(zones, p.Latitude, p.Longitude)
				if in != "" {
					row["zoneNow"] = in
				} else if near != "" {
					row["nearestZone"], row["nearestKm"] = near, math.Round(km*10)/10
				}
			}
		}
		if e, ok := last[v.VehicleID]; ok {
			row["lastCrossing"] = map[string]any{"zone": zoneName(e), "action": crossing(e), "at": e.OccurredAt}
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["plate"].(string) < out[j]["plate"].(string) })
	return out
}

// reportPeriod reads from and to (epoch ms or RFC 3339); the default is today so far.
func reportPeriod(r *http.Request, now time.Time) (time.Time, time.Time, string) {
	read := func(k string) (time.Time, bool) {
		s := r.URL.Query().Get(k)
		if s == "" {
			return time.Time{}, false
		}
		if ms, err := strconv.ParseInt(s, 10, 64); err == nil {
			return time.UnixMilli(ms), true
		}
		t, err := time.Parse(time.RFC3339, s)
		return t, err == nil
	}
	from, okF := read("from")
	to, okT := read("to")
	if !okF {
		from = fleetMidnight(now, 0)
	}
	if !okT || to.After(now) {
		to = now
	}
	if !from.Before(to) {
		return from, to, "the period must start before it ends"
	}
	if to.Sub(from) > reportMaxDays*24*time.Hour {
		return from, to, "a report covers 31 days at most"
	}
	return from, to, ""
}

func (s *Server) reportFleet(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	now := time.Now()
	from, to, problem := reportPeriod(r, now)
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	all := s.store.Events()
	events := []map[string]any{}
	kept := now
	for _, e := range all {
		at := parseTime(e.OccurredAt)
		if !at.IsZero() && at.Before(kept) {
			kept = at
		}
		if at.Before(from) || !at.Before(to) || reportKind(e) == "other" {
			continue
		}
		events = append(events, reportEvent(e))
	}
	sort.Slice(events, func(i, j int) bool {
		return events[i]["occurredAt"].(string) < events[j]["occurredAt"].(string)
	})
	zones := s.store.Geofences()
	names := make([]string, 0, len(zones))
	for _, g := range zones {
		names = append(names, g.Name)
	}
	writeData(w, map[string]any{
		"from":        from.UTC().Format(time.RFC3339),
		"to":          to.UTC().Format(time.RFC3339),
		"generatedAt": now.UTC().Format(time.RFC3339),
		"keptSince":   kept.UTC().Format(time.RFC3339),
		"zones":       names,
		"events":      events,
		"vehicles":    reportVehicles(s.store.Vehicles(), zones, all),
	})
}
