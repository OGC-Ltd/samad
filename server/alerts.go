package main

// GET /alerts and friends, in fleet-server's shapes, from the partner's
// events feed. Two kinds reach the Alerts page:
//
//	speeding  the partner's over_speeding and geofence_speeding events
//	camera    the dashcams' driver and road alarms (no seatbelt, phone use,
//	          lane departure, fatigue, forward collision…), warning or critical
//
// Informational events (geofence entry and exit, approved driver, camera
// occlusion notices) reach the live feed only. The partner has no fuel data,
// so the page's fuel kind is never served.

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

// The page's default window: today and the six days before it.
const defaultAlertDays = 7

const (
	kindSpeeding = "speeding"
	kindCamera   = "camera"
)

// The kinds this server lists, for the page's filter.
var alertKinds = []string{kindSpeeding, kindCamera}

// alertKind is the Alerts page kind of an event, or "" for one it does not list.
func alertKind(e PEvent) string {
	if isSpeeding(e) {
		return kindSpeeding
	}
	if e.Source == "device" && (e.Severity == "warning" || e.Severity == "critical") {
		return kindCamera
	}
	return ""
}

type alertRow struct {
	e    PEvent
	kind string
	at   time.Time // when it reached us: the order the page lists in
	stat string
	read bool
	hist []Decision
}

func statusOf(hist []Decision) string {
	if len(hist) == 0 {
		return "open"
	}
	switch hist[len(hist)-1].Outcome {
	case "ESCALATED":
		return "escalated"
	case "DEESCALATED":
		return "deescalated"
	}
	return "open"
}

func choicesFor(status string) []map[string]any {
	var outs []string
	switch status {
	case "escalated":
		outs = []string{"DEESCALATED"}
	case "deescalated":
		outs = []string{"ESCALATED"}
	default:
		outs = []string{"ESCALATED", "DEESCALATED"}
	}
	list := make([]map[string]any, len(outs))
	for i, o := range outs {
		list[i] = map[string]any{"outcome": o, "reason": nil}
	}
	return list
}

// alertRows: every listed alert that happened in [from, to), newest arrival
// first, with this person's read marks.
func (s *Server) alertRows(user string, from, to time.Time) []alertRow {
	var rows []alertRow
	for _, e := range s.store.Events() {
		kind := alertKind(e)
		if kind == "" {
			continue
		}
		occurred := parseTime(e.OccurredAt)
		if occurred.Before(from) || !occurred.Before(to) {
			continue
		}
		hist := s.store.Decisions(e.EventID)
		rows = append(rows, alertRow{
			e: e, kind: kind, at: parseTime(e.ReceivedAt), stat: statusOf(hist), hist: hist,
			read: s.store.IsRead(user, e.EventID, e.ReceivedAt),
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		if !rows[i].at.Equal(rows[j].at) {
			return rows[i].at.After(rows[j].at)
		}
		return rows[i].e.EventID > rows[j].e.EventID
	})
	return rows
}

func (s *Server) alertJSON(r alertRow) map[string]any {
	e := r.e
	var decision any
	if len(r.hist) > 0 {
		decision = r.hist[len(r.hist)-1]
	}
	hist := r.hist
	if hist == nil {
		hist = []Decision{}
	}
	var speed *float64
	if e.Speed != nil {
		speed = e.Speed
	}
	driver := ""
	vname := e.Registration
	if v, ok := s.store.Vehicle(e.VehicleID); ok {
		driver = driverName(v)
		vname = vehicleName(v)
	}
	out := map[string]any{
		"kind":        r.kind,
		"id":          e.EventID,
		"orgId":       OrgID,
		"vehicleId":   vehicleKey(e.VehicleID),
		"plate":       e.Registration,
		"vehicleName": vname,
		"at":          e.OccurredAt,
		"arrivedAt":   e.ReceivedAt,
		"read":        r.read,
		"status":      r.stat,
		"decision":    decision,
		"history":     hist,
		"choices":     choicesFor(r.stat),
		"cleared":     nil,
	}
	if r.kind == kindCamera {
		label := e.TypeLabel
		if label == "" {
			label = strings.ReplaceAll(e.Type, "_", " ")
		}
		var road, cabin *string
		if e.Clips != nil {
			road, cabin = e.Clips.RoadFacing, e.Clips.DriverFacing
		}
		out["camera"] = map[string]any{
			"type":       e.Type,
			"label":      label,
			"severity":   severityOf(e),
			"speedKmh":   speed,
			"driverName": driver,
			"lat":        e.Latitude,
			"lng":        e.Longitude,
			"clips":      map[string]any{"roadFacing": road, "driverFacing": cabin},
		}
		return out
	}
	peak := 0.0
	if speed != nil {
		peak = *speed
	}
	over := peak - speedLimitKmh
	if over < 0 {
		over = 0
	}
	out["speeding"] = map[string]any{
		"peakKmh":     peak,
		"avgKmh":      peak,
		"limitKmh":    speedLimitKmh,
		"limitSource": "partner",
		"overByKmh":   over,
		"durationSec": nil,
		"distanceM":   nil,
		"frames":      1,
		"driverName":  driver,
		"endedAt":     e.OccurredAt,
		"lat":         e.Latitude,
		"lng":         e.Longitude,
		"place":       nil,
	}
	return out
}

func alertWindow(q map[string][]string) (time.Time, time.Time) {
	now := time.Now()
	from := fleetMidnight(now, defaultAlertDays-1)
	to := now
	if v := first(q, "from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = t
		} else if t, err := time.Parse("2006-01-02", v); err == nil {
			from = t
		}
	}
	if v := first(q, "to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = t
		} else if t, err := time.Parse("2006-01-02", v); err == nil {
			to = t
		}
	}
	return from, to
}

func first(q map[string][]string, k string) string {
	if v := q[k]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// GET /alerts
func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	user := userOf(r.Context())
	from, to := alertWindow(q)
	kind := q.Get("kind")
	if kind == "" {
		kind = "all"
	}
	status := q.Get("status")
	if status == "" {
		status = "open"
	}
	readF := q.Get("read")
	search := strings.ToUpper(strings.ReplaceAll(q.Get("q"), " ", ""))
	minOver, _ := strconv.ParseFloat(q.Get("minOverKmh"), 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset, _ := strconv.Atoi(q.Get("cursor"))
	orgOK := q.Get("orgs") == "" || contains(strings.Split(q.Get("orgs"), ","), OrgID)

	all := s.alertRows(user, from, to)
	if search != "" {
		kept := all[:0:0]
		for _, row := range all {
			if strings.Contains(strings.ToUpper(strings.ReplaceAll(row.e.Registration, " ", "")), search) {
				kept = append(kept, row)
			}
		}
		all = kept
	}

	// Counts per kind, status and read mark, before those filters: the
	// page's chips say what each choice would show.
	type countKey struct {
		kind   string
		status string
		read   bool
	}
	counts := map[countKey]int{}
	for _, row := range all {
		counts[countKey{row.kind, row.stat, row.read}]++
	}

	page := []map[string]any{}
	hasNext := false
	if orgOK {
		var kept []alertRow
		for _, row := range all {
			if kind != "all" && row.kind != kind {
				continue
			}
			if status != "all" && row.stat != status {
				continue
			}
			if readF == "read" && !row.read || readF == "unread" && row.read {
				continue
			}
			// "Over the limit by" narrows the overspeeds; it is not a
			// question a camera alarm answers, so those stay.
			if minOver > 0 && row.kind == kindSpeeding && (row.e.Speed == nil || *row.e.Speed-speedLimitKmh < minOver) {
				continue
			}
			kept = append(kept, row)
		}
		if offset < len(kept) {
			end := offset + limit
			if end >= len(kept) {
				end = len(kept)
			} else {
				hasNext = true
			}
			for _, row := range kept[offset:end] {
				page = append(page, s.alertJSON(row))
			}
		}
	}

	var countList any
	if offset == 0 {
		list := []map[string]any{}
		for k, n := range counts {
			list = append(list, map[string]any{"orgId": OrgID, "kind": k.kind, "status": k.status, "read": k.read, "n": n})
		}
		countList = list
	}
	var next any
	if hasNext {
		next = strconv.Itoa(offset + limit)
	}
	writeData(w, map[string]any{
		"orgs":        []any{map[string]any{"id": OrgID, "code": OrgCode, "name": OrgName, "kinds": alertKinds, "canDecide": true}},
		"counts":      countList,
		"range":       map[string]any{"from": from.UTC().Format(time.RFC3339), "to": to.UTC().Format(time.RFC3339)},
		"data":        page,
		"cursor":      next,
		"hasNextPage": hasNext,
	})
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if strings.TrimSpace(v) == s {
			return true
		}
	}
	return false
}

// GET /alerts/summary: the badge, open and unread over the default week.
func (s *Server) alertSummary(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	from := fleetMidnight(now, defaultAlertDays-1)
	byKind := map[string]int{}
	for _, row := range s.alertRows(userOf(r.Context()), from, now) {
		if row.stat == "open" && !row.read {
			byKind[row.kind]++
		}
	}
	writeData(w, map[string]any{
		"open": byKind[kindSpeeding] + byKind[kindCamera], "fuel": 0,
		"speeding": byKind[kindSpeeding], "camera": byKind[kindCamera],
		"from": from.UTC().Format(time.RFC3339),
	})
}

// GET /alerts/history: every listed alert held, a fleet day and kind at a time.
func (s *Server) alertHistory(w http.ResponseWriter, r *http.Request) {
	type key struct{ day, kind string }
	perDay := map[key]int{}
	for _, e := range s.store.Events() {
		if kind := alertKind(e); kind != "" {
			perDay[key{fleetDay(parseTime(e.OccurredAt)), kind}]++
		}
	}
	days := []map[string]any{}
	for k, n := range perDay {
		days = append(days, map[string]any{"orgId": OrgID, "kind": k.kind, "day": k.day, "n": n})
	}
	sort.Slice(days, func(i, j int) bool {
		if days[i]["day"] != days[j]["day"] {
			return days[i]["day"].(string) < days[j]["day"].(string)
		}
		return days[i]["kind"].(string) < days[j]["kind"].(string)
	})
	writeData(w, map[string]any{"days": days})
}

// POST /alerts/read { items: [{ kind, id }] }
func (s *Server) markRead(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	ids := make([]string, 0, len(body.Items))
	for _, it := range body.Items {
		ids = append(ids, it.ID)
	}
	n := s.store.MarkRead(userOf(r.Context()), ids)
	s.store.Save()
	writeData(w, map[string]any{"marked": n})
}

// POST /alerts/read-all
func (s *Server) markAllRead(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	s.store.MarkAllRead(userOf(r.Context()), now)
	s.store.Save()
	writeData(w, map[string]any{"readAt": now.UTC().Format(time.RFC3339)})
}

// POST /organisations/{org}/incidents/{kind}/{id}/review { outcome, note }
// Escalate (taken up with the driver) or de-escalate (not one) an overspeed
// or a camera alarm. A decision may be changed later; every one is kept.
func (s *Server) reviewAlert(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	kind, id := vars["kind"], vars["id"]
	var body struct {
		Outcome string `json:"outcome"`
		Note    string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Outcome != "ESCALATED" && body.Outcome != "DEESCALATED" {
		writeError(w, http.StatusBadRequest, "outcome must be ESCALATED or DEESCALATED")
		return
	}
	if len(strings.TrimSpace(body.Note)) < 3 {
		writeError(w, http.StatusBadRequest, "a note is required")
		return
	}
	found := false
	for _, e := range s.store.Events() {
		if e.EventID == id && alertKind(e) == kind {
			found = true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such alert")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	d := Decision{Outcome: body.Outcome, Note: strings.TrimSpace(body.Note), By: s.cfg.AdminName, At: now}
	s.store.Decide(id, d)
	s.store.MarkRead(userOf(r.Context()), []string{id})
	s.store.Save()
	writeData(w, map[string]any{"id": id, "review": map[string]any{"status": d.Outcome, "at": now, "by": d.By, "note": d.Note}})
}
