package main

// Everything the server knows, in memory, with the parts that cannot be read
// back from the partner (the alerts already received, the feed cursor, read
// marks, decisions and the per-day distance tally) saved to DataDir.

import (
	"encoding/json"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// The one organisation this server serves.
const (
	OrgID   = "samad"
	OrgCode = "SAMAD"
	OrgName = "Samad Resources"
)

// Nairobi is UTC+3 all year: the fleet day is three hours on from UTC.
var fleetZone = time.FixedZone("EAT", 3*3600)

func fleetDay(t time.Time) string { return t.In(fleetZone).Format("2006-01-02") }

// fleetMidnight is the start of the fleet day `daysBack` days before today.
func fleetMidnight(now time.Time, daysBack int) time.Time {
	n := now.In(fleetZone)
	return time.Date(n.Year(), n.Month(), n.Day()-daysBack, 0, 0, 0, 0, fleetZone)
}

// Decision is an escalation or de-escalation of one alert.
type Decision struct {
	Outcome string  `json:"outcome"`
	Reason  *string `json:"reason"`
	Note    string  `json:"note"`
	By      string  `json:"by"`
	At      string  `json:"at"`
}

// DayStats is one vehicle's fleet day, tallied from the polled positions:
// the partner's /trips is not enabled for this key.
type DayStats struct {
	Km     float64 `json:"km"`
	Trips  int     `json:"trips"`
	Driver string  `json:"driver,omitempty"`
}

type persisted struct {
	Cursor    string                       `json:"cursor"`
	Events    []PEvent                     `json:"events"`
	Reads     map[string]map[string]bool   `json:"reads"`
	ReadAllAt map[string]string            `json:"readAllAt"`
	Decisions map[string][]Decision        `json:"decisions"`
	Days      map[string]map[int]*DayStats `json:"days"`
	// Fleet days already filled from position history (see Poller.backfill).
	Backfilled map[string]bool `json:"backfilled"`
}

type lastFix struct {
	at  time.Time
	lat float64
	lng float64
	on  bool
}

type Store struct {
	mu        sync.RWMutex
	path      string
	dirty     bool
	vehicles  map[int]PVehicle
	geofences []PGeofence
	fixes     map[int]lastFix
	p         persisted
	byID      map[string]bool
	roster    map[string]rosterEntry
}

// How long received alerts are kept.
const keepEventsFor = 30 * 24 * time.Hour

func NewStore(dir string) *Store {
	s := &Store{
		path:     filepath.Join(dir, "state.json"),
		vehicles: map[int]PVehicle{},
		fixes:    map[int]lastFix{},
		byID:     map[string]bool{},
		roster:   loadRoster(dir),
		p: persisted{
			Reads: map[string]map[string]bool{}, ReadAllAt: map[string]string{},
			Decisions: map[string][]Decision{}, Days: map[string]map[int]*DayStats{},
		},
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		log.Printf("store: %v", err)
	}
	if b, err := os.ReadFile(s.path); err == nil {
		if err := json.Unmarshal(b, &s.p); err != nil {
			log.Printf("store: %s unreadable, starting empty: %v", s.path, err)
		}
	}
	if s.p.Backfilled == nil {
		s.p.Backfilled = map[string]bool{}
	}
	for _, m := range []any{&s.p.Reads, &s.p.ReadAllAt, &s.p.Decisions, &s.p.Days} {
		switch v := m.(type) {
		case *map[string]map[string]bool:
			if *v == nil {
				*v = map[string]map[string]bool{}
			}
		case *map[string]string:
			if *v == nil {
				*v = map[string]string{}
			}
		case *map[string][]Decision:
			if *v == nil {
				*v = map[string][]Decision{}
			}
		case *map[string]map[int]*DayStats:
			if *v == nil {
				*v = map[string]map[int]*DayStats{}
			}
		}
	}
	for _, e := range s.p.Events {
		s.byID[e.EventID] = true
	}
	return s
}

// Save writes the persisted part if anything changed. Written to a temporary
// file and renamed, so a crash mid-write never leaves half a file.
func (s *Store) Save() {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	b, err := json.Marshal(s.p)
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		log.Printf("store: %v", err)
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("store: %v", err)
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		log.Printf("store: %v", err)
	}
}

// ── vehicles and positions ─────────────────────────────────────────────────

// SetVehicles takes the reference list (identity, driver, owner).
func (s *Store) SetVehicles(list []PVehicle) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range list {
		v = dress(v, s.roster)
		cur, ok := s.vehicles[v.VehicleID]
		if ok {
			v.Position = cur.Position
		}
		s.vehicles[v.VehicleID] = v
	}
}

func (s *Store) SetGeofences(list []PGeofence) {
	s.mu.Lock()
	s.geofences = list
	s.mu.Unlock()
}

// ApplyPositions takes a /positions read and returns the vehicles whose fix
// or state changed, for the live stream. It also tallies the day's distance
// and trips.
func (s *Store) ApplyPositions(list []PVehicle) []PVehicle {
	s.mu.Lock()
	defer s.mu.Unlock()
	var changed []PVehicle
	for _, v := range list {
		v = dress(v, s.roster)
		prev, had := s.vehicles[v.VehicleID]
		s.vehicles[v.VehicleID] = v
		if v.Position == nil {
			continue
		}
		if !had || prev.Position == nil || *prev.Position != *v.Position {
			changed = append(changed, v)
		}
		s.tally(v)
	}
	return changed
}

func (s *Store) tally(v PVehicle) {
	p := v.Position
	at, err := time.Parse(time.RFC3339, p.LastUpdate)
	if err != nil {
		return
	}
	on := p.Engine == "on"
	prev, had := s.fixes[v.VehicleID]
	s.fixes[v.VehicleID] = lastFix{at: at, lat: p.Latitude, lng: p.Longitude, on: on}
	if !had || !at.After(prev.at) {
		return
	}
	day := fleetDay(at)
	stats := s.p.Days[day]
	if stats == nil {
		stats = map[int]*DayStats{}
		s.p.Days[day] = stats
	}
	ds := stats[v.VehicleID]
	if ds == nil {
		ds = &DayStats{}
		stats[v.VehicleID] = ds
	}
	if v.Driver != nil {
		ds.Driver = v.Driver.Name
	}
	km := haversineKm(prev.lat, prev.lng, p.Latitude, p.Longitude)
	// A jump faster than 150 km/h between two fixes is a GPS glitch, not travel.
	if hours := at.Sub(prev.at).Hours(); hours > 0 && km/hours <= 150 {
		ds.Km += km
	}
	if on && !prev.on {
		ds.Trips++
	}
	s.dirty = true
}

func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371.0
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat, dLng := toRad(lat2-lat1), toRad(lng2-lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * r * math.Asin(math.Sqrt(a))
}

func (s *Store) Vehicles() []PVehicle {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]PVehicle, 0, len(s.vehicles))
	for _, v := range s.vehicles {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Registration < out[j].Registration })
	return out
}

func (s *Store) Vehicle(id int) (PVehicle, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.vehicles[id]
	return v, ok
}

func (s *Store) Geofences() []PGeofence {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.geofences
}

// Days returns the tallies for the given fleet days.
func (s *Store) Days(days []string) map[string]map[int]DayStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]map[int]DayStats{}
	for _, d := range days {
		m := map[int]DayStats{}
		for id, st := range s.p.Days[d] {
			m[id] = *st
		}
		out[d] = m
	}
	return out
}

func (s *Store) IsBackfilled(day string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.p.Backfilled[day]
}

// AddDay adds one vehicle's distance and trips to a fleet day and marks the
// day filled once every vehicle is in (`last`).
func (s *Store) AddDay(day string, vehicleID int, driver string, km float64, trips int, last bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats := s.p.Days[day]
	if stats == nil {
		stats = map[int]*DayStats{}
		s.p.Days[day] = stats
	}
	ds := stats[vehicleID]
	if ds == nil {
		ds = &DayStats{}
		stats[vehicleID] = ds
	}
	ds.Km += km
	ds.Trips += trips
	if driver != "" {
		ds.Driver = driver
	}
	if last {
		s.p.Backfilled[day] = true
	}
	s.dirty = true
}

// ── events (alerts) ────────────────────────────────────────────────────────

func (s *Store) Cursor() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.p.Cursor
}

// AddEvents stores new events and the cursor after them, and returns the
// ones not seen before (a replayed cursor repeats events; event_id dedupes).
func (s *Store) AddEvents(list []PEvent, cursor string) []PEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var fresh []PEvent
	for _, e := range list {
		if s.byID[e.EventID] {
			continue
		}
		s.byID[e.EventID] = true
		s.p.Events = append(s.p.Events, e)
		fresh = append(fresh, e)
	}
	if cursor != "" {
		s.p.Cursor = cursor
	}
	s.dirty = true
	return fresh
}

// Prune drops events and day tallies older than the keep window.
func (s *Store) Prune(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	floor := now.Add(-keepEventsFor)
	kept := s.p.Events[:0]
	for _, e := range s.p.Events {
		if t, err := time.Parse(time.RFC3339, e.ReceivedAt); err == nil && t.Before(floor) {
			delete(s.byID, e.EventID)
			delete(s.p.Decisions, e.EventID)
			for _, r := range s.p.Reads {
				delete(r, e.EventID)
			}
			continue
		}
		kept = append(kept, e)
	}
	s.p.Events = kept
	dayFloor := fleetDay(floor)
	for d := range s.p.Days {
		if d < dayFloor {
			delete(s.p.Days, d)
		}
	}
	s.dirty = true
}

// Events returns a copy of every stored event.
func (s *Store) Events() []PEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]PEvent(nil), s.p.Events...)
}

func (s *Store) Decisions(id string) []Decision {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Decision(nil), s.p.Decisions[id]...)
}

func (s *Store) Decide(id string, d Decision) {
	s.mu.Lock()
	s.p.Decisions[id] = append(s.p.Decisions[id], d)
	s.dirty = true
	s.mu.Unlock()
}

// IsRead: marked one by one, or received before the person's "mark all read".
func (s *Store) IsRead(user, id string, receivedAt string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.p.Reads[user][id] {
		return true
	}
	if all, ok := s.p.ReadAllAt[user]; ok && receivedAt <= all {
		return true
	}
	return false
}

func (s *Store) MarkRead(user string, ids []string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.p.Reads[user]
	if m == nil {
		m = map[string]bool{}
		s.p.Reads[user] = m
	}
	n := 0
	for _, id := range ids {
		if !m[id] {
			m[id] = true
			n++
		}
	}
	s.dirty = true
	return n
}

func (s *Store) MarkAllRead(user string, at time.Time) {
	s.mu.Lock()
	s.p.ReadAllAt[user] = at.UTC().Format(time.RFC3339)
	s.dirty = true
	s.mu.Unlock()
}
