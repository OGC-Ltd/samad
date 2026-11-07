package main

// A report as a document: what the server builds for each report
// (report_build.go), what the Reports page shows and lets the operator edit,
// and what the renderers draw (report_layout.go → PDF, JPEG, preview pages;
// report_csv.go → CSV). Plain text only, never HTML: an edited document is
// drawn as written, so nothing typed into it can become markup or script.

import (
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ReportDoc is one report, ready to draw.
type ReportDoc struct {
	Kind        string     `json:"kind"` // breaches | movements | shift
	Title       string     `json:"title"`
	ReportNo    string     `json:"reportNo"`
	Date        string     `json:"date"` // shown beside the number
	Company     string     `json:"company"`
	Orientation string     `json:"orientation"` // portrait | landscape
	Info        []InfoPair `json:"info"`        // facts under the title, two to a row
	Blocks      []Block    `json:"blocks"`      // the report, in order
	FootNote    string     `json:"footNote"`    // left of every page's footer
	Filename    string     `json:"filename"`    // without the extension
	GeneratedAt string     `json:"generatedAt"` // RFC 3339
	// The figures the page's summary line shows; not drawn.
	Summary map[string]any `json:"summary,omitempty"`
}

type InfoPair struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// Block is one piece of the report's flow.
//
//	heading  Text, with Small on the right
//	kpis     a row of boxed figures
//	table    Cols and Rows
//	note     a small grey line, wrapped
//	empty    "nothing here" in italics
//	spacer   a little room
type Block struct {
	Type  string   `json:"type"`
	Text  string   `json:"text,omitempty"`
	Small string   `json:"small,omitempty"`
	KPIs  []KPI    `json:"kpis,omitempty"`
	Cols  []Col    `json:"cols,omitempty"`
	Rows  [][]Cell `json:"rows,omitempty"`
}

type KPI struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// Col is a table column: W is its share of the width, not a measure.
type Col struct {
	H     string  `json:"h"`
	W     float64 `json:"w"`
	Right bool    `json:"right,omitempty"`
}

type Cell struct {
	Text   string `json:"text"`
	Bold   bool   `json:"bold,omitempty"`
	Muted  bool   `json:"muted,omitempty"`
	Wrap   bool   `json:"wrap,omitempty"`   // wrap onto more lines instead of "…"
	Indent bool   `json:"indent,omitempty"` // a sub-row under the one above
}

// What one edited document may hold: a month of a large fleet fits well inside.
const (
	docMaxBlocks = 300
	docMaxRows   = 5000 // per table
	docMaxCells  = 60000
	docMaxCols   = 20
	docMaxKPIs   = 16
	docMaxInfo   = 20
	docMaxText   = 600 // characters in any one field
)

var docBlockTypes = map[string]bool{"heading": true, "kpis": true, "table": true, "note": true, "empty": true, "spacer": true}

// clean keeps a field to one line of printable text, at most docMaxText long.
func clean(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			return ' '
		case unicode.IsControl(r):
			return -1
		}
		return r
	}, s)
	if utf8.RuneCountInString(s) > docMaxText {
		s = string([]rune(s)[:docMaxText])
	}
	return strings.TrimSpace(s)
}

// Check tidies an edited document and refuses one that is not a report.
func (d *ReportDoc) Check() error {
	switch d.Kind {
	case "breaches", "movements", "shift":
	default:
		return errors.New("unknown report")
	}
	if d.Orientation != "landscape" {
		d.Orientation = "portrait"
	}
	if len(d.Blocks) > docMaxBlocks {
		return fmt.Errorf("a report holds %d sections at most", docMaxBlocks)
	}
	if len(d.Info) > docMaxInfo {
		return fmt.Errorf("a report holds %d facts at most", docMaxInfo)
	}
	for _, p := range []*string{&d.Title, &d.ReportNo, &d.Date, &d.Company, &d.FootNote, &d.Filename} {
		*p = clean(*p)
	}
	if d.Title == "" {
		return errors.New("the report needs a title")
	}
	for i := range d.Info {
		d.Info[i].Label, d.Info[i].Value = clean(d.Info[i].Label), clean(d.Info[i].Value)
	}
	cells := 0
	for bi := range d.Blocks {
		b := &d.Blocks[bi]
		if !docBlockTypes[b.Type] {
			return fmt.Errorf("section %d: unknown kind %q", bi+1, b.Type)
		}
		b.Text, b.Small = clean(b.Text), clean(b.Small)
		if len(b.KPIs) > docMaxKPIs {
			return fmt.Errorf("section %d: %d figures at most", bi+1, docMaxKPIs)
		}
		for k := range b.KPIs {
			b.KPIs[k].Label, b.KPIs[k].Value = clean(b.KPIs[k].Label), clean(b.KPIs[k].Value)
		}
		if b.Type != "table" {
			b.Cols, b.Rows = nil, nil
			continue
		}
		if len(b.Cols) == 0 || len(b.Cols) > docMaxCols {
			return fmt.Errorf("section %d: a table has 1 to %d columns", bi+1, docMaxCols)
		}
		if len(b.Rows) > docMaxRows {
			return fmt.Errorf("section %d: a table holds %d rows at most", bi+1, docMaxRows)
		}
		for c := range b.Cols {
			b.Cols[c].H = clean(b.Cols[c].H)
			if !(b.Cols[c].W > 0) || b.Cols[c].W > 1000 {
				b.Cols[c].W = 1
			}
		}
		for r := range b.Rows {
			row := b.Rows[r]
			// Every row as wide as the header: short rows padded, long ones cut.
			if len(row) > len(b.Cols) {
				row = row[:len(b.Cols)]
			}
			for len(row) < len(b.Cols) {
				row = append(row, Cell{})
			}
			for c := range row {
				row[c].Text = clean(row[c].Text)
			}
			b.Rows[r] = row
			cells += len(row)
		}
	}
	if cells > docMaxCells {
		return fmt.Errorf("a report holds %d table cells at most", docMaxCells)
	}
	if d.Filename == "" {
		d.Filename = d.Title
	}
	// A file name the browser and every OS will take as it is.
	d.Filename = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) {
			return '-'
		}
		return r
	}, d.Filename)
	return nil
}
