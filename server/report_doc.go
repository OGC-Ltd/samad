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
	Kind        string     `json:"kind"` // breaches | movements | shift | weekly | conduct
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
//	counts   a strip of figures: label, value and Sub under it, centred
//	groups   small titled tables, two side by side
//	bars     a bar per figure (Value read as a number), Sub after it
//	lines    N ruled lines to write on
//	sign     a signature line per figure, its Label under it
type Block struct {
	Type   string     `json:"type"`
	Text   string     `json:"text,omitempty"`
	Small  string     `json:"small,omitempty"`
	KPIs   []KPI      `json:"kpis,omitempty"`
	Cols   []Col      `json:"cols,omitempty"`
	Rows   [][]Cell   `json:"rows,omitempty"`
	Groups []SubTable `json:"groups,omitempty"`
	N      int        `json:"n,omitempty"`
}

type KPI struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Sub   string `json:"sub,omitempty"`
}

// SubTable is one small table of a groups block: a title, a note on the right,
// and its rows, or Empty when it has none.
type SubTable struct {
	Text  string   `json:"text"`
	Small string   `json:"small,omitempty"`
	Empty string   `json:"empty,omitempty"`
	Cols  []Col    `json:"cols,omitempty"`
	Rows  [][]Cell `json:"rows,omitempty"`
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
	docMaxGroups = 40
	docMaxLines  = 30
)

var docBlockTypes = map[string]bool{"heading": true, "kpis": true, "table": true, "note": true, "empty": true, "spacer": true,
	"counts": true, "groups": true, "bars": true, "lines": true, "sign": true}

// tidyTable checks a table's columns and makes every row as wide as the
// header: short rows padded, long ones cut. It returns the cells it holds.
func tidyTable(cols []Col, rows [][]Cell) (int, error) {
	if len(cols) == 0 || len(cols) > docMaxCols {
		return 0, fmt.Errorf("a table has 1 to %d columns", docMaxCols)
	}
	if len(rows) > docMaxRows {
		return 0, fmt.Errorf("a table holds %d rows at most", docMaxRows)
	}
	for c := range cols {
		cols[c].H = clean(cols[c].H)
		if !(cols[c].W > 0) || cols[c].W > 1000 {
			cols[c].W = 1
		}
	}
	cells := 0
	for r := range rows {
		row := rows[r]
		if len(row) > len(cols) {
			row = row[:len(cols)]
		}
		for len(row) < len(cols) {
			row = append(row, Cell{})
		}
		for c := range row {
			row[c].Text = clean(row[c].Text)
		}
		rows[r] = row
		cells += len(row)
	}
	return cells, nil
}

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
	case "breaches", "movements", "shift", "weekly", "conduct":
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
			b.KPIs[k].Label, b.KPIs[k].Value, b.KPIs[k].Sub = clean(b.KPIs[k].Label), clean(b.KPIs[k].Value), clean(b.KPIs[k].Sub)
		}
		b.N = min(max(b.N, 0), docMaxLines)
		switch b.Type {
		case "table":
			b.Groups = nil
			n, err := tidyTable(b.Cols, b.Rows)
			if err != nil {
				return fmt.Errorf("section %d: %w", bi+1, err)
			}
			cells += n
		case "groups":
			b.Cols, b.Rows = nil, nil
			if len(b.Groups) > docMaxGroups {
				return fmt.Errorf("section %d: %d tables at most", bi+1, docMaxGroups)
			}
			for g := range b.Groups {
				gr := &b.Groups[g]
				gr.Text, gr.Small, gr.Empty = clean(gr.Text), clean(gr.Small), clean(gr.Empty)
				if len(gr.Cols) == 0 {
					gr.Rows = nil
					continue
				}
				n, err := tidyTable(gr.Cols, gr.Rows)
				if err != nil {
					return fmt.Errorf("section %d, %q: %w", bi+1, gr.Text, err)
				}
				cells += n
			}
		default:
			b.Cols, b.Rows, b.Groups = nil, nil, nil
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
