package main

// The Camera page's routes, in the shapes new-ui's dashcam Alarms page reads
// (src/api/vssAlarms.js), from the dashcam events the partner feed brings:
//
//	GET /vss/cameras?org=   how many units have sent a camera alarm (0 hides the page)
//	GET /vss/alarms?org=&since=   every dashcam alarm with a clip, newest first
//	GET /vss/file?org=&k=<event id>.<road|driver>[&download=1]
//
// The clips live on the partner's video host. They are served through /file
// so the page only ever plays our own URLs, behind the sign-in, and so a
// <video> can seek (Range is passed through).

import (
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const vssBase = "/api/v1/vss"

// The page's filter chips (src/lib/dashcamIncidents.js), per partner type.
var cameraCategory = map[string]string{
	"harsh_braking":       "braking",
	"harsh_acceleration":  "braking",
	"over_speeding":       "speeding",
	"no_seatbelt":         "driver",
	"phone_use":           "driver",
	"driver_distracted":   "driver",
	"fatigue_eyes_closed": "driver",
	"fatigue_yawning":     "driver",
	"smoking_detected":    "driver",
	"lane_departure":      "lane",
	"forward_collision":   "collision",
}

// The partner's clips: a stored camera event's road and cabin URLs.
func clipsOf(e PEvent) (road, cabin string) {
	if e.Clips == nil {
		return "", ""
	}
	if e.Clips.RoadFacing != nil {
		road = *e.Clips.RoadFacing
	}
	if e.Clips.DriverFacing != nil {
		cabin = *e.Clips.DriverFacing
	}
	return road, cabin
}

func isCameraEvent(e PEvent) bool { return e.Source == "device" }

func (s *Server) orgParam(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Query().Get("org") != OrgID {
		writeError(w, http.StatusNotFound, "no such organisation")
		return false
	}
	return true
}

func (s *Server) vssCameras(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	units := map[int]bool{}
	for _, e := range s.store.Events() {
		if isCameraEvent(e) {
			units[e.VehicleID] = true
		}
	}
	writeData(w, map[string]any{"cameras": len(units)})
}

func (s *Server) vssAlarms(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	since := parseTime(r.URL.Query().Get("since"))
	if since.IsZero() {
		since = fleetMidnight(time.Now(), 0)
	}
	org := url.QueryEscape(OrgID)
	file := func(id, cam string) map[string]any {
		u := vssBase + "/file?org=" + org + "&k=" + url.QueryEscape(id+"."+cam)
		label := "Road"
		if cam == "driver" {
			label = "Driver"
		}
		return map[string]any{"key": cam, "label": label, "url": u, "download": u + "&download=1"}
	}

	type row struct {
		at  time.Time
		out map[string]any
	}
	var rows []row
	for _, e := range s.store.Events() {
		at := parseTime(e.OccurredAt)
		if !isCameraEvent(e) || at.Before(since) {
			continue
		}
		road, cabin := clipsOf(e)
		if road == "" && cabin == "" {
			continue
		}
		videos := []map[string]any{}
		if road != "" {
			videos = append(videos, file(e.EventID, "road"))
		}
		if cabin != "" {
			videos = append(videos, file(e.EventID, "driver"))
		}
		label := e.TypeLabel
		if label == "" {
			label = strings.ReplaceAll(e.Type, "_", " ")
		}
		category := cameraCategory[e.Type]
		if category == "" {
			category = "other"
		}
		code := 0
		if e.AlarmCode != nil {
			code = *e.AlarmCode
		}
		rows = append(rows, row{at, map[string]any{
			"id":         e.EventID,
			"code":       code,
			"label":      label,
			"severity":   e.Severity,
			"category":   category,
			"occurredAt": e.OccurredAt,
			"vehicleId":  vehicleKey(e.VehicleID),
			"plate":      e.Registration,
			"lat":        e.Latitude,
			"lng":        e.Longitude,
			"speed":      e.Speed,
			"videos":     videos,
			"photos":     []any{},
		}})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].at.After(rows[j].at) })
	out := make([]map[string]any, len(rows))
	for i, r := range rows {
		out[i] = r.out
	}
	writeData(w, map[string]any{"incidents": out})
}

// No timeout: a long clip may stream for a while; the request's own
// context ends it when the viewer goes.
var clipClient = &http.Client{}

func (s *Server) vssFile(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	k := r.URL.Query().Get("k")
	dot := strings.LastIndexByte(k, '.')
	if dot < 0 {
		writeError(w, http.StatusNotFound, "no such file")
		return
	}
	id, cam := k[:dot], k[dot+1:]
	var src string
	for _, e := range s.store.Events() {
		if e.EventID == id && isCameraEvent(e) {
			road, cabin := clipsOf(e)
			switch cam {
			case "road":
				src = road
			case "driver":
				src = cabin
			}
			break
		}
	}
	if src == "" {
		writeError(w, http.StatusNotFound, "no such file")
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, src, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "bad clip address")
		return
	}
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	res, err := clipClient.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, "the video host did not answer")
		return
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusForbidden && res.ContentLength == 0:
		writeError(w, http.StatusNotFound, "the camera has not uploaded this clip")
		return
	case res.StatusCode >= 300:
		writeError(w, http.StatusBadGateway, "the video host refused the clip")
		return
	}
	h := w.Header()
	for _, name := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := res.Header.Get(name); v != "" {
			h.Set(name, v)
		}
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "video/mp4")
	}
	h.Set("Cache-Control", "private, max-age=3600")
	if r.URL.Query().Get("download") == "1" {
		name := id + "-" + cam + ".mp4"
		if i := strings.LastIndexByte(src, '/'); i >= 0 && strings.HasSuffix(src, ".mp4") {
			name = src[i+1:]
		}
		h.Set("Content-Disposition", `attachment; filename="`+name+`"`)
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

// GET /organisations/{org}/vehicles/{vehicleId}/camera, the vehicle panel's
// live dashcam (src/api/vehicleCamera.js). The partner feed carries recorded
// alarm clips only, never a live stream, so this says which: no_camera for a
// unit that has never sent a camera alarm, not_configured (with where its
// clips are) for one that has.
func (s *Server) vehicleCamera(w http.ResponseWriter, r *http.Request) {
	v, ok := s.vehicleParam(w, r)
	if !ok {
		return
	}
	state, message := "no_camera", "This unit has sent no dashcam alarms."
	for _, e := range s.store.Events() {
		if e.VehicleID == v.VehicleID && isCameraEvent(e) {
			state, message = "not_configured", "The tracking partner sends recorded alarm clips, not a live feed. Its clips are on the Camera page."
			break
		}
	}
	writeData(w, map[string]any{
		"state": state, "deviceId": nil, "deviceName": nil,
		"channels": []any{}, "streamUrl": nil, "message": message,
	})
}
