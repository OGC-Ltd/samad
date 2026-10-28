package main

// The integration loop from the partner guide, section 6: positions and the
// events feed every 30 s, the vehicle list and geofences once a day.

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

type Poller struct {
	cfg    Config
	client *PartnerClient
	store  *Store
	hub    *Hub
}

func (p *Poller) Run(ctx context.Context) {
	p.reference(ctx)
	p.positions(ctx)
	// The live tally (Store.tally) starts from this first read; the history
	// before it is filled in alongside the polling.
	go p.backfill(ctx, time.Now(), backfillDays)
	p.events(ctx)
	p.store.Save()

	pos := time.NewTicker(p.cfg.PositionsEvery)
	evt := time.NewTicker(p.cfg.EventsEvery)
	ref := time.NewTicker(24 * time.Hour)
	defer pos.Stop()
	defer evt.Stop()
	defer ref.Stop()
	for {
		select {
		case <-ctx.Done():
			p.store.Save()
			return
		case <-pos.C:
			p.positions(ctx)
		case <-evt.C:
			p.events(ctx)
		case <-ref.C:
			p.reference(ctx)
			p.store.Prune(time.Now())
		}
		p.store.Save()
	}
}

func (p *Poller) reference(ctx context.Context) {
	list, err := p.client.Vehicles(ctx)
	obs.job("vehicles", err)
	if err != nil {
		log.Printf("poll vehicles: %v", err)
	} else {
		p.store.SetVehicles(list)
	}
	fences, err := p.client.Geofences(ctx)
	obs.job("geofences", err)
	if err != nil {
		log.Printf("poll geofences: %v", err)
	} else {
		p.store.SetGeofences(fences)
	}
}

func (p *Poller) positions(ctx context.Context) {
	list, err := p.client.Positions(ctx)
	obs.job("positions", err)
	if err != nil {
		log.Printf("poll positions: %v", err)
		return
	}
	for _, v := range p.store.ApplyPositions(list) {
		p.publish("position", positionFrame(v))
	}
}

// events drains the feed from the stored cursor. On the very first run there
// is no cursor, so it starts seven days back, the furthest the partner allows.
func (p *Poller) events(ctx context.Context) {
	cursor := p.store.Cursor()
	since := time.Now().Add(-7*24*time.Hour + time.Minute)
	for i := 0; i < 50; i++ {
		page, err := p.client.Events(ctx, cursor, since)
		if err != nil {
			log.Printf("poll events: %v", err)
			return
		}
		for _, e := range p.store.AddEvents(page.Events, page.NextCursor) {
			p.publish("feed", feedItem(e))
		}
		if page.NextCursor != "" {
			cursor = page.NextCursor
		}
		if !page.HasMore {
			return
		}
	}
}

// How many fleet days back the drivers' distance and trips are filled from
// position history when the server first starts.
const backfillDays = 7

// backfill reads each vehicle's position history for the fleet days not yet
// tallied, up to `until` (the first live read, so the two never overlap), and
// adds each day's distance and trips. The partner's /trips would give these
// directly, but it is not enabled for this key.
func (p *Poller) backfill(ctx context.Context, until time.Time, days int) {
	vehicles := p.store.Vehicles()
	for back := days - 1; back >= 0; back-- {
		start := fleetMidnight(until, back)
		day := fleetDay(start)
		if p.store.IsBackfilled(day) {
			continue
		}
		end := start.Add(24 * time.Hour)
		if end.After(until) {
			end = until
		}
		for i, v := range vehicles {
			hist, err := p.client.History(ctx, v.VehicleID, start, end)
			if err != nil {
				log.Printf("backfill %s %s: %v", day, v.Registration, err)
				return // tried again on the next start
			}
			km, trips := tallyHistory(hist)
			driver := ""
			if v.Driver != nil {
				driver = v.Driver.Name
			}
			p.store.AddDay(day, v.VehicleID, driver, km, trips, i == len(vehicles)-1)
		}
		p.store.Save()
		log.Printf("backfill %s: %d vehicles", day, len(vehicles))
	}
}

// tallyHistory is Store.tally over a list of fixes: distance between
// consecutive fixes (jumps over 150 km/h dropped) and ignition-on starts.
func tallyHistory(hist []PHistoryPoint) (km float64, trips int) {
	var prev *PHistoryPoint
	var prevAt time.Time
	for i := range hist {
		h := &hist[i]
		at := parseTime(h.Timestamp)
		if at.IsZero() {
			continue
		}
		if prev == nil {
			if h.Ignition {
				trips++ // the day opened with the engine running
			}
		} else if at.After(prevAt) {
			d := haversineKm(prev.Latitude, prev.Longitude, h.Latitude, h.Longitude)
			if d/at.Sub(prevAt).Hours() <= 150 {
				km += d
			}
			if h.Ignition && !prev.Ignition {
				trips++
			}
		}
		prev, prevAt = h, at
	}
	return km, trips
}

func (p *Poller) publish(event string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	p.hub.Publish(Frame{Event: event, Data: b})
}
