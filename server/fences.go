package main

// Geofences drawn in Samad (operator, 2026-11-26: "the option to draw
// geofence in Samad like the way we are doing with Rai Track"). The partner's
// zones stay read-only and keep their own alerts; these are ours, kept in
// DATA_DIR/geofences.json and drawn on the map beside them.
//
//	POST   /organisations/{org}/geofences        geofence:create
//	PATCH  /organisations/{org}/geofences/{id}   geofence:update
//	DELETE /organisations/{org}/geofences/{id}   geofence:delete
//
// The bodies are the site's lib/fenceShape toPayload (the Rai Track draw
// tool): a POLYGON ring or LINE path as [lng, lat] pairs, or a CIRCLE centre
// and radius. A removal keeps the fence in the file, marked removed, so it
// can be put back by hand.
//
// Step 1 of 3: drawn and shown only. They raise no alerts yet and are not in
// Store.Geofences, which the reports and the reefer consignments read.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

const (
	fenceMax       = 5000 // the file keeps at most this many (removed ones included)
	fenceNameMax   = 120
	fencePointsMax = 5000
	fenceRadiusMin = 10.0
	fenceRadiusMax = 100_000.0
	fenceWidthMin  = 2.0
	fenceWidthMax  = 2_000.0
)

// What a fence can be for: the site's FENCE_PURPOSES (lib/zoneLegend).
var fencePurposes = []string{
	"restricted", "perimeter", "gate", "yard", "parking", "workshop", "fuel", "weighing",
	"logistics", "customer", "facility", "road", "other",
}

var fenceColour = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type Fence struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Purpose   string       `json:"purpose"`
	Color     string       `json:"color,omitempty"`
	Type      string       `json:"type"`             // POLYGON | CIRCLE | LINE
	Coords    [][2]float64 `json:"coords,omitempty"` // [lng, lat]: a polygon's closed ring, a line's path
	CenterLat float64      `json:"centerLat,omitempty"`
	CenterLng float64      `json:"centerLng,omitempty"`
	RadiusM   float64      `json:"radiusM,omitempty"`
	WidthM    float64      `json:"widthM,omitempty"`

	CreatedBy string `json:"createdBy"`
	CreatedAt string `json:"createdAt"`
	UpdatedBy string `json:"updatedBy"`
	UpdatedAt string `json:"updatedAt"`
	// Set when it is removed: it stays in the file, off the map.
	RemovedBy string `json:"removedBy,omitempty"`
	RemovedAt string `json:"removedAt,omitempty"`
}

// fenceBody is a create or change as the site sends it. On a change, a
// missing field keeps what the fence had; `color: null` clears the colour.
type fenceBody struct {
	Name          *string          `json:"name"`
	Purpose       *string          `json:"purpose"`
	Color         *json.RawMessage `json:"color"`
	Type          *string          `json:"type"`
	PolygonCoords [][]float64      `json:"polygonCoords"`
	CenterLat     *float64         `json:"centerLat"`
	CenterLng     *float64         `json:"centerLng"`
	RadiusM       *float64         `json:"radiusM"`
	WidthM        *float64         `json:"widthM"`
}

var errNoFence = errors.New("no such geofence")

// badFence is a body that cannot be saved, in words for the person drawing.
type badFence string

func (b badFence) Error() string { return string(b) }

func badf(format string, a ...any) error { return badFence(fmt.Sprintf(format, a...)) }

type Fences struct {
	mu   sync.Mutex
	path string
	list []Fence
}

func NewFences(dir string) *Fences {
	f := &Fences{path: filepath.Join(dir, "geofences.json")}
	b, err := os.ReadFile(f.path)
	if errors.Is(err, fs.ErrNotExist) {
		return f
	}
	if err == nil {
		err = json.Unmarshal(b, &f.list)
	}
	if err != nil {
		log.Printf("geofences: %s unreadable, starting empty: %v", f.path, err)
		f.list = nil
	}
	return f
}

func (f *Fences) saveLocked() error {
	b, err := json.MarshalIndent(f.list, "", "  ")
	if err != nil {
		return err
	}
	tmp := f.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.path)
}

// Live is every fence not removed, in the order drawn.
func (f *Fences) Live() []Fence {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Fence, 0, len(f.list))
	for _, x := range f.list {
		if x.RemovedAt == "" {
			out = append(out, x)
		}
	}
	return out
}

func (f *Fences) Create(b fenceBody, by string, now time.Time) (Fence, error) {
	var x Fence
	if err := x.apply(b, true); err != nil {
		return Fence{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.list) >= fenceMax {
		return Fence{}, badf("there are already %d geofences", fenceMax)
	}
	ts := now.UTC().Format(time.RFC3339)
	x.ID, x.CreatedBy, x.CreatedAt, x.UpdatedBy, x.UpdatedAt = newID(), by, ts, by, ts
	f.list = append(f.list, x)
	if err := f.saveLocked(); err != nil {
		f.list = f.list[:len(f.list)-1]
		return Fence{}, err
	}
	return x, nil
}

func (f *Fences) Update(id string, b fenceBody, by string, now time.Time) (Fence, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.indexLocked(id)
	if i < 0 {
		return Fence{}, errNoFence
	}
	x := f.list[i]
	if err := x.apply(b, false); err != nil {
		return Fence{}, err
	}
	x.UpdatedBy, x.UpdatedAt = by, now.UTC().Format(time.RFC3339)
	was := f.list[i]
	f.list[i] = x
	if err := f.saveLocked(); err != nil {
		f.list[i] = was
		return Fence{}, err
	}
	return x, nil
}

func (f *Fences) Remove(id, by string, now time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.indexLocked(id)
	if i < 0 {
		return errNoFence
	}
	was := f.list[i]
	f.list[i].RemovedBy, f.list[i].RemovedAt = by, now.UTC().Format(time.RFC3339)
	if err := f.saveLocked(); err != nil {
		f.list[i] = was
		return err
	}
	return nil
}

// indexLocked is a fence not removed, or -1.
func (f *Fences) indexLocked(id string) int {
	for i, x := range f.list {
		if x.ID == id && x.RemovedAt == "" {
			return i
		}
	}
	return -1
}

// apply checks a body and puts it on the fence. `whole`: a new fence, which
// needs a name, a purpose and a shape.
func (x *Fence) apply(b fenceBody, whole bool) error {
	if b.Name != nil || whole {
		name := ""
		if b.Name != nil {
			name = strings.TrimSpace(*b.Name)
		}
		if name == "" {
			return badf("give the geofence a name")
		}
		if len([]rune(name)) > fenceNameMax {
			return badf("a name is at most %d characters", fenceNameMax)
		}
		x.Name = name
	}
	if b.Purpose != nil || whole {
		p := ""
		if b.Purpose != nil {
			p = *b.Purpose
		}
		if !slices.Contains(fencePurposes, p) {
			return badf("choose what the geofence is for")
		}
		x.Purpose = p
	}
	if b.Color != nil {
		var c *string
		if err := json.Unmarshal(*b.Color, &c); err != nil {
			return badf("a colour is like #1d4ed8")
		}
		switch {
		case c == nil || *c == "":
			x.Color = ""
		case fenceColour.MatchString(*c):
			x.Color = strings.ToLower(*c)
		default:
			return badf("a colour is like #1d4ed8")
		}
	}
	if b.Type == nil {
		if whole {
			return badf("draw the geofence's shape")
		}
		return nil
	}
	return x.applyShape(b)
}

func (x *Fence) applyShape(b fenceBody) error {
	var s Fence // the shape alone, put on x once it is all good
	s.Type = strings.ToUpper(*b.Type)
	switch s.Type {
	case "CIRCLE":
		if b.CenterLat == nil || b.CenterLng == nil || !validLatLng(*b.CenterLat, *b.CenterLng) {
			return badf("a circle needs its centre")
		}
		if b.RadiusM == nil || !(*b.RadiusM >= fenceRadiusMin && *b.RadiusM <= fenceRadiusMax) {
			return badf("a circle's radius is %.0f m to %.0f km", fenceRadiusMin, fenceRadiusMax/1000)
		}
		s.CenterLat, s.CenterLng, s.RadiusM = *b.CenterLat, *b.CenterLng, math.Round(*b.RadiusM)
	case "POLYGON", "LINE":
		pts, err := lngLats(b.PolygonCoords)
		if err != nil {
			return err
		}
		if s.Type == "POLYGON" {
			if len(pts) > 0 && pts[0] != pts[len(pts)-1] {
				pts = append(pts, pts[0]) // stored closed
			}
			if distinct(pts) < 3 {
				return badf("a shape needs at least 3 different corners")
			}
		} else {
			if distinct(pts) < 2 {
				return badf("a road needs at least 2 points")
			}
			if b.WidthM == nil || !(*b.WidthM >= fenceWidthMin && *b.WidthM <= fenceWidthMax) {
				return badf("a road's width is %.0f m to %.0f m", fenceWidthMin, fenceWidthMax)
			}
			s.WidthM = math.Round(*b.WidthM)
		}
		s.Coords = pts
	default:
		return badf("the shape is a POLYGON, CIRCLE or LINE")
	}
	x.Type, x.Coords, x.CenterLat, x.CenterLng, x.RadiusM, x.WidthM = s.Type, s.Coords, s.CenterLat, s.CenterLng, s.RadiusM, s.WidthM
	return nil
}

func validLatLng(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

func lngLats(in [][]float64) ([][2]float64, error) {
	if len(in) > fencePointsMax {
		return nil, badf("a shape has at most %d points", fencePointsMax)
	}
	out := make([][2]float64, 0, len(in))
	for _, p := range in {
		if len(p) != 2 || !validLatLng(p[1], p[0]) {
			return nil, badf("a point is [longitude, latitude] on Earth")
		}
		out = append(out, [2]float64{p[0], p[1]})
	}
	return out, nil
}

func distinct(pts [][2]float64) int {
	seen := map[[2]float64]bool{}
	for _, p := range pts {
		seen[p] = true
	}
	return len(seen)
}

// areaHa: a polygon's area on a local flat projection (good to well under a
// percent at fence sizes), a circle's πr², a road's length × width.
func (x Fence) areaHa() float64 {
	const mPerDeg = 111_320.0
	switch x.Type {
	case "CIRCLE":
		return math.Pi * x.RadiusM * x.RadiusM / 10_000
	case "LINE":
		m := 0.0
		for i := 1; i < len(x.Coords); i++ {
			a, b := x.Coords[i-1], x.Coords[i]
			m += haversineKm(a[1], a[0], b[1], b[0]) * 1000
		}
		return m * x.WidthM / 10_000
	}
	if len(x.Coords) < 4 {
		return 0
	}
	lat0 := x.Coords[0][1] * math.Pi / 180
	s := 0.0
	for i := 1; i < len(x.Coords); i++ {
		a, b := x.Coords[i-1], x.Coords[i]
		ax, ay := a[0]*mPerDeg*math.Cos(lat0), a[1]*mPerDeg
		bx, by := b[0]*mPerDeg*math.Cos(lat0), b[1]*mPerDeg
		s += ax*by - bx*ay
	}
	return math.Abs(s) / 2 / 10_000
}

// feature is the fence as the map's GeoJSON draws it, beside the partner's
// (geofencesGeoJSON): a Polygon, a Point with radiusM, or a LineString with
// widthM. source "samad" marks it as ours to change.
func (x Fence) feature() map[string]any {
	props := map[string]any{
		"id": x.ID, "name": x.Name, "category": x.Purpose, "purpose": x.Purpose,
		"fenceType": x.Type, "mode": nil, "isActive": true,
		"widthM": nil, "radiusM": nil, "areaHa": math.Round(x.areaHa()*100) / 100,
		"source": "samad", "createdBy": x.CreatedBy, "updatedBy": x.UpdatedBy, "updatedAt": x.UpdatedAt,
	}
	if x.Color != "" {
		props["color"] = x.Color
	}
	var geom map[string]any
	switch x.Type {
	case "CIRCLE":
		props["radiusM"] = x.RadiusM
		geom = map[string]any{"type": "Point", "coordinates": []float64{x.CenterLng, x.CenterLat}}
	case "LINE":
		props["widthM"] = x.WidthM
		geom = map[string]any{"type": "LineString", "coordinates": x.Coords}
	default:
		geom = map[string]any{"type": "Polygon", "coordinates": [][][2]float64{x.Coords}}
	}
	return map[string]any{"type": "Feature", "properties": props, "geometry": geom}
}

// ── handlers ──────────────────────────────────────────────────────────────

func readFenceBody(w http.ResponseWriter, r *http.Request) (fenceBody, bool) {
	var b fenceBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b); err != nil {
		writeError(w, http.StatusBadRequest, "the geofence could not be read")
		return b, false
	}
	return b, true
}

func whoIs(r *http.Request) string {
	u := currentUser(r.Context())
	if u.FullName != "" {
		return u.FullName
	}
	return u.Email
}

// fenceFailed: a body that cannot be saved is the person's to fix (400, in
// their words); anything else is the server's (500, logged).
func fenceFailed(w http.ResponseWriter, err error) {
	var bad badFence
	switch {
	case errors.Is(err, errNoFence):
		writeError(w, http.StatusNotFound, "That geofence is not there any more")
	case errors.As(err, &bad):
		msg := string(bad)
		writeError(w, http.StatusBadRequest, strings.ToUpper(msg[:1])+msg[1:]+".")
	default:
		log.Printf("geofences: save: %v", err)
		writeError(w, http.StatusInternalServerError, "The geofence could not be saved")
	}
}

// POST /organisations/{org}/geofences
func (s *Server) createFence(w http.ResponseWriter, r *http.Request) {
	b, ok := readFenceBody(w, r)
	if !ok {
		return
	}
	x, err := s.fences.Create(b, whoIs(r), time.Now())
	if err != nil {
		fenceFailed(w, err)
		return
	}
	writeData(w, x.feature())
}

// PATCH /organisations/{org}/geofences/{id}
func (s *Server) updateFence(w http.ResponseWriter, r *http.Request) {
	b, ok := readFenceBody(w, r)
	if !ok {
		return
	}
	x, err := s.fences.Update(mux.Vars(r)["id"], b, whoIs(r), time.Now())
	if err != nil {
		fenceFailed(w, err)
		return
	}
	writeData(w, x.feature())
}

// DELETE /organisations/{org}/geofences/{id}
func (s *Server) removeFence(w http.ResponseWriter, r *http.Request) {
	if err := s.fences.Remove(mux.Vars(r)["id"], whoIs(r), time.Now()); err != nil {
		fenceFailed(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
