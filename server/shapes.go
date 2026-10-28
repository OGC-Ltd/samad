package main

// The partner's records in the shapes the samad UI was written against
// (fleet-server's snapshot rows, live frames, feed items and alerts).

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// The speed limit used for the overspeed figures (SPEED_LIMIT_KMH). The
// partner raises over_speeding itself and does not say what limit it applied;
// its events start at 69 km/h, so its limit sits below that.
var speedLimitKmh = 65.0

func vehicleKey(id int) string { return strconv.Itoa(id) }

func driverName(v PVehicle) string {
	if v.Driver != nil && v.Driver.Name != "" {
		return v.Driver.Name
	}
	return "Unassigned"
}

func vehicleName(v PVehicle) string {
	if v.Trailer != "" {
		return v.Registration + " · " + v.Trailer
	}
	return strings.TrimSpace(fmt.Sprintf("%s %s %s", v.Make, v.Model, v.Registration))
}

func vehicleType(v PVehicle) string {
	if v.Type == "" {
		return "TRUCK"
	}
	return strings.ToUpper(v.Type)
}

// online: the partner calls a device offline when it has stopped reporting.
func online(p *PPosition) bool { return p != nil && p.MotionStatus != "offline" }

// movement: { moving, since, exact } — the UI's moving/resting run. The
// partner gives the state but not when it began, so `since` is unknown.
func movement(p *PPosition) map[string]any {
	if p == nil || p.MotionStatus == "offline" {
		return nil
	}
	return map[string]any{"moving": p.MotionStatus == "moving", "since": nil, "exact": false}
}

// snapshotRow is one GET /vehicles/snapshot row.
func snapshotRow(v PVehicle) map[string]any {
	row := map[string]any{
		"vehicleId":        vehicleKey(v.VehicleID),
		"plate":            v.Registration,
		"name":             vehicleName(v),
		"driver":           driverName(v),
		"driverSource":     nil,
		"vehicleType":      vehicleType(v),
		"lat":              nil,
		"lng":              nil,
		"headingDeg":       nil,
		"speedKmh":         nil,
		"speedLimitKmh":    speedLimitKmh,
		"engineOn":         false,
		"capturedAt":       nil,
		"connectionOnline": false,
		"movement":         nil,
		"lowFuel":          false,
		"fuelIncident":     nil,
		"fuelLevelPct":     nil,
		"fuelLevelMl":      nil,
		"zones":            nil,
		"imei":             nil,
	}
	if v.Device != nil {
		row["imei"] = v.Device.IMEI
	}
	if p := v.Position; p != nil {
		row["lat"] = p.Latitude
		row["lng"] = p.Longitude
		row["headingDeg"] = p.Course
		row["speedKmh"] = p.Speed
		row["engineOn"] = p.Engine == "on"
		row["capturedAt"] = p.LastUpdate
		row["connectionOnline"] = online(p)
		row["movement"] = movement(p)
	}
	return row
}

// positionFrame is one SSE `position` frame.
func positionFrame(v PVehicle) map[string]any {
	p := v.Position
	return map[string]any{
		"vehicleId":        vehicleKey(v.VehicleID),
		"lat":              p.Latitude,
		"lng":              p.Longitude,
		"headingDeg":       p.Course,
		"speedKmh":         p.Speed,
		"speedLimitKmh":    speedLimitKmh,
		"engineOn":         p.Engine == "on",
		"capturedAt":       p.LastUpdate,
		"connectionOnline": online(p),
		"movement":         movement(p),
		"flags":            map[string]any{"lowFuel": false, "fuelInconsistency": false, "speeding": p.Speed > speedLimitKmh},
		"zones":            nil,
	}
}

// isSpeeding: the events the Alerts page lists as overspeeding.
func isSpeeding(e PEvent) bool {
	return e.Type == "over_speeding" || e.Type == "geofence_speeding"
}

func severityOf(e PEvent) string {
	switch e.Severity {
	case "critical", "warning":
		return e.Severity
	}
	return "info"
}

// feedItem is one SSE `feed` item (the bell's notifications).
func feedItem(e PEvent) map[string]any {
	label := e.TypeLabel
	if label == "" {
		label = strings.ReplaceAll(e.Type, "_", " ")
	}
	text := strings.ToUpper(label)
	if e.Geofence != nil && e.Geofence.ZoneName != "" {
		text += ": " + e.Geofence.ZoneName
	}
	if e.Speed != nil && *e.Speed > 0 {
		text += fmt.Sprintf(" at %.0f km/h", *e.Speed)
	}
	return map[string]any{
		"id":        e.EventID,
		"orgId":     OrgID,
		"ts":        e.OccurredAt,
		"type":      strings.ToUpper(e.Type),
		"alertType": strings.ToUpper(e.Type),
		"severity":  severityOf(e),
		"text":      text,
		"plate":     e.Registration,
		"vehicleId": vehicleKey(e.VehicleID),
		"source":    e.Source,
	}
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}
