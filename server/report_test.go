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
	sh := buildShift(d, "Day, 06:00 to 18:00")
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
			Block{Type: "kpis", KPIs: []KPI{{"A", "1"}, {"B long label that wraps onto a second line", "2"}}})
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
			for name, doc := range map[string]*ReportDoc{"movements": bigDoc(orient), "breaches": buildBreaches(sample(30)), "shift": buildShift(sample(30), "Day, 06:00 to 18:00")} {
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
