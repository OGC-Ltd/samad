package main

// Filling a tracker's silences from its position history (operator,
// 2026-11-23: "the alerts for units driving more than 4 h and a half seem
// not to be working").
//
// The live feed only ever shows a tracker's latest reading. In a dead zone
// the tracker keeps recording a point every 30 s and uploads them when its
// signal returns, but the live feed shows its last reading until then, so
// hoursFix saw a silence. A silence is read as a parked tracker: driving
// stops counting after hoursGapCap, and a silence of 30 min or more ends the
// 4.5 h stretch as if it were the break. Trucks driving through dead zones
// therefore never reached 4.5 h, and their day's driving and working hours
// came out hours short (vehicle 406 on 19 Nov 2026: 13 h 33 min driven by
// the history, 7 h 53 min counted).
//
// So when a live reading comes after a silence longer than hoursGapCap, the
// vehicle's history from its last counted reading is read and its points
// replayed through hoursFix, in time order, as if they had been read live. A
// real stop in the silence is still a stop; a truck that kept driving is
// counted driving. A silence the history has nothing for (a parked tracker
// that sends nothing) is treated as before.
//
// The reading is done by one background worker, one silence at a time, so
// the live map never waits on it (operator, 2026-11-23: nothing may hold the
// map up). While a vehicle's silence is being filled its live readings still
// move the map; only their count waits (Store.hoursFilling), because a
// reading counted first would make the older history points too old to
// count. The history read covers up to the moment it is made, so the live
// readings that waited are in it. A failed read lets the vehicle go on as
// before: the silence stays a silence.

import (
	"context"
	"log"
	"sort"
	"time"
)

// hoursFillMax: a longer silence is not filled (a truck parked for days).
const hoursFillMax = 36 * time.Hour

// hoursFillQueue: silences waiting to be read. A full queue drops the new
// one (it is left as before), so a burst never blocks the poll.
const hoursFillQueue = 64

// hoursGap is a silence to fill: from the last reading counted, to the live
// reading that ended it.
type hoursGap struct {
	VehicleID int
	From, To  time.Time
}

// HoursGaps are the vehicles in list whose reading comes after a silence
// longer than hoursGapCap (and not longer than hoursFillMax), not already
// being filled.
func (s *Store) HoursGaps(list []PVehicle) []hoursGap {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.p.Hours == nil {
		return nil
	}
	var out []hoursGap
	for _, v := range list {
		if v.Position == nil || s.hoursFilling[v.VehicleID] {
			continue
		}
		at, err := time.Parse(time.RFC3339, v.Position.LastUpdate)
		if err != nil {
			continue
		}
		st := s.p.Hours.Vehicles[v.VehicleID]
		if st == nil {
			continue
		}
		if gap := at.Sub(st.LastAt); gap > hoursGapCap && gap <= hoursFillMax {
			out = append(out, hoursGap{VehicleID: v.VehicleID, From: st.LastAt, To: at})
		}
	}
	return out
}

// HoldHours marks a vehicle as being filled: its live readings are not
// counted until FinishHours.
func (s *Store) HoldHours(id int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hoursFilling == nil {
		s.hoursFilling = map[int]bool{}
	}
	s.hoursFilling[id] = true
}

// FinishHours ends a fill: the history points (none when the read failed)
// are counted in time order, then the vehicle's latest live reading, and
// its readings count again. It returns how many history points counted.
func (s *Store) FinishHours(id int, pts []PHistoryPoint) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.hoursFilling, id)
	v, ok := s.vehicles[id]
	if !ok || v.Position == nil {
		return 0
	}
	n := s.replayHours(v, pts)
	if at, err := time.Parse(time.RFC3339, v.Position.LastUpdate); err == nil {
		s.hoursNew = append(s.hoursNew, s.hoursFix(v, at)...)
	}
	return n
}

// replayHours counts history points through the hours rules as if read
// live; points not after the last counted reading are skipped by hoursFix.
// Breaches they bring keep their own times and go to the bell with the rest
// (TakeHours). Called with s.mu held.
func (s *Store) replayHours(v PVehicle, pts []PHistoryPoint) int {
	type point struct {
		at time.Time
		p  PHistoryPoint
	}
	list := make([]point, 0, len(pts))
	for _, p := range pts {
		if at, err := time.Parse(time.RFC3339, p.Timestamp); err == nil {
			list = append(list, point{at, p})
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].at.Before(list[j].at) })
	n := 0
	for _, x := range list {
		pos := *v.Position
		pos.Latitude, pos.Longitude, pos.Speed, pos.Course = x.p.Latitude, x.p.Longitude, x.p.Speed, x.p.Course
		pos.Engine, pos.MotionStatus = "off", "stopped"
		if x.p.Ignition {
			pos.Engine = "on"
		}
		if x.p.Speed >= 1 {
			pos.MotionStatus = "moving"
		}
		pos.LastUpdate = x.at.UTC().Format(time.RFC3339)
		w := v
		w.Position = &pos
		before := s.hoursLastAt(v.VehicleID)
		s.hoursNew = append(s.hoursNew, s.hoursFix(w, x.at)...)
		if s.hoursLastAt(v.VehicleID).After(before) {
			n++
		}
	}
	return n
}

// hoursLastAt is the vehicle's last counted reading. Called with s.mu held.
func (s *Store) hoursLastAt(id int) time.Time {
	if s.p.Hours == nil || s.p.Hours.Vehicles[id] == nil {
		return time.Time{}
	}
	return s.p.Hours.Vehicles[id].LastAt
}

// queueHourFills hands the silences in list to the worker, before the live
// readings are applied (so they are held, not counted). Without a worker
// (fills nil) nothing is filled, as before.
func (p *Poller) queueHourFills(list []PVehicle) {
	if p.fills == nil {
		return
	}
	for _, g := range p.store.HoursGaps(list) {
		p.store.HoldHours(g.VehicleID)
		select {
		case p.fills <- g:
		default: // the queue is full: leave this silence as before
			p.store.FinishHours(g.VehicleID, nil)
			log.Printf("hours: fill queue full, vehicle %d's silence left unfilled", g.VehicleID)
		}
	}
}

// fillHours is the worker: one silence at a time, read from the last
// counted reading to now.
func (p *Poller) fillHours(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case g := <-p.fills:
			c, cancel := context.WithTimeout(ctx, time.Minute)
			pts, err := p.client.History(c, g.VehicleID, g.From, time.Now())
			cancel()
			obs.job("hours_fill", err)
			if err != nil {
				log.Printf("hours: history for vehicle %d's %s silence: %v (left unfilled)", g.VehicleID, g.To.Sub(g.From).Round(time.Second), err)
				pts = nil
			}
			if n := p.store.FinishHours(g.VehicleID, pts); n > 0 {
				log.Printf("hours: filled vehicle %d's %s silence with %d points", g.VehicleID, g.To.Sub(g.From).Round(time.Second), n)
			}
		}
	}
}
