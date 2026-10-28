//go:build linux

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// /proc reports process CPU in USER_HZ ticks, which is 100 on every Linux the
// kernel ships for userspace.
const userHZ = 100

// readResources reads /proc and the container's cgroup. Inside docker,
// /proc/stat, /proc/meminfo and /proc/loadavg describe the host machine,
// which is what the page labels them as.
func readResources(dataDir string) resourceSample {
	var r resourceSample

	if f := fieldsOf("/proc/self/stat"); len(f) > 15 {
		// The command name (field 2) may hold spaces; count from its ")".
		if i := strings.LastIndexByte(strings.Join(f, " "), ')'); i > 0 {
			rest := strings.Fields(strings.Join(f, " ")[i+1:])
			if len(rest) > 12 {
				ut, e1 := strconv.ParseFloat(rest[11], 64)
				st, e2 := strconv.ParseFloat(rest[12], 64)
				if e1 == nil && e2 == nil {
					r.cpu.ProcSec, r.cpu.ok = (ut+st)/userHZ, true
				}
			}
		}
	}
	if kb, ok := keyedKB("/proc/self/status", "VmRSS:"); ok {
		r.RSSBytes = &kb
	}

	if v, ok := cgroupBytes("memory.current"); ok {
		r.MemBytes = &v
	}
	if v, ok := cgroupBytes("memory.max"); ok {
		r.MemLimitBytes = &v
	}
	if f := fieldsOf("/sys/fs/cgroup/cpu.max"); len(f) == 2 && f[0] != "max" {
		q, e1 := strconv.ParseFloat(f[0], 64)
		p, e2 := strconv.ParseFloat(f[1], 64)
		if e1 == nil && e2 == nil && p > 0 {
			r.CPUs = q / p
		}
	}

	if b, err := os.ReadFile("/proc/stat"); err == nil {
		line, _, _ := strings.Cut(string(b), "\n")
		if f := strings.Fields(line); len(f) > 5 && f[0] == "cpu" {
			var total, idle uint64
			for i, s := range f[1:] {
				n, _ := strconv.ParseUint(s, 10, 64)
				total += n
				if i == 3 || i == 4 { // idle, iowait
					idle += n
				}
			}
			r.cpu.HostBusy, r.cpu.HostTotal, r.cpu.hostOK = total-idle, total, true
		}
	}
	if kb, ok := keyedKB("/proc/meminfo", "MemTotal:"); ok {
		r.HostMemTotal = &kb
	}
	if kb, ok := keyedKB("/proc/meminfo", "MemAvailable:"); ok {
		r.HostMemAvail = &kb
	}
	if f := fieldsOf("/proc/loadavg"); len(f) > 0 {
		if v, err := strconv.ParseFloat(f[0], 64); err == nil {
			r.Load1 = &v
		}
	}

	var fs syscall.Statfs_t
	if err := syscall.Statfs(dataDir, &fs); err == nil {
		bs := uint64(fs.Bsize) //nolint:gosec // G115: block size is positive
		free, total := fs.Bavail*bs, fs.Blocks*bs
		r.DiskFreeBytes, r.DiskTotalBytes = &free, &total
	}
	return r
}

func fieldsOf(path string) []string {
	b, err := os.ReadFile(path) //nolint:gosec // G304: fixed /proc and /sys paths
	if err != nil {
		return nil
	}
	return strings.Fields(string(b))
}

// keyedKB reads a "Key:   1234 kB" line, in bytes.
func keyedKB(path, key string) (uint64, bool) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: fixed /proc paths
	if err != nil {
		return 0, false
	}
	for line := range strings.SplitSeq(string(b), "\n") {
		if rest, ok := strings.CutPrefix(line, key); ok {
			if f := strings.Fields(rest); len(f) > 0 {
				if n, err := strconv.ParseUint(f[0], 10, 64); err == nil {
					return n * 1024, true
				}
			}
		}
	}
	return 0, false
}

// cgroupBytes reads one cgroup v2 memory file; "max" (no limit) is unknown.
func cgroupBytes(name string) (uint64, bool) {
	f := fieldsOf("/sys/fs/cgroup/" + name)
	if len(f) != 1 || f[0] == "max" {
		return 0, false
	}
	n, err := strconv.ParseUint(f[0], 10, 64)
	return n, err == nil
}
