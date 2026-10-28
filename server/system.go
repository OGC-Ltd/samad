package main

// GET /metrics: the recorder (metrics.go) in the Prometheus text format, for
// the observability stack beside Samad (deploy/observability). Rates,
// percentiles, history and the system checks are PromQL there, not code here.

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ── Prometheus ──────────────────────────────────────────────────────────────

// prometheus serves /metrics, to a scraper holding METRICS_TOKEN. With no
// token configured it is not served at all: behind Traefik every request
// arrives from a private address, so "only from inside" is not a test this
// server can make.
func prometheus(s *Server, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.NotFound(w, r)
			return
		}
		// A scrape before the sampler's first tick takes the reading itself.
		obs.mu.Lock()
		empty := obs.last == nil
		obs.mu.Unlock()
		if empty && s != nil {
			obs.sample(s.cfg.DataDir)
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(obs.prometheusText(s)))
	}
}

func (o *observer) prometheusText(s *Server) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	var b strings.Builder
	help := func(name, typ, text string) { fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", name, text, name, typ) }
	hist := func(name, labels string, h histogram) {
		var cum uint64
		for i, bound := range latencyBounds {
			cum += h.Counts[i]
			fmt.Fprintf(&b, "%s_bucket{%sle=\"%g\"} %d\n", name, labels, bound, cum)
		}
		fmt.Fprintf(&b, "%s_bucket{%sle=\"+Inf\"} %d\n", name, labels, h.N)
		fmt.Fprintf(&b, "%s_sum{%s} %g\n%s_count{%s} %d\n", name, strings.TrimSuffix(labels, ","), h.Sum,
			name, strings.TrimSuffix(labels, ","), h.N)
	}

	help("samad_build_info", "gauge", "The running release.")
	fmt.Fprintf(&b, "samad_build_info{version=%q} 1\n", version)
	help("samad_uptime_seconds", "gauge", "Seconds since the server started.")
	fmt.Fprintf(&b, "samad_uptime_seconds %d\n", int64(time.Since(o.started).Seconds()))

	keys := make([]routeKey, 0, len(o.routes))
	for k := range o.routes {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Route+keys[i].Method < keys[j].Route+keys[j].Method })

	help("samad_http_requests_total", "counter", "Requests served, by route template and status class.")
	for _, k := range keys {
		for c := 1; c <= 5; c++ {
			if n := o.routes[k].Class[c]; n > 0 {
				fmt.Fprintf(&b, "samad_http_requests_total{method=%q,route=%q,code=\"%dxx\"} %d\n", k.Method, k.Route, c, n)
			}
		}
	}
	help("samad_http_request_duration_seconds", "histogram", "Time to answer, live streams excluded.")
	for _, k := range keys {
		hist("samad_http_request_duration_seconds", fmt.Sprintf("method=%q,route=%q,", k.Method, k.Route), o.routes[k].Latency)
	}
	help("samad_http_response_bytes_total", "counter", "Response body bytes written.")
	for _, k := range keys {
		fmt.Fprintf(&b, "samad_http_response_bytes_total{method=%q,route=%q} %d\n", k.Method, k.Route, o.routes[k].Bytes)
	}
	help("samad_http_in_flight_requests", "gauge", "Requests being answered now, live streams included.")
	fmt.Fprintf(&b, "samad_http_in_flight_requests %d\n", o.inFlight)
	if o.streams != nil {
		help("samad_live_streams", "gauge", "Open live-map streams.")
		fmt.Fprintf(&b, "samad_live_streams %d\n", o.streams())
	}

	names := make([]string, 0, len(o.out))
	for n := range o.out {
		names = append(names, n)
	}
	sort.Strings(names)
	help("samad_outbound_requests_total", "counter", "Calls to outside services, by outcome.")
	for _, n := range names {
		st := o.out[n]
		fmt.Fprintf(&b, "samad_outbound_requests_total{service=%q,outcome=\"ok\"} %d\n", n, st.Calls-st.Failures)
		fmt.Fprintf(&b, "samad_outbound_requests_total{service=%q,outcome=\"error\"} %d\n", n, st.Failures)
	}
	help("samad_outbound_duration_seconds", "histogram", "Time outside services took to answer.")
	for _, n := range names {
		hist("samad_outbound_duration_seconds", fmt.Sprintf("service=%q,", n), o.out[n].Latency)
	}
	jobs := make([]string, 0, len(o.jobs))
	for n := range o.jobs {
		jobs = append(jobs, n)
	}
	sort.Strings(jobs)
	help("samad_outbound_last_error_timestamp_seconds", "gauge", "When each outside service last failed.")
	for _, n := range names {
		if t := o.out[n].LastErr; !t.IsZero() {
			fmt.Fprintf(&b, "samad_outbound_last_error_timestamp_seconds{service=%q} %d\n", n, t.Unix())
		}
	}
	if s != nil {
		// Configured or not: an unset key is "off", not a failure to alert on.
		help("samad_outbound_configured", "gauge", "1 when the service has an API key.")
		for _, svc := range []struct {
			name string
			on   bool
		}{{"partner", s.cfg.PartnerAPIKey != ""}, {"google", s.routing != nil && s.routing.enabled()}, {"openai", s.ai != nil}} {
			fmt.Fprintf(&b, "samad_outbound_configured{service=%q} %d\n", svc.name, b2i(svc.on))
		}
		help("samad_data_dir_writable", "gauge", "1 when DATA_DIR accepts a write.")
		fmt.Fprintf(&b, "samad_data_dir_writable %d\n", b2i(dataDirWritable(s.cfg.DataDir)))
	}
	help("samad_poll_last_success_timestamp_seconds", "gauge", "When each partner poll last succeeded.")
	for _, n := range jobs {
		if t := o.jobs[n].LastOK; !t.IsZero() {
			fmt.Fprintf(&b, "samad_poll_last_success_timestamp_seconds{poll=%q} %d\n", n, t.Unix())
		}
	}
	help("samad_poll_last_error_timestamp_seconds", "gauge", "When each partner poll last failed.")
	for _, n := range jobs {
		if t := o.jobs[n].LastErr; !t.IsZero() {
			fmt.Fprintf(&b, "samad_poll_last_error_timestamp_seconds{poll=%q} %d\n", n, t.Unix())
		}
	}

	if r := o.last; r != nil {
		gauge := func(name, text string, v float64) {
			help(name, "gauge", text)
			fmt.Fprintf(&b, "%s %g\n", name, v)
		}
		gauge("go_goroutines", "Goroutines.", float64(r.Goroutines))
		gauge("go_memstats_heap_alloc_bytes", "Heap in use.", float64(r.HeapBytes))
		gauge("go_memstats_sys_bytes", "Memory obtained from the OS by the Go runtime.", float64(r.GoSysBytes))
		help("go_gc_cycles_total", "counter", "Completed GC cycles.")
		fmt.Fprintf(&b, "go_gc_cycles_total %d\n", r.GCCycles)
		if r.cpu.ok {
			help("process_cpu_seconds_total", "counter", "CPU time used by this process.")
			fmt.Fprintf(&b, "process_cpu_seconds_total %g\n", r.cpu.ProcSec)
		}
		opt := func(name, text string, v *uint64) {
			if v != nil {
				gauge(name, text, float64(*v))
			}
		}
		opt("process_resident_memory_bytes", "Resident memory.", r.RSSBytes)
		opt("samad_container_memory_bytes", "Container memory in use (cgroup).", r.MemBytes)
		opt("samad_container_memory_limit_bytes", "Container memory limit (cgroup).", r.MemLimitBytes)
		opt("samad_host_memory_total_bytes", "Host memory.", r.HostMemTotal)
		opt("samad_host_memory_available_bytes", "Host memory available.", r.HostMemAvail)
		opt("samad_data_disk_free_bytes", "Free space on the DATA_DIR volume.", r.DiskFreeBytes)
		opt("samad_data_disk_total_bytes", "Size of the DATA_DIR volume.", r.DiskTotalBytes)
		if r.HostCPUPct != nil {
			gauge("samad_host_cpu_percent", "Host CPU busy over the last 10 s.", *r.HostCPUPct)
		}
		if r.CPUPct != nil {
			gauge("samad_process_cpu_percent", "This process's CPU over the last sample, as a share of its CPUs.", *r.CPUPct)
		}
		gauge("samad_process_cpus", "CPUs this process may use (its quota, else the machine's).", r.CPUs)
		if r.Load1 != nil {
			gauge("samad_host_load1", "Host load average, 1 minute.", *r.Load1)
		}
	}
	return b.String()
}

func b2i(v bool) int {
	if v {
		return 1
	}
	return 0
}

// dataDirWritable writes and removes a probe file: the store saves there, and
// a full or read-only volume is otherwise found out at the next save.
func dataDirWritable(dir string) bool {
	probe := filepath.Join(dir, ".write-check")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return false
	}
	_ = os.Remove(probe)
	return true
}
