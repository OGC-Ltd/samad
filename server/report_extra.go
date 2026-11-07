package main

// What Movements and End of Shift add to the store's figures: how far each
// unit went in the period (from its trip history) and where it is now, in
// words (Google's geocoder). Both used to be worked out in the browser, one
// request per unit; here they are cached, so a second report over the same
// days answers at once.
//
//	trip history  per unit per fleet day; a past day is kept (it cannot
//	              change), today for three minutes. Up to histMaxDays days
//	              are held, the least recently read dropped first.
//	place names   per position rounded to ~100 m, for a week.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	histMaxDays  = 600 // unit-days of fixes kept, ~16 bytes a fix
	histTodayTTL = 3 * time.Minute
	placeTTL     = 7 * 24 * time.Hour
	placeMax     = 5000
	// A jump faster than this between two fixes is the GPS, not driving.
	maxKmh = 160
)

type fix struct {
	t        int64 // unix ms
	lat, lng float32
}

type histDay struct {
	fixes []fix
	until time.Time // the end of what was read
	at    time.Time // when it was read
	used  time.Time
}

type place struct {
	name string
	at   time.Time
}

// reportCache is the Server's: trip history and place names for the reports.
type reportCache struct {
	mu     sync.Mutex
	days   map[string]*histDay // "vehicleID|YYYY-MM-DD"
	names  map[string]place    // "lat,lng" to 3 decimals
	geo    *http.Client
	geoURL string // overridden by the tests
	warned bool

	// One raster render at a time: a JPEG sheet is ~50 MB while it is drawn.
	draw chan struct{}
}

func newReportCache() *reportCache {
	return &reportCache{
		days: map[string]*histDay{}, names: map[string]place{},
		geo:    instrument(&http.Client{Timeout: googleTimeout}, "google"),
		geoURL: "https://maps.googleapis.com/maps/api/geocode/json",
		draw:   make(chan struct{}, 1),
	}
}

// historian is the partner client as the cache uses it (a fake in the tests).
type historian interface {
	History(ctx context.Context, vehicleID int, from, to time.Time) ([]PHistoryPoint, error)
}

// dayFixes is one unit's fixes for the fleet day starting at `start`, read
// up to `now` for today.
func (c *reportCache) dayFixes(ctx context.Context, h historian, vid int, start, now time.Time) ([]fix, error) {
	end := start.Add(24 * time.Hour)
	closed := !end.After(now.Add(-10 * time.Minute)) // the partner may lag a few minutes
	key := fmt.Sprintf("%d|%s", vid, fleetDay(start))
	c.mu.Lock()
	if d := c.days[key]; d != nil && (closed && !d.until.Before(end) || now.Sub(d.at) < histTodayTTL) {
		d.used = now
		c.mu.Unlock()
		return d.fixes, nil
	}
	c.mu.Unlock()

	until := end
	if !closed {
		until = now
	}
	hist, err := h.History(ctx, vid, start, until)
	if err != nil {
		return nil, err
	}
	fixes := make([]fix, 0, len(hist))
	for _, p := range hist {
		t := parseTime(p.Timestamp)
		if t.IsZero() || (p.Latitude == 0 && p.Longitude == 0) {
			continue
		}
		fixes = append(fixes, fix{t.UnixMilli(), float32(p.Latitude), float32(p.Longitude)})
	}
	c.mu.Lock()
	c.days[key] = &histDay{fixes: fixes, until: until, at: now, used: now}
	for len(c.days) > histMaxDays {
		var oldest string
		var t time.Time
		for k, d := range c.days {
			if oldest == "" || d.used.Before(t) {
				oldest, t = k, d.used
			}
		}
		delete(c.days, oldest)
	}
	c.mu.Unlock()
	return fixes, nil
}

// distanceKm is the length of a run of fixes, GPS jumps left out.
func distanceKm(fixes []fix) float64 {
	total := 0.0
	for i := 1; i < len(fixes); i++ {
		a, b := fixes[i-1], fixes[i]
		d := haversineKm(float64(a.lat), float64(a.lng), float64(b.lat), float64(b.lng))
		hours := float64(b.t-a.t) / 3_600_000
		if hours > 0 && d/hours > maxKmh {
			continue
		}
		total += d
	}
	return total
}

// distances is each unit's km in [from, to): nil where its history could not
// be read. Three units at a time; the partner client spaces the requests.
func (c *reportCache) distances(ctx context.Context, h historian, units []rptUnit, from, to, now time.Time) (map[string]*float64, error) {
	out := make(map[string]*float64, len(units))
	var mu sync.Mutex
	jobs := make(chan rptUnit)
	var wg sync.WaitGroup
	for w := 0; w < 3; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for u := range jobs {
				km, ok := c.unitKm(ctx, h, u, from, to, now)
				mu.Lock()
				if ok {
					out[u.VehicleID] = &km
				} else {
					out[u.VehicleID] = nil
				}
				mu.Unlock()
			}
		}()
	}
	for _, u := range units {
		select {
		case jobs <- u:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(jobs)
	wg.Wait()
	return out, ctx.Err()
}

func (c *reportCache) unitKm(ctx context.Context, h historian, u rptUnit, from, to, now time.Time) (float64, bool) {
	vid := u.ID
	if vid <= 0 {
		return 0, false
	}
	var run []fix
	lo, hi := from.UnixMilli(), to.UnixMilli()
	for day := dayStartOf(from); day.Before(to); day = day.Add(24 * time.Hour) {
		fixes, err := c.dayFixes(ctx, h, vid, day, now)
		if err != nil {
			return 0, false
		}
		for _, f := range fixes {
			if f.t >= lo && f.t < hi {
				run = append(run, f)
			}
		}
	}
	return math10(distanceKm(run)), true
}

func math10(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }

// ── place names ──────────────────────────────────────────────────────────

type geoResult struct {
	FormattedAddress  string `json:"formatted_address"`
	AddressComponents []struct {
		LongName string   `json:"long_name"`
		Types    []string `json:"types"`
	} `json:"address_components"`
}

var plusCode = regexp.MustCompile(`^[A-Z0-9]{4}\+[A-Z0-9]{2,3},?\s*`)

// placeWords is "A109 Road, Voi": the road and the town, never the country
// or a plus code (operator, 2026-11-05).
func placeWords(r geoResult) string {
	of := func(t string) string {
		for _, c := range r.AddressComponents {
			for _, x := range c.Types {
				if x == t {
					return c.LongName
				}
			}
		}
		return ""
	}
	road := of("route")
	if road == "Unnamed Road" {
		road = ""
	}
	town := ""
	for _, t := range []string{"locality", "sublocality", "postal_town", "administrative_area_level_3", "administrative_area_level_2", "administrative_area_level_1"} {
		if town = of(t); town != "" {
			break
		}
	}
	var words []string
	for _, w := range []string{road, town} {
		if w != "" && (len(words) == 0 || words[0] != w) {
			words = append(words, w)
		}
	}
	if len(words) > 0 {
		return strings.Join(words, ", ")
	}
	text := plusCode.ReplaceAllString(r.FormattedAddress, "")
	text = strings.TrimSuffix(strings.TrimSpace(text), "Kenya")
	text = strings.TrimSuffix(strings.TrimSpace(text), ",")
	return strings.TrimSpace(text)
}

// places is where each unit is now, in words: its zone when it is in one,
// else the place Google names. A unit with neither is left out (the report
// then shows its coordinates). Without a key, only zones.
func (c *reportCache) places(ctx context.Context, key string, units []rptUnit) map[string]string {
	out := map[string]string{}
	for _, u := range units {
		if !u.HasPos {
			continue
		}
		if u.ZoneNow != "" {
			out[u.VehicleID] = u.ZoneNow
			continue
		}
		if key == "" || ctx.Err() != nil {
			continue
		}
		if name := c.lookUp(ctx, key, u.Lat, u.Lng); name != "" {
			out[u.VehicleID] = name
		}
	}
	return out
}

func (c *reportCache) lookUp(ctx context.Context, key string, lat, lng float64) string {
	k := fmt.Sprintf("%.3f,%.3f", lat, lng)
	now := time.Now()
	c.mu.Lock()
	if p, ok := c.names[k]; ok && now.Sub(p.at) < placeTTL {
		c.mu.Unlock()
		return p.name
	}
	c.mu.Unlock()

	q := url.Values{"latlng": {fmt.Sprintf("%.6f,%.6f", lat, lng)}, "key": {key}, "language": {"en"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.geoURL+"?"+q.Encode(), nil)
	if err != nil {
		return ""
	}
	res, err := c.geo.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	var body struct {
		Status       string      `json:"status"`
		ErrorMessage string      `json:"error_message"`
		Results      []geoResult `json:"results"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return ""
	}
	name := ""
	switch body.Status {
	case "OK":
		name = placeWords(body.Results[0])
	case "ZERO_RESULTS":
	default:
		// A key without the Geocoding API: say so once, keep the zones and coordinates.
		c.mu.Lock()
		if !c.warned {
			c.warned = true
			log.Printf("reports: geocoding refused (%s %s): current locations fall back to zones and coordinates", body.Status, body.ErrorMessage)
		}
		c.mu.Unlock()
		return ""
	}
	c.mu.Lock()
	c.names[k] = place{name, now}
	if len(c.names) > placeMax {
		for k2, p := range c.names {
			if now.Sub(p.at) >= placeTTL || len(c.names) > placeMax {
				delete(c.names, k2)
			}
		}
	}
	c.mu.Unlock()
	return name
}
