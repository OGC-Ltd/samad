package main

// Observability: what this server is doing and what it costs.
//
// One in-memory recorder, `obs`, fed from three places:
//   - every request, through the router middleware (by route TEMPLATE, never
//     the raw path, so a vehicle id cannot mint a new series);
//   - every call out to the Partner API, Google and OpenAI, through a
//     RoundTripper on their clients;
//   - a sampler every 10 s: the Go runtime, this process, its container and
//     the host (resources_linux.go; elsewhere those read as unknown).
//
// It has one reader: GET /metrics in the Prometheus text format (system.go).
// Nothing is kept here but running totals; history, rates, percentiles and
// alerts are Prometheus' and Grafana's (deploy/observability), outside Samad.

import (
	"net/http"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Latency bucket bounds in seconds, Prometheus' defaults: wide enough for a
// cached snapshot (ms) and a Google route matrix (s) in one scale.
var latencyBounds = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// How often the resources are read.
const sampleEvery = 15 * time.Second

type histogram struct {
	Counts []uint64 // len(latencyBounds)+1, the last is +Inf
	Sum    float64
	N      uint64
}

func newHistogram() histogram { return histogram{Counts: make([]uint64, len(latencyBounds)+1)} }

func (h *histogram) observe(sec float64) {
	i := sort.SearchFloat64s(latencyBounds, sec)
	h.Counts[i]++
	h.Sum += sec
	h.N++
}

type routeKey struct{ Method, Route string }

type routeStats struct {
	Class   [6]uint64 // by status class: [2] 2xx … [5] 5xx
	Bytes   uint64
	Latency histogram
	Streams uint64 // event-stream responses: counted, kept out of latency
}

type outStats struct {
	Calls, Failures uint64
	Latency         histogram
	LastOK, LastErr time.Time
	LastError       string
}

type jobState struct {
	LastOK, LastErr time.Time
	LastError       string
}

type observer struct {
	mu       sync.Mutex
	started  time.Time
	inFlight int64
	routes   map[routeKey]*routeStats
	out      map[string]*outStats
	jobs     map[string]*jobState
	last     *resourceSample
	streams  func() int // live-stream subscribers, set by the server
}

var obs = newObserver()

func newObserver() *observer {
	return &observer{
		started: time.Now(),
		routes:  map[routeKey]*routeStats{},
		out:     map[string]*outStats{},
		jobs:    map[string]*jobState{},
	}
}

func (o *observer) begin() {
	o.mu.Lock()
	o.inFlight++
	o.mu.Unlock()
}

// done records one finished request.
func (o *observer) done(method, route string, status int, bytes uint64, took time.Duration, stream bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.inFlight--
	k := routeKey{method, route}
	rs := o.routes[k]
	if rs == nil {
		rs = &routeStats{Latency: newHistogram()}
		o.routes[k] = rs
	}
	if c := status / 100; c >= 1 && c <= 5 {
		rs.Class[c]++
	}
	rs.Bytes += bytes
	if stream {
		// A live stream is open for as long as the tab is: its "latency" is a
		// session length, and averaging it in would bury every real request.
		rs.Streams++
		return
	}
	rs.Latency.observe(took.Seconds())
}

// outbound records one call to an outside service.
func (o *observer) outbound(service string, took time.Duration, err error, status int) {
	now := time.Now()
	o.mu.Lock()
	defer o.mu.Unlock()
	st := o.out[service]
	if st == nil {
		st = &outStats{Latency: newHistogram()}
		o.out[service] = st
	}
	st.Calls++
	st.Latency.observe(took.Seconds())
	switch {
	case err != nil:
		st.Failures++
		st.LastErr, st.LastError = now, trimError(err.Error())
	case status >= 500 || status == http.StatusTooManyRequests:
		st.Failures++
		st.LastErr, st.LastError = now, "HTTP "+http.StatusText(status)
	default:
		st.LastOK = now
	}
}

// job records the outcome of a background step (the partner polls).
func (o *observer) job(name string, err error) {
	now := time.Now()
	o.mu.Lock()
	defer o.mu.Unlock()
	j := o.jobs[name]
	if j == nil {
		j = &jobState{}
		o.jobs[name] = j
	}
	if err != nil {
		j.LastErr, j.LastError = now, trimError(err.Error())
	} else {
		j.LastOK = now
	}
}

func trimError(s string) string {
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}

// sample takes one resource reading.
func (o *observer) sample(dataDir string) {
	r := readResources(dataDir)
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	r.Goroutines = runtime.NumGoroutine()
	r.HeapBytes = ms.HeapAlloc
	r.GoSysBytes = ms.Sys
	r.GCCycles = ms.NumGC
	r.GCPauseMs = float64(ms.PauseNs[(ms.NumGC+255)%256]) / 1e6
	now := time.Now()

	o.mu.Lock()
	defer o.mu.Unlock()
	var prev cpuReading
	if o.last != nil {
		prev = o.last.cpu
	}
	r.cpu.At = now
	r.cpuPercents(prev, now)
	o.last = &r
}

// runSampler samples every sampleEvery until done closes.
func (o *observer) runSampler(done <-chan struct{}, dataDir string) {
	o.sample(dataDir)
	t := time.NewTicker(sampleEvery)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			o.sample(dataDir)
		}
	}
}

// ── The request middleware ─────────────────────────────────────────────────

type obsWriter struct {
	http.ResponseWriter
	status int
	bytes  uint64
}

func (w *obsWriter) WriteHeader(s int) { w.status = s; w.ResponseWriter.WriteHeader(s) }
func (w *obsWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.bytes += uint64(n) //nolint:gosec // G115: n is never negative
	return n, err
}

// Flush keeps the live stream working through the wrapper.
func (w *obsWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the real writer.
func (w *obsWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// routeLabel is the matched route's template ("/api/v1/organisations/{org}/
// vehicles/{vehicleId}/track"), "static" for the built app, "unmatched" for
// anything else: a bounded set, whatever paths scanners try.
func routeLabel(r *http.Request) string {
	if t := matchedTemplate(r); t != "" && t != "/" {
		return t
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/metrics" {
		return "static"
	}
	return "unmatched"
}

// ── Outbound calls ─────────────────────────────────────────────────────────

// countedTransport records each call a client makes under one service name.
type countedTransport struct {
	service string
	base    http.RoundTripper
}

func (t countedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	res, err := t.base.RoundTrip(req)
	status := 0
	if res != nil {
		status = res.StatusCode
	}
	obs.outbound(t.service, time.Since(start), err, status)
	return res, err
}

// instrument wraps a client's transport: counted here, and traced when
// tracing is on (tracing.go).
func instrument(c *http.Client, service string) *http.Client {
	base := c.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	c.Transport = traced(countedTransport{service: service, base: base}, service)
	return c
}
