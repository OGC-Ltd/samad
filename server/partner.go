package main

// The IntelliFleet360 Partner API (Samad_Resources_Partner_API_Guide.docx):
// read-only, X-Api-Key on every request, 120 requests a minute and at most
// 30 in any 10 seconds. Every answer is { success, message, data }.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

type PartnerClient struct {
	base string
	key  string
	http *http.Client

	// One request every 600 ms keeps us at 100 a minute and 17 per 10 s,
	// under both limits whatever the pollers and the UI ask for at once.
	mu   sync.Mutex
	next time.Time
}

func NewPartnerClient(base, key string) *PartnerClient {
	return &PartnerClient{base: base, key: key, http: &http.Client{Timeout: 30 * time.Second}}
}

const partnerGap = 600 * time.Millisecond

func (c *PartnerClient) wait(ctx context.Context) error {
	c.mu.Lock()
	now := time.Now()
	at := c.next
	if at.Before(now) {
		at = now
	}
	c.next = at.Add(partnerGap)
	c.mu.Unlock()
	if d := time.Until(at); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// PartnerError carries the partner's status, so a handler can pass a 404 on.
type PartnerError struct {
	Status int
	Body   string
}

func (e *PartnerError) Error() string {
	return fmt.Sprintf("partner api: HTTP %d: %.200s", e.Status, e.Body)
}

// get calls one endpoint and decodes `data` into out. A 429 waits out its
// Retry-After once and tries again.
func (c *PartnerClient) get(ctx context.Context, path string, q url.Values, out any) error {
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	for attempt := 0; ; attempt++ {
		if err := c.wait(ctx); err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return err
		}
		req.Header.Set("X-Api-Key", c.key)
		req.Header.Set("Accept", "application/json")
		res, err := c.http.Do(req)
		if err != nil {
			return err
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			return err
		}
		if res.StatusCode == http.StatusTooManyRequests && attempt == 0 {
			secs, _ := strconv.Atoi(res.Header.Get("Retry-After"))
			if secs <= 0 || secs > 60 {
				secs = 10
			}
			select {
			case <-time.After(time.Duration(secs) * time.Second):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if res.StatusCode != http.StatusOK {
			return &PartnerError{Status: res.StatusCode, Body: string(body)}
		}
		var env struct {
			Success bool            `json:"success"`
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			return fmt.Errorf("partner api: %s: %w", path, err)
		}
		if !env.Success {
			return fmt.Errorf("partner api: %s: %s", path, env.Message)
		}
		return json.Unmarshal(env.Data, out)
	}
}

// ── shapes ─────────────────────────────────────────────────────────────────

type PDevice struct {
	DeviceID int    `json:"device_id"`
	IMEI     string `json:"imei"`
}

type PPerson struct {
	ID   int    `json:"driver_id"`
	Name string `json:"name"`
}

type POwner struct {
	ID   int    `json:"owner_id"`
	Name string `json:"name"`
}

type PPosition struct {
	Latitude     float64  `json:"latitude"`
	Longitude    float64  `json:"longitude"`
	Speed        float64  `json:"speed"`
	Course       float64  `json:"course"`
	Engine       string   `json:"engine"`
	MotionStatus string   `json:"motion_status"`
	LastUpdate   string   `json:"last_update"`
	AgeSeconds   int      `json:"age_seconds"`
	Satellites   int      `json:"gps_satellites"`
	DeviceTempC  *float64 `json:"device_temperature_c"`
}

type PVehicle struct {
	VehicleID    int        `json:"vehicle_id"`
	Registration string     `json:"registration"`
	Type         string     `json:"type"`
	Make         string     `json:"make"`
	Model        string     `json:"model"`
	Status       string     `json:"status"`
	Device       *PDevice   `json:"device"`
	Driver       *PPerson   `json:"driver"`
	Owner        *POwner    `json:"owner"`
	Position     *PPosition `json:"position"`
}

type PHistoryPoint struct {
	Timestamp string  `json:"timestamp"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Speed     float64 `json:"speed"`
	Course    float64 `json:"course"`
	Ignition  bool    `json:"ignition"`
}

type PEvent struct {
	EventID      string   `json:"event_id"`
	Source       string   `json:"source"`
	Type         string   `json:"type"`
	TypeLabel    string   `json:"type_label"`
	AlarmCode    *int     `json:"alarm_code"`
	Severity     string   `json:"severity"`
	OccurredAt   string   `json:"occurred_at"`
	ReceivedAt   string   `json:"received_at"`
	VehicleID    int      `json:"vehicle_id"`
	Registration string   `json:"registration"`
	DeviceIMEI   string   `json:"device_imei"`
	Latitude     *float64 `json:"latitude"`
	Longitude    *float64 `json:"longitude"`
	Speed        *float64 `json:"speed"`
	Clips        *struct {
		RoadFacing   *string `json:"road_facing"`
		DriverFacing *string `json:"driver_facing"`
	} `json:"clips"`
	Geofence *struct {
		ZoneID   int    `json:"zone_id"`
		ZoneName string `json:"zone_name"`
		Action   string `json:"action"`
	} `json:"geofence"`
}

type PGeofence struct {
	ZoneID     int    `json:"zone_id"`
	Name       string `json:"name"`
	ZoneType   string `json:"zone_type"`
	ZoneAction string `json:"zone_action"`
	Status     string `json:"status"`
	Center     *struct {
		Lat float64 `json:"lat"`
		Lng float64 `json:"lng"`
	} `json:"center"`
	RadiusM     *float64 `json:"radius_m"`
	Coordinates *struct {
		Points []struct {
			Lat float64 `json:"lat"`
			Lng float64 `json:"lng"`
		} `json:"points"`
	} `json:"coordinates"`
	AlertsEnabled bool `json:"alerts_enabled"`
}

// ── calls ──────────────────────────────────────────────────────────────────

func (c *PartnerClient) Vehicles(ctx context.Context) ([]PVehicle, error) {
	var d struct {
		Vehicles []PVehicle `json:"vehicles"`
	}
	err := c.get(ctx, "/partner/v1/vehicles", nil, &d)
	return d.Vehicles, err
}

func (c *PartnerClient) Positions(ctx context.Context) ([]PVehicle, error) {
	var d struct {
		Vehicles []PVehicle `json:"vehicles"`
	}
	err := c.get(ctx, "/partner/v1/positions", nil, &d)
	return d.Vehicles, err
}

func (c *PartnerClient) Geofences(ctx context.Context) ([]PGeofence, error) {
	var d struct {
		Geofences []PGeofence `json:"geofences"`
	}
	err := c.get(ctx, "/partner/v1/geofences", nil, &d)
	return d.Geofences, err
}

// History reads one vehicle's fixes in [from, to), following next_cursor.
// The partner allows at most 24 h per request, so longer windows are split.
func (c *PartnerClient) History(ctx context.Context, vehicleID int, from, to time.Time) ([]PHistoryPoint, error) {
	var out []PHistoryPoint
	for start := from; start.Before(to); start = start.Add(24 * time.Hour) {
		end := start.Add(24 * time.Hour)
		if end.After(to) {
			end = to
		}
		cursor := ""
		for {
			q := url.Values{
				"from": {start.UTC().Format(time.RFC3339)},
				"to":   {end.UTC().Format(time.RFC3339)},
			}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			var d struct {
				Points     []PHistoryPoint `json:"points"`
				NextCursor *string         `json:"next_cursor"`
			}
			if err := c.get(ctx, fmt.Sprintf("/partner/v1/vehicles/%d/positions", vehicleID), q, &d); err != nil {
				return out, err
			}
			out = append(out, d.Points...)
			if d.NextCursor == nil || *d.NextCursor == "" {
				break
			}
			cursor = *d.NextCursor
		}
	}
	return out, nil
}

type EventPage struct {
	Events     []PEvent `json:"events"`
	HasMore    bool     `json:"has_more"`
	NextCursor string   `json:"next_cursor"`
}

// Events reads one page of the feed: from `cursor`, or from `since` when
// there is no cursor yet.
func (c *PartnerClient) Events(ctx context.Context, cursor string, since time.Time) (EventPage, error) {
	q := url.Values{"limit": {"500"}}
	if cursor != "" {
		q.Set("cursor", cursor)
	} else {
		q.Set("since", since.UTC().Format(time.RFC3339))
	}
	var p EventPage
	err := c.get(ctx, "/partner/v1/events", q, &p)
	return p, err
}
