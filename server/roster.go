package main

// The truck roster: Samad's own record of which driver drives which truck,
// with the trailer it pulls. The partner's driver assignments are patchy, so
// for a truck on the roster the roster wins.
//
// It is read from DATA_DIR/drivers.json, never from git: it holds national ID
// and phone numbers. On the box that is the samad-data volume:
//
//	[{"truck": "KDN506L", "trailer": "ZH2969", "driver": "MOSES WANYONYI",
//	  "idNumber": "…", "phone": "07…"}, …]
//
// Edit the file and restart the app to change it.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

type rosterEntry struct {
	Truck    string `json:"truck"`
	Trailer  string `json:"trailer"`
	Driver   string `json:"driver"`
	IDNumber string `json:"idNumber"`
	Phone    string `json:"phone"`
}

// plateKey compares plates without spaces, dashes or case: "KDN 506L" is "KDN506L".
func plateKey(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToUpper(r)
		}
		return -1
	}, s)
}

func loadRoster(dir string) map[string]rosterEntry {
	out := map[string]rosterEntry{}
	b, err := os.ReadFile(filepath.Join(dir, "drivers.json")) //nolint:gosec // G304: DATA_DIR from config and a fixed name
	if errors.Is(err, fs.ErrNotExist) {
		return out
	}
	var list []rosterEntry
	if err == nil {
		err = json.Unmarshal(b, &list)
	}
	if err != nil {
		log.Printf("roster: drivers.json unreadable, ignored: %v", err)
		return out
	}
	for _, e := range list {
		if k := plateKey(e.Truck); k != "" && strings.TrimSpace(e.Driver) != "" {
			out[k] = e
		}
	}
	log.Printf("roster: %d trucks with their drivers", len(out))
	return out
}

// dress puts the roster on a partner vehicle: its driver, and TRUCK as its
// type, named by plate and trailer so the dashboard files it under Trucks
// whatever make the partner reports.
func dress(v PVehicle, roster map[string]rosterEntry) PVehicle {
	e, ok := roster[plateKey(v.Registration)]
	if !ok {
		return v
	}
	id, _ := strconv.Atoi(e.IDNumber)
	v.Driver = &PPerson{ID: id, Name: e.Driver}
	v.Type = "TRUCK"
	v.Trailer = e.Trailer
	return v
}

// rosterFor finds a vehicle's roster entry, for the driver details the
// partner does not have.
func (s *Store) rosterFor(registration string) (rosterEntry, bool) {
	e, ok := s.roster[plateKey(registration)]
	return e, ok
}

// RosterMissing lists roster trucks the partner does not report.
func (s *Store) RosterMissing() []rosterEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[string]bool{}
	for _, v := range s.vehicles {
		seen[plateKey(v.Registration)] = true
	}
	var out []rosterEntry
	for k, e := range s.roster {
		if !seen[k] {
			out = append(out, e)
		}
	}
	return out
}
