package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRoster(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "drivers.json"), `[
		{"truck": "KDN 506L", "trailer": "ZH2969", "driver": "TEST DRIVER", "idNumber": "123", "phone": "0700000000"},
		{"truck": "KXX000X", "trailer": "", "driver": "NO TRUCK YET", "idNumber": "456", "phone": ""}
	]`)
	s := NewStore(dir)
	s.SetVehicles([]PVehicle{
		{VehicleID: 1, Registration: "KDN506L", Type: "car", Make: "SAME", Model: "Tractor", Driver: &PPerson{ID: 9, Name: "PARTNER NAME"}},
		{VehicleID: 2, Registration: "KAA111A", Type: "car", Make: "Toyota"},
	})
	v, _ := s.Vehicle(1)
	row := snapshotRow(v)
	if row["driver"] != "TEST DRIVER" || row["vehicleType"] != "TRUCK" || row["name"] != "KDN506L · ZH2969" {
		t.Fatalf("roster truck %v", row)
	}
	// A position read keeps the roster on.
	s.ApplyPositions([]PVehicle{{VehicleID: 1, Registration: "KDN506L", Type: "car", Position: &PPosition{Latitude: -1}}})
	if v, _ := s.Vehicle(1); driverName(v) != "TEST DRIVER" || vehicleType(v) != "TRUCK" {
		t.Fatalf("after positions %+v", v)
	}
	// Off the roster: the partner's own.
	if v, _ := s.Vehicle(2); vehicleType(v) != "CAR" {
		t.Fatalf("off-roster type %q", vehicleType(v))
	}
	if m := s.RosterMissing(); len(m) != 1 || m[0].Driver != "NO TRUCK YET" {
		t.Fatalf("missing %v", m)
	}
}

func TestRosterAbsent(t *testing.T) {
	dir := t.TempDir()
	if r := loadRoster(dir); len(r) != 0 {
		t.Fatal(r)
	}
	mustWrite(t, filepath.Join(dir, "drivers.json"), "not json")
	if r := loadRoster(dir); len(r) != 0 {
		t.Fatal(r)
	}
	_ = os.Remove(filepath.Join(dir, "drivers.json"))
}
