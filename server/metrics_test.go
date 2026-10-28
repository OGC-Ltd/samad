package main

import (
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Each observation lands in the first bucket whose bound holds it; anything
// past the top bound is counted only in +Inf.
func TestHistogramBuckets(t *testing.T) {
	h := newHistogram()
	h.observe(0.003)
	h.observe(0.005) // on a bound: that bucket (le is "less or equal")
	h.observe(0.7)
	h.observe(60)
	if h.Counts[0] != 2 || h.Counts[7] != 1 || h.Counts[len(latencyBounds)] != 1 || h.N != 4 {
		t.Fatalf("%+v", h.Counts)
	}
	if math.Abs(h.Sum-60.708) > 1e-9 {
		t.Fatalf("sum %v", h.Sum)
	}
}

// /metrics is a 404 until a token is configured, and then only to its holder;
// requests are labelled by route template, never by the raw path.
func TestPrometheusEndpoint(t *testing.T) {
	t.Setenv("METRICS_TOKEN", "scrape-me")
	h := newHarness(t)
	tok, _ := h.login()
	h.do("GET", "/api/v1/organisations/samad/vehicles/7/camera", tok, nil)

	if rec := h.do("GET", "/metrics", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := h.do("GET", "/metrics", "wrong", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	rec := h.do("GET", "/metrics", "scrape-me", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("with token: %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`samad_http_requests_total{method="POST",route="/api/v1/auth/login",code="2xx"}`,
		`route="/api/v1/organisations/{org}/vehicles/{vehicleId}/camera"`,
		`samad_http_request_duration_seconds_bucket{method="POST",route="/api/v1/auth/login",le="+Inf"}`,
		"samad_data_dir_writable 1",
		`samad_outbound_configured{service="openai"} 0`,
		"go_goroutines",
		`samad_build_info{version=`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %s", want)
		}
	}
	if strings.Contains(body, "/vehicles/7/") {
		t.Error("a raw path leaked into a label")
	}

	t.Setenv("METRICS_TOKEN", "")
	if rec := newHarness(t).do("GET", "/metrics", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unset token: %d", rec.Code)
	}
}

// A live stream counts as a request but stays out of the latency histogram.
func TestStreamsStayOutOfLatency(t *testing.T) {
	o := newObserver()
	o.begin()
	o.done("GET", "/live", 200, 10, 30*time.Minute, true)
	o.begin()
	o.done("GET", "/x", 503, 5, 20*time.Millisecond, false)
	live, x := o.routes[routeKey{"GET", "/live"}], o.routes[routeKey{"GET", "/x"}]
	if live.Class[2] != 1 || live.Streams != 1 || live.Latency.N != 0 {
		t.Fatalf("stream: %+v", live)
	}
	if x.Class[5] != 1 || x.Latency.N != 1 || o.inFlight != 0 {
		t.Fatalf("request: %+v, in flight %d", x, o.inFlight)
	}
}

// Outside calls are counted per service: transport errors and 5xx/429 fail.
func TestOutboundCounting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/busy" {
			w.WriteHeader(http.StatusTooManyRequests)
		}
	}))
	t.Cleanup(srv.Close)
	c := instrument(&http.Client{Timeout: time.Second}, "test-svc")
	for _, p := range []string{"/ok", "/busy"} {
		res, err := c.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}
	obs.outbound("test-svc", time.Millisecond, errors.New("dial tcp: refused"), 0)

	obs.mu.Lock()
	st := *obs.out["test-svc"]
	obs.mu.Unlock()
	if st.Calls != 3 || st.Failures != 2 || st.LastOK.IsZero() || !strings.Contains(st.LastError, "refused") {
		t.Fatalf("%+v", st)
	}
}
