package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var tNow = time.Date(2026, 11, 7, 14, 5, 0, 0, fleetZone)

func spd(f float64) *float64 { return &f }

// sample is a fleet with breaches, a critical alarm and units in and out of zones.
func sample(units int) *rptData {
	d := &rptData{From: dayStartOf(tNow), To: tNow, Now: tNow, Km: map[string]*float64{}, Places: map[string]string{}}
	for i := 0; i < units; i++ {
		u := rptUnit{ID: 100 + i, VehicleID: fmt.Sprint(100 + i), Plate: fmt.Sprintf("KDA %03dX", i), Type: "TRUCK", Online: i%5 != 0, Moving: i%3 == 0,
			HasPos: true, Lat: -1.2 - float64(i)/100, Lng: 36.8}
		if u.Online {
			u.Last = tNow.Add(-10 * time.Minute)
		}
		if i%4 == 0 {
			u.Driver = fmt.Sprintf("Driver %d", i)
		}
		if i%7 == 0 {
			u.Type = "TRAILER"
		}
		if i%6 != 1 {
			km := float64(i) * 3.7
			d.Km[u.VehicleID] = &km
		}
		if i%2 == 0 {
			d.Places[u.VehicleID] = "A109 Road, Voi"
		}
		d.Units = append(d.Units, u)
	}
	ev := func(id, kind string, unit int, mins int) rptEvent {
		return rptEvent{ID: id, Kind: kind, Label: strings.ReplaceAll(kind, "_", " "), Plate: d.Units[unit].Plate,
			VehicleID: d.Units[unit].VehicleID, At: tNow.Add(-time.Duration(mins) * time.Minute), Speed: spd(82)}
	}
	d.Events = []rptEvent{
		ev("1", "overspeed", 1, 300), ev("2", "overspeed", 1, 200), ev("3", "harsh_braking", 2, 100),
		ev("4", "no_seatbelt", 7, 90), ev("5", "critical", 3, 50), ev("6", "phone", 1, 20),
	}
	return d
}

func TestBuildBreaches(t *testing.T) {
	doc := buildBreaches(sample(10))
	if err := doc.Check(); err != nil {
		t.Fatal(err)
	}
	if doc.Summary["breaches"] != 5 || doc.Summary["vehicles"] != 3 {
		t.Errorf("summary: %v", doc.Summary)
	}
	var tables []Block
	for _, b := range doc.Blocks {
		if b.Type == "table" {
			tables = append(tables, b)
		}
	}
	// Trucks and a trailer: one section each, the largest first.
	if len(tables) != 2 || len(tables[0].Rows) != 2 || len(tables[1].Rows) != 1 {
		t.Fatalf("sections: %+v", tables)
	}
	top := tables[0].Rows[0]
	if top[0].Text != "KDA 001X" || top[len(top)-1].Text != "3" || top[2].Text != "2" {
		t.Errorf("worst first, overspeeding counted: %+v", top)
	}
	if doc.ReportNo != "PB-SAMAD-20261107-1405" || doc.Filename != "Policy Breaches Report Samad Resources 2026-11-07" {
		t.Errorf("number %q, file %q", doc.ReportNo, doc.Filename)
	}
}

func TestBuildMovementsAndShift(t *testing.T) {
	d := sample(10)
	mv := buildMovements(d)
	var rows [][]Cell
	for _, b := range mv.Blocks {
		if b.Type == "table" {
			rows = b.Rows
		}
	}
	if len(rows) != 10 || rows[0][0].Text != "KDA 009X" || rows[0][2].Text != "33.3 km" {
		t.Errorf("furthest first: %+v", rows[0])
	}
	if last := rows[len(rows)-1]; last[2].Text != "Not available" {
		t.Errorf("unknown distance last: %+v", last)
	}
	if rows[0][3].Text != "-1.2900, 36.8000" || rows[1][3].Text != "A109 Road, Voi" {
		t.Errorf("place: %q %q", rows[0][3].Text, rows[1][3].Text)
	}
	sh := buildShift(d, "Day, 07:30 to 19:30")
	if sh.Summary["critical"] != 1 || sh.Summary["breaches"] != 5 || sh.Summary["reporting"] != 8 {
		t.Errorf("shift: %v", sh.Summary)
	}
	if err := sh.Check(); err != nil {
		t.Fatal(err)
	}
}

func TestPeriodWords(t *testing.T) {
	day := dayStartOf(tNow)
	cases := map[string][2]time.Time{
		"7 Nov 2026":                 {day, day.Add(24 * time.Hour)},
		"1 Nov 2026 to 7 Nov 2026":   {day.Add(-6 * 24 * time.Hour), day.Add(24 * time.Hour)},
		"7 Nov 06:00 to 14:05":       {day.Add(6 * time.Hour), tNow},
		"6 Nov 18:00 to 7 Nov 06:00": {day.Add(-6 * time.Hour), day.Add(6 * time.Hour)},
	}
	for want, p := range cases {
		if got := periodWords(p[0], p[1]); got != want {
			t.Errorf("got %q want %q", got, want)
		}
	}
}

func TestDocCheck(t *testing.T) {
	d := ReportDoc{Kind: "breaches", Title: " Edited\ttitle\x07 ", Orientation: "sideways", Filename: `a/b:c`,
		Blocks: []Block{{Type: "table", Cols: []Col{{H: "A", W: -3}, {H: "B", W: 2}}, Rows: [][]Cell{{{Text: "x"}}, {{Text: "1"}, {Text: "2"}, {Text: "3"}}}}}}
	if err := d.Check(); err != nil {
		t.Fatal(err)
	}
	if d.Title != "Edited title" || d.Orientation != "portrait" || d.Filename != "a-b-c" {
		t.Errorf("tidied: %q %q %q", d.Title, d.Orientation, d.Filename)
	}
	rows := d.Blocks[0].Rows
	if len(rows[0]) != 2 || len(rows[1]) != 2 || d.Blocks[0].Cols[0].W != 1 {
		t.Errorf("rows evened, bad width fixed: %+v", d.Blocks[0])
	}
	for _, bad := range []ReportDoc{
		{Kind: "fuel", Title: "x"},
		{Kind: "shift", Title: ""},
		{Kind: "shift", Title: "x", Blocks: []Block{{Type: "html", Text: "<script>"}}},
		{Kind: "shift", Title: "x", Blocks: []Block{{Type: "table"}}},
	} {
		if err := bad.Check(); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

// bigDoc is a report long enough to run onto several pages.
func bigDoc(orient string) *ReportDoc {
	doc := buildMovements(sample(140))
	doc.Orientation = orient
	return doc
}

func TestLayoutPaginates(t *testing.T) {
	for _, orient := range []string{"portrait", "landscape"} {
		doc := bigDoc(orient)
		pages := layOut(doc)
		if len(pages) < 3 {
			t.Fatalf("%s: %d pages", orient, len(pages))
		}
		w, h := 210.0, 297.0
		if orient == "landscape" {
			w, h = 297, 210
		}
		seen := map[string]int{}
		for i, p := range pages {
			if p.W != w || p.H != h {
				t.Fatalf("%s page size %vx%v", orient, p.W, p.H)
			}
			heads, footer := 0, ""
			for _, op := range p.Ops {
				if op.X < -0.01 || op.Y < -0.01 || op.X+op.W > w+0.01 || op.Y > h+0.01 {
					t.Errorf("%s page %d: off the page %+v", orient, i+1, op)
				}
				if op.K == opText && op.S == "Current location" {
					heads++
				}
				if op.K == opText && strings.HasPrefix(op.S, "Page ") {
					footer = op.S
				}
				if op.K == opText && strings.HasPrefix(op.S, "KDA ") && op.St == fBold {
					seen[op.S]++
					// Nothing runs into the footer.
					if op.Y > h-(2+lineH(sFoot)+4) {
						t.Errorf("%s page %d: %s under the footer line", orient, i+1, op.S)
					}
				}
			}
			if heads != 1 {
				t.Errorf("%s page %d: table header drawn %d times", orient, i+1, heads)
			}
			if want := fmt.Sprintf("Page %d of %d", i+1, len(pages)); footer != want {
				t.Errorf("footer %q want %q", footer, want)
			}
		}
		if len(seen) != 140 {
			t.Errorf("%s: %d units placed", orient, len(seen))
		}
		for plate, n := range seen {
			if n != 1 {
				t.Errorf("%s: %s placed %d times", orient, plate, n)
			}
		}
	}
	// Landscape is wider: fewer pages.
	if p, l := len(layOut(bigDoc("portrait"))), len(layOut(bigDoc("landscape"))); l <= p && p > 0 && l == 0 {
		t.Errorf("portrait %d landscape %d", p, l)
	}
}

func TestHeadingNeverAlone(t *testing.T) {
	doc := &ReportDoc{Kind: "shift", Title: "T"}
	for i := 0; i < 40; i++ {
		doc.Blocks = append(doc.Blocks, Block{Type: "heading", Text: fmt.Sprintf("H%d", i)},
			Block{Type: "kpis", KPIs: []KPI{{Label: "A", Value: "1"}, {Label: "B long label that wraps onto a second line", Value: "2"}}})
	}
	for _, p := range layOut(doc) {
		var last *Op
		for i := range p.Ops {
			if op := &p.Ops[i]; op.K == opText && (strings.HasPrefix(op.S, "H") || op.S == "1") {
				last = op
			}
		}
		if last != nil && strings.HasPrefix(last.S, "H") {
			t.Errorf("a heading ends a page: %s", last.S)
		}
	}
}

func TestRenderFormats(t *testing.T) {
	doc := bigDoc("portrait")
	pages := layOut(doc)
	pdf, err := renderPDF(doc, pages, tNow)
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatalf("pdf: %v", err)
	}
	if n := bytes.Count(pdf, []byte("/Type /Page\n")) + bytes.Count(pdf, []byte("/Type /Page ")); n < len(pages) {
		t.Logf("pages counted in the PDF: %d (of %d)", n, len(pages))
	}
	img, sheetsN, err := renderJPEG(pages, 0)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(img))
	if err != nil || cfg.Width != 1488 || cfg.Height > sheetMaxH {
		t.Fatalf("jpeg %dx%d: %v", cfg.Width, cfg.Height, err)
	}
	if want := len(sheets(2105, len(pages))); sheetsN != want {
		t.Errorf("sheets %d want %d", sheetsN, want)
	}
	prev, err := renderPreview(pages[:1])
	if err != nil || len(prev) != 1 {
		t.Fatal(err)
	}
	csvB, err := renderCSV(&ReportDoc{Kind: "breaches", Title: "T", Blocks: []Block{{Type: "table", Cols: []Col{{H: "A", W: 1}},
		Rows: [][]Cell{{{Text: "=HYPERLINK(\"x\")"}}, {{Text: "-12.5"}}, {{Text: "-"}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	s := string(csvB)
	if !strings.HasPrefix(s, "\xEF\xBB\xBF") || !strings.Contains(s, `"'=HYPERLINK(""x"")"`) || !strings.Contains(s, "\r\n-12.5\r\n") || !strings.Contains(s, "\r\n-\r\n") {
		t.Errorf("csv: %q", s)
	}

	// REPORT_SAMPLES=<dir> go test -run TestRenderFormats writes the files to look at.
	if dir := os.Getenv("REPORT_SAMPLES"); dir != "" {
		for _, orient := range []string{"portrait", "landscape"} {
			docs := map[string]*ReportDoc{"movements": bigDoc(orient), "breaches": buildBreaches(sample(30)),
				"shift": buildShift(sample(30), "Day, 07:30 to 19:30"), "weekly": weeklySample(t), "conduct": conductSample()}
			for name, doc := range docs {
				doc.Orientation = orient
				pg := layOut(doc)
				p, _ := renderPDF(doc, pg, tNow)
				j, _, _ := renderJPEG(pg, 0)
				c, _ := renderCSV(doc)
				base := filepath.Join(dir, name+"-"+orient)
				_ = os.WriteFile(base+".pdf", p, 0o644)
				_ = os.WriteFile(base+".jpg", j, 0o644)
				_ = os.WriteFile(base+".csv", c, 0o644)
			}
		}
	}
}

type fakeHistory struct{ calls atomic.Int32 }

func (f *fakeHistory) History(_ context.Context, vid int, from, to time.Time) ([]PHistoryPoint, error) {
	f.calls.Add(1)
	if vid == 99 {
		return nil, fmt.Errorf("partner down")
	}
	var out []PHistoryPoint
	// A fix a minute heading north, ~0.5 km a minute (30 km/h), plus one GPS jump.
	for t := from; t.Before(to); t = t.Add(time.Minute) {
		n := t.Sub(dayStartOf(t)).Minutes()
		lat := -1.0 + n*0.0045
		if t.Equal(from.Add(30 * time.Minute)) {
			lat += 1 // 111 km in a minute: not driving
		}
		out = append(out, PHistoryPoint{Timestamp: t.UTC().Format(time.RFC3339), Latitude: lat, Longitude: 36.8})
	}
	return out, nil
}

func TestDistancesCached(t *testing.T) {
	c := newReportCache()
	h := &fakeHistory{}
	units := []rptUnit{{ID: 1, VehicleID: "1"}, {ID: 99, VehicleID: "99"}}
	yesterday := dayStartOf(tNow).Add(-24 * time.Hour)
	from, to := yesterday.Add(6*time.Hour), yesterday.Add(8*time.Hour)
	km, err := c.distances(context.Background(), h, units, from, to, tNow)
	if err != nil {
		t.Fatal(err)
	}
	// 2 h at 30 km/h; the jump and the jump back are dropped.
	if km["1"] == nil || *km["1"] < 59 || *km["1"] > 61 {
		t.Errorf("km: %v", km["1"])
	}
	if km["99"] != nil {
		t.Errorf("unread history: %v", *km["99"])
	}
	before := h.calls.Load()
	if _, err := c.distances(context.Background(), h, units[:1], yesterday.Add(9*time.Hour), yesterday.Add(10*time.Hour), tNow); err != nil {
		t.Fatal(err)
	}
	if h.calls.Load() != before {
		t.Error("a closed day was read twice")
	}
}

func TestPlaceWords(t *testing.T) {
	r := geoResult{FormattedAddress: "4QX2+6C Voi, Kenya"}
	r.AddressComponents = append(r.AddressComponents,
		struct {
			LongName string   `json:"long_name"`
			Types    []string `json:"types"`
		}{"A109", []string{"route"}},
		struct {
			LongName string   `json:"long_name"`
			Types    []string `json:"types"`
		}{"Voi", []string{"locality", "political"}})
	if got := placeWords(r); got != "A109, Voi" {
		t.Errorf("got %q", got)
	}
	if got := placeWords(geoResult{FormattedAddress: "4QX2+6C Voi, Kenya"}); got != "Voi" {
		t.Errorf("plus code: %q", got)
	}
}

func TestReportRoutes(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	now := time.Now()
	h.store.AddEvents([]PEvent{
		{EventID: "sb", Source: "device", Type: "no_seatbelt", Severity: "critical", OccurredAt: now.Add(-time.Hour).UTC().Format(time.RFC3339), VehicleID: 7, Registration: "KDA 7"},
	}, "")
	from := fmt.Sprint(now.Add(-24 * time.Hour).UnixMilli())
	rec := h.do("GET", "/api/v1/reports/breaches/document?org=samad&from="+from, token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("document: %d %s", rec.Code, rec.Body)
	}
	var out struct{ Data ReportDoc }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Data.Kind != "breaches" || out.Data.Summary["breaches"] != float64(1) {
		t.Fatalf("doc: %+v", out.Data.Summary)
	}
	if rec := h.do("GET", "/api/v1/reports/shift/document?org=samad&day=2099-01-01&shift=day", token, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("future shift: %d", rec.Code)
	}
	if rec := h.do("GET", "/api/v1/reports/shift/document?org=samad&day="+fleetDay(now.Add(-24*time.Hour))+"&shift=night", token, nil); rec.Code != http.StatusOK {
		t.Errorf("last night: %d %s", rec.Code, rec.Body)
	}

	edited := out.Data
	edited.Title = "Edited Breaches"
	edited.Orientation = "landscape"
	for format, ctype := range map[string]string{"pdf": "application/pdf", "jpeg": "image/jpeg", "csv": "text/csv; charset=utf-8", "preview": "application/json"} {
		rec := h.do("POST", "/api/v1/reports/render?org=samad&format="+format, token, edited)
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != ctype {
			t.Errorf("%s: %d %s %s", format, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String()[:min(200, rec.Body.Len())])
		}
		if format == "pdf" && !strings.Contains(rec.Header().Get("Content-Disposition"), `filename="Policy Breaches Report Samad Resources`) {
			t.Errorf("disposition: %s", rec.Header().Get("Content-Disposition"))
		}
		if format == "jpeg" && rec.Header().Get("X-Sheets") != "1" {
			t.Errorf("sheets: %s", rec.Header().Get("X-Sheets"))
		}
	}
	if rec := h.do("POST", "/api/v1/reports/render?org=samad&format=docx", token, edited); rec.Code != http.StatusBadRequest {
		t.Errorf("docx: %d", rec.Code)
	}
	if rec := h.do("POST", "/api/v1/reports/render?org=samad&format=pdf", "", edited); rec.Code != http.StatusUnauthorized {
		t.Errorf("signed out: %d", rec.Code)
	}
	if rec := h.do("POST", "/api/v1/reports/render?org=other&format=pdf", token, edited); rec.Code != http.StatusNotFound {
		t.Errorf("other org: %d", rec.Code)
	}
}

// weeklyStore is two trucks over two weeks: KDA 001A changes driver midweek,
// KDB 002B has none.
func weeklyStore(t *testing.T) (*Store, time.Time) {
	t.Helper()
	now := tNow // Saturday 7 Nov: the last finished week is 26 Oct to 1 Nov
	st := NewStore(t.TempDir())
	st.vehicles[1] = PVehicle{VehicleID: 1, Registration: "KDA 001A", Driver: &PPerson{Name: "JOHN DOE"}}
	st.vehicles[2] = PVehicle{VehicleID: 2, Registration: "KDB 002B"}
	for day := time.Date(2026, 10, 19, 0, 0, 0, 0, fleetZone); day.Before(time.Date(2026, 11, 2, 0, 0, 0, 0, fleetZone)); day = day.AddDate(0, 0, 1) {
		driver := "John Doe"
		if !day.Before(time.Date(2026, 10, 28, 0, 0, 0, 0, fleetZone)) {
			driver = "Mary Ann"
		}
		st.p.Days[fleetDay(day)] = map[int]*DayStats{1: {Km: 100, Driver: driver}, 2: {Km: 50}}
	}
	ev := func(id, typ string, vid int, at time.Time) PEvent {
		ts := at.UTC().Format(time.RFC3339)
		return PEvent{EventID: id, Type: typ, Severity: "warning", OccurredAt: ts, ReceivedAt: ts, VehicleID: vid}
	}
	d := func(day, hour int) time.Time { return time.Date(2026, 10, day, hour, 0, 0, 0, fleetZone) }
	var events []PEvent
	for i := 0; i < 4; i++ {
		events = append(events, ev(fmt.Sprint("o", i), "over_speeding", 1, d(20, 8+i)))
	}
	events = append(events, ev("p", "phone_use", 1, d(27, 9)), ev("b1", "harsh_braking", 1, d(30, 9)), ev("b2", "harsh_braking", 1, d(30, 10)),
		ev("lane", "lane_departure", 1, d(30, 11))) // not an incident
	for i := 0; i < 3; i++ {
		events = append(events, ev(fmt.Sprint("s", i), "no_seatbelt", 2, d(29, 8+i)))
	}
	st.AddEvents(events, "")
	return st, now
}

func weeklyDoc(st *Store, n int, now time.Time) *ReportDoc {
	ws := st.weekSource(now)
	end := weekStart(now)
	cols := make([]wkCol, n+1)
	for i := range cols {
		start := end.AddDate(0, 0, -7*(n+1-i))
		tl, ok := ws.week(start)
		cols[i] = wkCol{start: start, tally: tl, have: ok}
	}
	return buildWeekly(cols, ws.vehicles, now)
}

func weeklySample(t *testing.T) *ReportDoc {
	st, now := weeklyStore(t)
	return weeklyDoc(st, 3, now)
}

func tableAfter(doc *ReportDoc, heading string) [][]Cell {
	seen := false
	for _, b := range doc.Blocks {
		if b.Type == "heading" && strings.HasSuffix(b.Text, heading) {
			seen = true
		}
		if seen && b.Type == "table" {
			return b.Rows
		}
	}
	return nil
}

func TestWeeklyIncidents(t *testing.T) {
	st, now := weeklyStore(t)
	doc := weeklyDoc(st, 2, now)
	if err := doc.Check(); err != nil {
		t.Fatal(err)
	}
	if doc.Summary["incidents"] != 6 || doc.Summary["week"] != "Wk 44" || doc.Summary["change"] != "Up 2 (+50%)" {
		t.Errorf("summary: %v", doc.Summary)
	}
	row := func(rows [][]Cell, name string) []Cell {
		for _, r := range rows {
			if r[0].Text == name {
				return r
			}
		}
		t.Fatalf("no row %q in %v", name, rows)
		return nil
	}
	drivers := tableAfter(doc, "Drivers")
	// Columns: name, with, Wk 43, Wk 44, total, per 100 km, change.
	if r := row(drivers, "John Doe"); r[1].Text != "KDA 001A" || r[2].Text != "4" || r[3].Text != "1" || r[6].Text != "Down 3 (−75%)" {
		t.Errorf("John: %+v", r)
	}
	if r := row(drivers, "Mary Ann"); r[2].Text != "-" || r[3].Text != "2" || r[5].Text != "0.4" || r[6].Text != "Up 2" {
		t.Errorf("Mary, from Wednesday: %+v", r)
	}
	if r := row(drivers, "No driver on record"); r[3].Text != "3" {
		t.Errorf("no driver: %+v", r)
	}
	if r := row(tableAfter(doc, "Trucks"), "KDA 001A"); r[1].Text != "John Doe, Mary Ann" || r[6].Text != "Down 1 (−25%)" {
		t.Errorf("truck: %+v", r)
	}

	// The tallies outlive the events: a month on, the weeks still read the same.
	st.Prune(now)
	later := now.AddDate(0, 0, 30)
	st.Prune(later)
	if len(st.Events()) != 0 {
		t.Fatalf("events kept: %d", len(st.Events()))
	}
	ws := st.weekSource(later)
	tl, ok := ws.week(time.Date(2026, 10, 26, 0, 0, 0, 0, fleetZone))
	if !ok || sumCounts(tl.Units[1].Counts) != 3 || tl.Units[1].Drivers["MARY ANN"].Counts["harsh_braking"] != 2 || tl.Units[1].Km != 700 {
		t.Fatalf("kept week: %v %+v", ok, tl)
	}
	if _, ok := ws.week(time.Date(2026, 10, 12, 0, 0, 0, 0, fleetZone)); ok {
		t.Error("a week before any record has none")
	}

	pages := layOut(doc)
	if _, err := renderPDF(doc, pages, now); err != nil {
		t.Fatal(err)
	}
	if _, err := renderCSV(doc); err != nil {
		t.Fatal(err)
	}
}

func TestWeeklyRoute(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	rec := h.do("GET", "/api/v1/reports/weekly/document?org=samad&weeks=4", token, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"kind":"weekly"`) {
		t.Fatalf("weekly: %d %s", rec.Code, rec.Body)
	}
	if rec := h.do("GET", "/api/v1/reports/weekly/document?org=samad&weeks=13", token, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("13 weeks: %d", rec.Code)
	}
}

func TestShiftLikeTheSheet(t *testing.T) {
	sh := buildShift(sample(10), "Day, 07:30 to 19:30")
	types := []string{}
	for _, b := range sh.Blocks {
		types = append(types, b.Type)
	}
	want := "heading kpis heading table heading counts spacer groups note heading lines sign"
	if got := strings.Join(types, " "); got != want {
		t.Errorf("blocks:\n got %s\nwant %s", got, want)
	}
	if sh.Orientation != "landscape" {
		t.Error("landscape, like the sheet")
	}
	for _, b := range sh.Blocks {
		if b.Type == "groups" {
			if g := b.Groups[0]; g.Text != "Overspeeding" || g.Small != "all 1 unit" || g.Rows[0][2].Text != "2" {
				t.Errorf("overspeeding: %+v", g)
			}
			if g := b.Groups[2]; len(g.Rows) != 0 || g.Empty != "None in the shift." {
				t.Errorf("harsh acceleration: %+v", g)
			}
		}
	}
	// An edited groups block is tidied like a table.
	sh.Blocks = append(sh.Blocks, Block{Type: "groups", Groups: []SubTable{{Text: "x", Cols: []Col{{H: "A", W: 0}}, Rows: [][]Cell{{{Text: "1"}, {Text: "2"}}}}}})
	if err := sh.Check(); err != nil {
		t.Fatal(err)
	}
	if g := sh.Blocks[len(sh.Blocks)-1].Groups[0]; len(g.Rows[0]) != 1 || g.Cols[0].W != 1 {
		t.Errorf("tidied: %+v", g)
	}
	if n := len(layOut(sh)); n < 1 {
		t.Error("no pages")
	}
}

func conductSample() *ReportDoc {
	d := sample(10)
	d.Untracked = []string{"KDZ 900B", "KDZ 100A"}
	d.DayDrivers = map[string]map[int]string{fleetDay(tNow): {102: "Grace Atieno"}}
	return buildConduct(d)
}

func TestBuildConduct(t *testing.T) {
	doc := conductSample()
	if err := doc.Check(); err != nil {
		t.Fatal(err)
	}
	// Overspeeding and the critical alarm are not conduct: phone, braking, seatbelt are.
	if doc.Summary["incidents"] != 3 || doc.Summary["vehicles"] != 3 {
		t.Errorf("summary: %v", doc.Summary)
	}
	var heads []string
	for _, b := range doc.Blocks {
		if b.Type == "heading" {
			heads = append(heads, b.Text)
		}
	}
	if got := strings.Join(heads, " | "); got != "1. Overview | 2. Trucks | 3. Trailers | 4. Not tracked on the platform" {
		t.Errorf("sections: %s", got)
	}
	trucks := tableAfter(doc, "Trucks")
	// Plates in order; the driver is the one on the truck that day.
	if len(trucks) != 2 || trucks[0][0].Text != "KDA 001X" || trucks[1][2].Text != "Grace Atieno" || trucks[0][len(trucks[0])-1].Text != "1" {
		t.Errorf("trucks: %+v", trucks)
	}
	if rows := tableAfter(doc, "Not tracked on the platform"); rows[0][0].Text != "Trucks (2)" || rows[0][1].Text != "KDZ 100A, KDZ 900B" {
		t.Errorf("untracked: %+v", rows)
	}
}

func TestShiftCustomPeriod(t *testing.T) {
	h := newHarness(t)
	token, _ := h.login()
	now := time.Now()
	from := fmt.Sprint(now.Add(-30 * time.Hour).UnixMilli())
	to := fmt.Sprint(now.Add(-2 * time.Hour).UnixMilli())
	rec := h.do("GET", "/api/v1/reports/shift/document?org=samad&shift=custom&from="+from+"&to="+to, token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("custom: %d %s", rec.Code, rec.Body)
	}
	var out struct{ Data ReportDoc }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Data.Info[1].Value != periodWords(time.UnixMilli(now.Add(-30*time.Hour).UnixMilli()), time.UnixMilli(now.Add(-2*time.Hour).UnixMilli())) || !strings.HasSuffix(out.Data.Filename, " custom") {
		t.Errorf("custom shift: %+v %q", out.Data.Info, out.Data.Filename)
	}
	// The day shift runs 07:30 to 19:30.
	rec = h.do("GET", "/api/v1/reports/shift/document?org=samad&shift=day&day="+fleetDay(now.Add(-24*time.Hour)), token, nil)
	var day struct{ Data ReportDoc }
	if err := json.Unmarshal(rec.Body.Bytes(), &day); err != nil || !strings.HasSuffix(day.Data.Info[1].Value, "Day, 07:30 to 19:30") {
		t.Errorf("day shift: %d %+v", rec.Code, day.Data.Info)
	}
	old := fmt.Sprint(now.Add(-40 * 24 * time.Hour).UnixMilli())
	if rec := h.do("GET", "/api/v1/reports/shift/document?org=samad&shift=custom&from="+old+"&to="+fmt.Sprint(now.Add(-39*24*time.Hour).UnixMilli()), token, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("40 days ago: %d", rec.Code)
	}
	if rec := h.do("GET", "/api/v1/reports/conduct/document?org=samad&from="+from, token, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"kind":"conduct"`) {
		t.Errorf("conduct: %d", rec.Code)
	}
}
