package main

// Google Maps Platform from the server: Routes (computeRoutes and
// computeRouteMatrix, traffic aware) and Weather (current conditions), ported
// from fleet-server's providers/google-routing and providers/google-weather.
//
// One key, GOOGLE_ROUTING_API_KEY, kept in server/.env: a server key with the
// Routes API and the Weather API enabled, restricted to the box's address.
// The browser's Maps key is restricted by referrer and is never sent from
// here. No key, no routing and no weather: the dashboard keeps its
// straight-line ETA and hides the weather layer.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	googleTimeout = 10 * time.Second
	matrixMax     = 100 // origins per computeRouteMatrix request
)

type latLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// roadRoute is fleet-server's RoadRoute: path as [lat, lng] pairs.
type roadRoute struct {
	Path            [][2]float64 `json:"path"`
	DistanceM       int          `json:"distanceM"`
	DurationS       float64      `json:"durationS"`
	StaticDurationS float64      `json:"staticDurationS"`
}

type GoogleError struct {
	Status int
	Msg    string
}

func (e *GoogleError) Error() string { return e.Msg }

type Google struct {
	key    string
	client *http.Client
	// Overridden by the tests.
	routesBase, weatherBase string
}

func NewGoogle(key string) *Google {
	if key == "" {
		return nil
	}
	return &Google{
		key: key, client: instrument(&http.Client{Timeout: googleTimeout}, "google"),
		routesBase: "https://routes.googleapis.com", weatherBase: "https://weather.googleapis.com",
	}
}

// answer reads a Google reply, turning an error status into its message
// ("API not enabled", "key invalid") rather than a bare number.
func answer(res *http.Response, into any) error {
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		if e.Error.Message == "" {
			e.Error.Message = fmt.Sprintf("Google returned %d", res.StatusCode)
		}
		return &GoogleError{Status: res.StatusCode, Msg: e.Error.Message}
	}
	return json.Unmarshal(b, into)
}

func (g *Google) post(ctx context.Context, path, fieldMask string, body, into any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.routesBase+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", g.key)
	req.Header.Set("X-Goog-FieldMask", fieldMask)
	res, err := g.client.Do(req)
	if err != nil {
		return err
	}
	return answer(res, into)
}

func waypoint(p latLng) map[string]any {
	return map[string]any{"location": map[string]any{"latLng": map[string]any{"latitude": p.Lat, "longitude": p.Lng}}}
}

// seconds reads Google's "123s".
func seconds(d string) float64 {
	n, _ := strconv.ParseFloat(strings.TrimSuffix(d, "s"), 64)
	return n
}

// decodePolyline decodes Google's encoded polyline into [lat, lng] pairs.
func decodePolyline(enc string) [][2]float64 {
	var out [][2]float64
	i, lat, lng := 0, 0, 0
	for i < len(enc) {
		var vals [2]int
		for k := range vals {
			shift, result := 0, 0
			for i < len(enc) {
				b := int(enc[i]) - 63
				i++
				result |= (b & 0x1f) << shift
				shift += 5
				if b < 0x20 {
					break
				}
			}
			if result&1 != 0 {
				vals[k] = ^(result >> 1)
			} else {
				vals[k] = result >> 1
			}
		}
		lat += vals[0]
		lng += vals[1]
		out = append(out, [2]float64{float64(lat) / 1e5, float64(lng) / 1e5})
	}
	return out
}

// Route is the traffic-aware road from origin to destination, or nil when
// Google finds none.
func (g *Google) Route(ctx context.Context, origin, dest latLng) (*roadRoute, error) {
	var j struct {
		Routes []struct {
			DistanceMeters int    `json:"distanceMeters"`
			Duration       string `json:"duration"`
			StaticDuration string `json:"staticDuration"`
			Polyline       struct {
				EncodedPolyline string `json:"encodedPolyline"`
			} `json:"polyline"`
		} `json:"routes"`
	}
	err := g.post(ctx, "/directions/v2:computeRoutes",
		"routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline",
		map[string]any{
			"origin": waypoint(origin), "destination": waypoint(dest),
			"travelMode": "DRIVE", "routingPreference": "TRAFFIC_AWARE", "polylineQuality": "OVERVIEW",
		}, &j)
	if err != nil || len(j.Routes) == 0 || j.Routes[0].Polyline.EncodedPolyline == "" {
		return nil, err
	}
	r := j.Routes[0]
	static := r.StaticDuration
	if static == "" {
		static = r.Duration
	}
	return &roadRoute{
		Path: decodePolyline(r.Polyline.EncodedPolyline), DistanceM: r.DistanceMeters,
		DurationS: seconds(r.Duration), StaticDurationS: seconds(static),
	}, nil
}

type matrixCell struct {
	Index           int
	DurationS       float64
	StaticDurationS float64
	DistanceM       int
}

// MatrixTo is the drive from each origin to one destination. Origins Google
// cannot route are left out.
func (g *Google) MatrixTo(ctx context.Context, origins []latLng, dest latLng, mode string) ([]matrixCell, error) {
	if len(origins) == 0 {
		return nil, nil
	}
	if len(origins) > matrixMax {
		return nil, &GoogleError{Status: 400, Msg: fmt.Sprintf("At most %d origins a request", matrixMax)}
	}
	list := make([]any, len(origins))
	for i, o := range origins {
		list[i] = map[string]any{"waypoint": waypoint(o)}
	}
	var rows []struct {
		OriginIndex    int    `json:"originIndex"`
		Duration       string `json:"duration"`
		StaticDuration string `json:"staticDuration"`
		DistanceMeters int    `json:"distanceMeters"`
		Condition      string `json:"condition"`
	}
	err := g.post(ctx, "/distanceMatrix/v2:computeRouteMatrix",
		"originIndex,duration,staticDuration,distanceMeters,condition",
		map[string]any{
			"origins": list, "destinations": []any{map[string]any{"waypoint": waypoint(dest)}},
			"travelMode": mode, "routingPreference": "TRAFFIC_AWARE",
		}, &rows)
	if err != nil {
		return nil, err
	}
	var out []matrixCell
	for _, r := range rows {
		if r.Condition != "ROUTE_EXISTS" {
			continue
		}
		static := r.StaticDuration
		if static == "" {
			static = r.Duration
		}
		out = append(out, matrixCell{Index: r.OriginIndex, DurationS: seconds(r.Duration), StaticDurationS: seconds(static), DistanceM: r.DistanceMeters})
	}
	return out, nil
}

// weatherPoint is fleet-server's WeatherPoint.
type weatherPoint struct {
	Lat          float64  `json:"lat"`
	Lng          float64  `json:"lng"`
	Type         string   `json:"type"`
	Text         string   `json:"text"`
	Icon         *string  `json:"icon"`
	TempC        *float64 `json:"tempC"`
	FeelsLikeC   *float64 `json:"feelsLikeC"`
	RainPct      *float64 `json:"rainPct"`
	ThunderPct   *float64 `json:"thunderPct"`
	WindKmh      *float64 `json:"windKmh"`
	GustKmh      *float64 `json:"gustKmh"`
	WindFrom     *string  `json:"windFrom"`
	WindDeg      *float64 `json:"windDeg"`
	RainMm       *float64 `json:"rainMm"`
	VisibilityKm *float64 `json:"visibilityKm"`
	HumidityPct  *float64 `json:"humidityPct"`
	IsDay        *bool    `json:"isDay"`
	At           string   `json:"at"`
}

type measure struct {
	Degrees  *float64 `json:"degrees"`
	Value    *float64 `json:"value"`
	Distance *float64 `json:"distance"`
	Percent  *float64 `json:"percent"`
}

// Conditions are the current conditions at one point, or nil where Google
// has none (open sea).
func (g *Google) Conditions(ctx context.Context, lat, lng float64) (*weatherPoint, error) {
	q := url.Values{}
	q.Set("key", g.key)
	q.Set("location.latitude", strconv.FormatFloat(lat, 'f', -1, 64))
	q.Set("location.longitude", strconv.FormatFloat(lng, 'f', -1, 64))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.weatherBase+"/v1/currentConditions:lookup?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	res, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	var c struct {
		WeatherCondition *struct {
			IconBaseURI *string `json:"iconBaseUri"`
			Description struct {
				Text string `json:"text"`
			} `json:"description"`
			Type string `json:"type"`
		} `json:"weatherCondition"`
		Temperature          measure `json:"temperature"`
		FeelsLikeTemperature measure `json:"feelsLikeTemperature"`
		Precipitation        struct {
			Probability measure `json:"probability"`
			Qpf         struct {
				Quantity *float64 `json:"quantity"`
			} `json:"qpf"`
		} `json:"precipitation"`
		ThunderstormProbability *float64 `json:"thunderstormProbability"`
		Wind                    struct {
			Direction struct {
				Cardinal *string  `json:"cardinal"`
				Degrees  *float64 `json:"degrees"`
			} `json:"direction"`
			Speed measure `json:"speed"`
			Gust  measure `json:"gust"`
		} `json:"wind"`
		Visibility       measure  `json:"visibility"`
		RelativeHumidity *float64 `json:"relativeHumidity"`
		IsDaytime        *bool    `json:"isDaytime"`
		CurrentTime      string   `json:"currentTime"`
	}
	if err := answer(res, &c); err != nil {
		return nil, err
	}
	p := &weatherPoint{
		Lat: lat, Lng: lng, Type: "UNKNOWN",
		TempC: c.Temperature.Degrees, FeelsLikeC: c.FeelsLikeTemperature.Degrees,
		RainPct: c.Precipitation.Probability.Percent, ThunderPct: c.ThunderstormProbability,
		WindKmh: c.Wind.Speed.Value, GustKmh: c.Wind.Gust.Value,
		WindFrom: c.Wind.Direction.Cardinal, WindDeg: c.Wind.Direction.Degrees,
		RainMm: c.Precipitation.Qpf.Quantity, VisibilityKm: c.Visibility.Distance,
		HumidityPct: c.RelativeHumidity, IsDay: c.IsDaytime, At: c.CurrentTime,
	}
	if w := c.WeatherCondition; w != nil {
		p.Type, p.Text, p.Icon = w.Type, w.Description.Text, w.IconBaseURI
		if p.Type == "" {
			p.Type = "UNKNOWN"
		}
	}
	if p.At == "" {
		p.At = time.Now().UTC().Format(time.RFC3339)
	}
	return p, nil
}
