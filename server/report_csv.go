package main

// A report as CSV, for a spreadsheet: the title and facts, then each section
// in order (figures as label, value; tables with their header row), a blank
// line between sections. UTF-8 with a byte-order mark so Excel reads the
// "·" and accented names right.

import (
	"bytes"
	"encoding/csv"
	"strings"
)

// safeCell stops a spreadsheet reading a value as a formula ("=HYPERLINK…").
func safeCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '@', '\t', '\r':
		return "'" + s
	case '-':
		if len(s) > 1 && !strings.ContainsRune("0123456789. ", rune(s[1])) {
			return "'" + s
		}
	}
	return s
}

func renderCSV(d *ReportDoc) ([]byte, error) {
	var buf bytes.Buffer
	buf.Write([]byte{0xEF, 0xBB, 0xBF}) // the byte-order mark
	w := csv.NewWriter(&buf)
	w.UseCRLF = true
	put := func(cells ...string) {
		for i := range cells {
			cells[i] = safeCell(cells[i])
		}
		_ = w.Write(cells)
	}
	put(d.Title, d.Company)
	put("Report no.", d.ReportNo)
	for _, p := range d.Info {
		put(p.Label, p.Value)
	}
	for _, b := range d.Blocks {
		switch b.Type {
		case "heading":
			put()
			if b.Small != "" {
				put(b.Text, b.Small)
			} else {
				put(b.Text)
			}
		case "kpis":
			for _, k := range b.KPIs {
				put(k.Label, k.Value)
			}
		case "table":
			head := make([]string, len(b.Cols))
			for i, c := range b.Cols {
				head[i] = c.H
			}
			put(head...)
			for _, row := range b.Rows {
				cells := make([]string, len(row))
				for i, c := range row {
					cells[i] = c.Text
					if c.Indent {
						cells[i] = "  " + c.Text
					}
				}
				put(cells...)
			}
		case "note", "empty":
			put(b.Text)
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}
