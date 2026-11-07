package main

// A report as CSV, for a spreadsheet: the title and facts, then each section
// in order (figures as label, value[, sub]; tables, and each small table of a
// groups block, with their header row), a blank line between sections. Lines
// to write on and signatures are left out. UTF-8 with a byte-order mark so Excel reads the
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
	table := func(cols []Col, rows [][]Cell) {
		head := make([]string, len(cols))
		for i, c := range cols {
			head[i] = c.H
		}
		put(head...)
		for _, row := range rows {
			cells := make([]string, len(row))
			for i, c := range row {
				cells[i] = c.Text
				if c.Indent {
					cells[i] = "  " + c.Text
				}
			}
			put(cells...)
		}
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
		case "counts", "bars":
			for _, k := range b.KPIs {
				put(k.Label, k.Value, k.Sub)
			}
		case "table":
			table(b.Cols, b.Rows)
		case "groups":
			for _, g := range b.Groups {
				put()
				put(g.Text, g.Small)
				if len(g.Rows) == 0 {
					put(g.Empty)
					continue
				}
				table(g.Cols, g.Rows)
			}
		case "note", "empty":
			put(b.Text)
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}
