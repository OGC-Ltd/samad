package main

import (
	"runtime"
	"time"
)

// One reading of what the server is using. Pointers are "unknown": off Linux
// (a developer's laptop) the process, container and host figures are not
// read, and the page says so rather than showing zeros.
type resourceSample struct {
	At time.Time `json:"at"`

	// This process.
	CPUPct   *float64 `json:"cpuPct"`   // share of the CPUs it may use (its quota, else all)
	RSSBytes *uint64  `json:"rssBytes"` // resident memory

	// Its container (cgroup v2), the limit docker-compose sets (mem_limit).
	MemBytes      *uint64 `json:"memBytes"`
	MemLimitBytes *uint64 `json:"memLimitBytes"`

	// The machine.
	HostCPUPct     *float64 `json:"hostCpuPct"`
	HostMemTotal   *uint64  `json:"hostMemTotal"`
	HostMemAvail   *uint64  `json:"hostMemAvail"`
	Load1          *float64 `json:"load1"`
	DiskFreeBytes  *uint64  `json:"diskFreeBytes"` // the volume DATA_DIR is on
	DiskTotalBytes *uint64  `json:"diskTotalBytes"`

	// The Go runtime: always known.
	Goroutines int     `json:"goroutines"`
	HeapBytes  uint64  `json:"heapBytes"`
	GoSysBytes uint64  `json:"goSysBytes"`
	GCCycles   uint32  `json:"gcCycles"`
	GCPauseMs  float64 `json:"gcPauseMs"`
	CPUs       float64 `json:"cpus"`

	cpu cpuReading
}

// Cumulative counters, turned into percentages between two readings.
type cpuReading struct {
	At         time.Time
	ProcSec    float64 // CPU seconds this process has used
	HostBusy   uint64  // /proc/stat jiffies
	HostTotal  uint64
	ok, hostOK bool
}

func (r *resourceSample) cpuPercents(prev cpuReading, now time.Time) {
	r.At = now
	if r.CPUs <= 0 {
		r.CPUs = float64(runtime.NumCPU())
	}
	if prev.At.IsZero() {
		return
	}
	if r.cpu.ok && prev.ok {
		if el := now.Sub(prev.At).Seconds(); el > 0 {
			v := clampPct((r.cpu.ProcSec - prev.ProcSec) / el / r.CPUs * 100)
			r.CPUPct = &v
		}
	}
	if r.cpu.hostOK && prev.hostOK && r.cpu.HostTotal > prev.HostTotal {
		v := clampPct(float64(r.cpu.HostBusy-prev.HostBusy) / float64(r.cpu.HostTotal-prev.HostTotal) * 100)
		r.HostCPUPct = &v
	}
}

func clampPct(v float64) float64 {
	switch {
	case v < 0:
		return 0
	case v > 100:
		return 100
	}
	return float64(int(v*10+0.5)) / 10
}
