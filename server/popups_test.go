package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

var popNow = time.Date(2026, 11, 23, 8, 16, 30, 0, time.UTC)

func popEvent(id string, vehicle int, typ string, at time.Time) PEvent {
	speed := 35.0
	src := "device"
	if strings.Contains(typ, "speeding") {
		src = "platform"
	}
	return PEvent{
		EventID: id, Source: src, Type: typ, Severity: "critical", VehicleID: vehicle,
		Registration: fmt.Sprintf("KDT %dD", vehicle), Speed: &speed,
		OccurredAt: at.Format(time.RFC3339), ReceivedAt: at.Format(time.RFC3339),
	}
}

func popNamer(id int) (string, string) {
	if id == 953 {
		return "KDT 953D", "FRED SIMIYU"
	}
	return "", ""
}

func TestPopupFirstAlertShowsThenQuiet(t *testing.T) {
	p := NewPopups()
	// Four Phone Use in the same minute from one truck (the screenshot of 23 Nov).
	var evs []PEvent
	for i := 0; i < 4; i++ {
		evs = append(evs, popEvent(fmt.Sprintf("p%d", i), 953, "phone_use", popNow.Add(-time.Duration(4-i)*time.Second)))
	}
	cards := p.Take(evs, popNow, popNamer)
	if len(cards) != 1 {
		t.Fatalf("want 1 card for a burst, got %d: %+v", len(cards), cards)
	}
	c := cards[0]
	if c.Title != "KDT 953D: Phone Use" || !c.Sound || c.Kind != "alarm" || c.Data.Alarm != "phone_use" {
		t.Fatalf("card = %+v", c)
	}
	if !strings.Contains(c.Body, "FRED SIMIYU") || !strings.Contains(c.Body, "35 km/h") {
		t.Fatalf("body = %q", c.Body)
	}
}

func TestPopupFollowUpAtFive(t *testing.T) {
	p := NewPopups()
	start := popNow.Add(-4 * time.Minute)
	p.Take([]PEvent{popEvent("a1", 953, "phone_use", start)}, start, popNamer)
	var got []Toast
	for i := 2; i <= 7; i++ {
		at := start.Add(time.Duration(i-1) * 40 * time.Second)
		got = append(got, p.Take([]PEvent{popEvent(fmt.Sprintf("a%d", i), 953, "phone_use", at)}, at, popNamer)...)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly one follow-up, got %d: %+v", len(got), got)
	}
	if got[0].Title != "KDT 953D: Phone Use 5 times in 3 min" || got[0].Data.Count != 5 {
		t.Fatalf("follow-up = %+v", got[0])
	}
}

func TestPopupAgainAfterQuietWindow(t *testing.T) {
	p := NewPopups()
	p.Take([]PEvent{popEvent("q1", 953, "phone_use", popNow)}, popNow, popNamer)
	// 29 minutes later: still the same run.
	at := popNow.Add(29 * time.Minute)
	if c := p.Take([]PEvent{popEvent("q2", 953, "phone_use", at)}, at, popNamer); len(c) != 0 {
		t.Fatalf("inside the window: want none, got %+v", c)
	}
	// 30 minutes after the LAST one: a new run, a new card.
	at = at.Add(30 * time.Minute)
	if c := p.Take([]PEvent{popEvent("q3", 953, "phone_use", at)}, at, popNamer); len(c) != 1 {
		t.Fatalf("after the window: want 1, got %+v", c)
	}
}

func TestPopupOtherAlarmOrTruckStillShows(t *testing.T) {
	p := NewPopups()
	cards := p.Take([]PEvent{
		popEvent("o1", 953, "phone_use", popNow),
		popEvent("o2", 953, "no_seatbelt", popNow),
		popEvent("o3", 506, "phone_use", popNow),
	}, popNow, popNamer)
	if len(cards) != 3 {
		t.Fatalf("want 3 cards, got %d: %+v", len(cards), cards)
	}
	for _, c := range cards {
		if c.Data.Alarm == "no_seatbelt" && c.Sound {
			t.Fatal("No Seatbelt must be silent")
		}
		if c.Data.Alarm == "phone_use" && !c.Sound {
			t.Fatal("Phone Use must sound")
		}
	}
	if cards[2].Title != "KDT 506D: Phone Use" {
		t.Fatalf("plate from the event when the namer has none: %q", cards[2].Title)
	}
}

func TestPopupOldAlertsNeverShow(t *testing.T) {
	p := NewPopups()
	old := popNow.Add(-10 * time.Minute)
	// The catch-up after a restart: old alerts start the run but show nothing.
	if c := p.Take([]PEvent{popEvent("c1", 953, "phone_use", old), popEvent("c2", 953, "phone_use", old.Add(time.Second))}, popNow, popNamer); len(c) != 0 {
		t.Fatalf("old alerts popped up: %+v", c)
	}
	// The run's first fresh alert is the card nobody has seen yet.
	if c := p.Take([]PEvent{popEvent("c3", 953, "phone_use", popNow)}, popNow, popNamer); len(c) != 1 || c[0].Title != "KDT 953D: Phone Use" {
		t.Fatalf("first fresh alert of a caught-up run: %+v", c)
	}
}

func TestPopupFloodBecomesSummary(t *testing.T) {
	p := NewPopups()
	var evs []PEvent
	for v := 1; v <= 6; v++ {
		typ := "phone_use"
		if v > 4 {
			typ = "no_seatbelt"
		}
		evs = append(evs, popEvent(fmt.Sprintf("f%d", v), v, typ, popNow))
	}
	cards := p.Take(evs, popNow, popNamer)
	if len(cards) != popupPerMinute+1 {
		t.Fatalf("want %d cards and a summary, got %d: %+v", popupPerMinute, len(cards), cards)
	}
	sum := cards[len(cards)-1]
	if sum.Kind != "alarms" || sum.Title != "3 more alerts" || sum.Body != "Phone Use ×1 · No Seatbelt ×2" || !sum.Sound {
		t.Fatalf("summary = %+v", sum)
	}
	// Same minute, one more truck: straight into a summary.
	more := p.Take([]PEvent{popEvent("f7", 7, "no_seatbelt", popNow.Add(10*time.Second))}, popNow.Add(10*time.Second), popNamer)
	if len(more) != 1 || more[0].Kind != "alarms" || more[0].Title != "1 more alert" || more[0].Sound {
		t.Fatalf("later in the minute = %+v", more)
	}
	// Next minute: cards again.
	next := popNow.Add(time.Minute)
	if c := p.Take([]PEvent{popEvent("f8", 8, "phone_use", next)}, next, popNamer); len(c) != 1 || c[0].Kind != "alarm" {
		t.Fatalf("next minute = %+v", c)
	}
}

func TestPopupOnlyTheFourAlarms(t *testing.T) {
	p := NewPopups()
	cards := p.Take([]PEvent{
		popEvent("n1", 1, "lane_departure", popNow),
		popEvent("n2", 2, "camera_covered", popNow),
		popEvent("n3", 3, "over_speeding", popNow),
		popEvent("n4", 4, "driver_distracted", popNow),
	}, popNow, popNamer)
	if len(cards) != 2 || cards[0].Data.Alarm != "overspeeding" || cards[1].Data.Alarm != "driver_distracted" {
		t.Fatalf("cards = %+v", cards)
	}
	if !cards[0].Sound || !cards[1].Sound {
		t.Fatal("Overspeeding and Driver Distracted must sound")
	}
}

func TestPopupForgetsQuietRuns(t *testing.T) {
	p := NewPopups()
	p.Take([]PEvent{popEvent("m1", 1, "phone_use", popNow)}, popNow, popNamer)
	p.Take(nil, popNow.Add(31*time.Minute), popNamer)
	if len(p.runs) != 0 {
		t.Fatalf("quiet runs kept: %d", len(p.runs))
	}
}

// The live stream carries pop-ups only to those who may read alerts: a
// dispatcher (live map, no Alerts page) gets the frames after it, not the card.
func TestPopupLiveOnlyForAlertReaders(t *testing.T) {
	h := newHarness(t)
	admin, _ := h.login()
	_, dispatcher := h.invite(admin, "dispatch@samad.test", "dispatcher")
	srv := httptest.NewServer(h.h)
	defer srv.Close()

	frames := func(token string) []string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/v1/organisations/samad/live", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("live: %d", res.StatusCode)
		}
		// Subscribed before the headers were sent: publish now.
		b, _ := json.Marshal(Toast{ID: "pop-1", Kind: "alarm", Title: "KDT 953D: Phone Use"})
		h.hub.Publish(Frame{Event: "toast", Data: b})
		h.hub.Publish(Frame{Event: "marker", Data: []byte(`{}`)})
		var seen []string
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if ev, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
				seen = append(seen, ev)
				if ev == "marker" {
					return seen
				}
			}
		}
		t.Fatalf("stream ended before the marker: %v", seen)
		return nil
	}

	if got := frames(admin); !slices.Contains(got, "toast") {
		t.Fatalf("admin did not get the pop-up: %v", got)
	}
	if got := frames(dispatcher); slices.Contains(got, "toast") {
		t.Fatalf("dispatcher got a pop-up: %v", got)
	}
}
