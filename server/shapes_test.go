package main

import "testing"

// An offline tracker's last message is frozen mid-drive: the map must not
// show the unit moving on it (KDW 180N, KDJ 847X, KDU 566F, 10 Nov).
func TestOfflineUnitReadsStopped(t *testing.T) {
	frozen := &PPosition{Latitude: -3.61296, Longitude: 38.84362, Speed: 46, Engine: "on",
		MotionStatus: "offline", LastUpdate: "2026-11-09T12:53:33Z"}
	v := PVehicle{VehicleID: 223, Registration: "KDW180N", Position: frozen}

	row := snapshotRow(v)
	if row["speedKmh"] != 0.0 || row["engineOn"] != false || row["connectionOnline"] != false {
		t.Fatalf("snapshot: speed %v engine %v online %v, want 0 false false", row["speedKmh"], row["engineOn"], row["connectionOnline"])
	}
	if row["lat"] != -3.61296 || row["capturedAt"] != "2026-11-09T12:53:33Z" {
		t.Fatalf("snapshot lost the last position: %v %v", row["lat"], row["capturedAt"])
	}
	frame := positionFrame(v)
	if frame["speedKmh"] != 0.0 || frame["engineOn"] != false {
		t.Fatalf("live frame: speed %v engine %v, want 0 false", frame["speedKmh"], frame["engineOn"])
	}

	// A reporting unit keeps its speed and ignition.
	v.Position = &PPosition{Speed: 46, Engine: "on", MotionStatus: "moving"}
	if row := snapshotRow(v); row["speedKmh"] != 46.0 || row["engineOn"] != true {
		t.Fatalf("online unit: speed %v engine %v, want 46 true", row["speedKmh"], row["engineOn"])
	}
}
