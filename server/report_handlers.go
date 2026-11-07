package main

// The Reports page's two routes:
//
//	GET  /reports/{breaches|movements|shift}/document?org=&from=&to=
//	     (End of Shift: ?org=&day=YYYY-MM-DD&shift=day|night)
//	     → { data: ReportDoc }, the report the server built, ready to edit
//	POST /reports/render?org=&format=pdf|jpeg|csv|preview[&sheet=N]
//	     body: a ReportDoc, as built or as edited on the page
//	     → the file; preview → { data: { pages: [data URL], count } }.
//	       A JPEG of a long report is cut into sheets: X-Sheets says how many,
//	       ?sheet= picks one (0-based).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
)

const (
	reportBuildTimeout = 5 * time.Minute // a cold month of trip history for every unit
	renderBodyMax      = 8 << 20
)

var shiftStarts = map[string]struct {
	label string
	hour  int
}{"day": {"Day", 6}, "night": {"Night", 18}}

func (s *Server) reportDocument(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	kind := mux.Vars(r)["kind"]
	now := time.Now()
	var from, to time.Time
	shiftWords := ""
	if kind == "shift" {
		q := r.URL.Query()
		day, err := time.ParseInLocation("2006-01-02", q.Get("day"), fleetZone)
		sh, ok := shiftStarts[q.Get("shift")]
		if err != nil || !ok {
			writeError(w, http.StatusBadRequest, "pick a day (YYYY-MM-DD) and a shift (day or night)")
			return
		}
		from = day.Add(time.Duration(sh.hour) * time.Hour)
		to = from.Add(12 * time.Hour)
		if !from.Before(now) {
			writeError(w, http.StatusBadRequest, "that shift has not started yet")
			return
		}
		if to.After(now) {
			to = now
		}
		if now.Sub(from) > reportMaxDays*24*time.Hour {
			writeError(w, http.StatusBadRequest, "events are kept for 30 days; pick a later shift")
			return
		}
		shiftWords = fmt.Sprintf("%s, %02d:00 to %02d:00", sh.label, sh.hour, (sh.hour+12)%24)
	} else {
		var problem string
		from, to, problem = reportPeriod(r, now)
		if problem != "" {
			writeError(w, http.StatusBadRequest, problem)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), reportBuildTimeout)
	defer cancel()
	doc, err := s.buildReport(ctx, kind, from, to, now, shiftWords)
	if err != nil {
		if r.Context().Err() != nil {
			return // the page left
		}
		writeError(w, http.StatusGatewayTimeout, "the trip history took too long to read; try a shorter period")
		return
	}
	if r.URL.Query().Get("orientation") == "landscape" {
		doc.Orientation = "landscape"
	}
	writeData(w, doc)
}

// attachment names the download, plainly for old clients and in UTF-8 for the rest.
func attachment(w http.ResponseWriter, name string) {
	plain := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return '-'
		}
		return r
	}, name)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, plain, url.PathEscape(name)))
}

func (s *Server) reportRender(w http.ResponseWriter, r *http.Request) {
	if !s.orgParam(w, r) {
		return
	}
	format := r.URL.Query().Get("format")
	switch format {
	case "pdf", "jpeg", "csv", "preview":
	default:
		writeError(w, http.StatusBadRequest, "format must be pdf, jpeg, csv or preview")
		return
	}
	var doc ReportDoc
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, renderBodyMax))
	if err := dec.Decode(&doc); err != nil {
		writeError(w, http.StatusBadRequest, "the report could not be read")
		return
	}
	if err := doc.Check(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	if format == "csv" {
		b, err := renderCSV(&doc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "the CSV could not be made")
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		attachment(w, doc.Filename+".csv")
		_, _ = w.Write(b)
		return
	}

	pages := layOut(&doc)
	if format == "pdf" {
		b, err := renderPDF(&doc, pages, time.Now())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "the PDF could not be made")
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		attachment(w, doc.Filename+".pdf")
		_, _ = w.Write(b)
		return
	}

	// Pictures take memory while they are drawn: one at a time.
	select {
	case s.reports.draw <- struct{}{}:
		defer func() { <-s.reports.draw }()
	case <-r.Context().Done():
		return
	}
	if format == "preview" {
		imgs, err := renderPreview(pages)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "the preview could not be made")
			return
		}
		urls := make([]string, len(imgs))
		for i, b := range imgs {
			urls[i] = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(b)
		}
		writeData(w, map[string]any{"pages": urls, "count": len(urls)})
		return
	}
	sheet, _ := strconv.Atoi(r.URL.Query().Get("sheet"))
	b, n, err := renderJPEG(pages, sheet)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "the JPEG could not be made")
		return
	}
	name := doc.Filename + ".jpg"
	if n > 1 {
		name = fmt.Sprintf("%s (%d of %d).jpg", doc.Filename, min(max(sheet, 0), n-1)+1, n)
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Sheets", strconv.Itoa(n))
	attachment(w, name)
	_, _ = w.Write(b)
}
