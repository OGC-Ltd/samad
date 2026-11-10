package main

// The report letterhead, laid out once into A4 pages of drawing steps (text,
// boxes, lines, logos) in millimetres. The PDF (report_pdf.go), the JPEG and
// the preview pages (report_image.go) all draw these same steps, so every
// format comes out alike, in portrait or landscape.
//
// The look is the dashboard's letterhead (lib/letterhead, operator
// 2026-11-03): a dark band with Samad's logo on the left and OGC Monitoring's
// on the right, the title and report number under a rule, a facts table,
// then the report as one flow of headings, figures, tables and notes. Black,
// white and greys only. A block that does not fit moves to the next page, a
// long table is split between rows with its header repeated, and a heading is
// never left alone at a page foot.

import (
	"bytes"
	_ "embed"
	"image"
	_ "image/png"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goitalic"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

//go:embed assets/samad-logo-letterhead.png
var logoSamad []byte

//go:embed assets/ogc-monitoring-logo.png
var logoOGC []byte

const ptMM = 25.4 / 72 // one point in millimetres

type rgb struct{ R, G, B uint8 }

var (
	cInk  = rgb{0x1c, 0x1c, 0x1c}
	cMut  = rgb{0x5c, 0x5c, 0x5c}
	cRule = rgb{0xbf, 0xbf, 0xbf}
	cSoft = rgb{0xe6, 0xe6, 0xe6}
	cBand = rgb{0x21, 0x21, 0x21}
	cBar  = rgb{0x7a, 0x7a, 0x7a}
)

type fontStyle uint8

const (
	fRegular fontStyle = iota
	fBold
	fItalic
)

// ── the font, measured: the Go fonts, embedded, so no file is needed ───────

type face struct {
	mu   sync.Mutex
	f    *sfnt.Font
	ttf  []byte
	upem float64
	buf  sfnt.Buffer
	adv  map[rune]float64 // in em
}

var faces = func() [3]*face {
	var out [3]*face
	for i, ttf := range [][]byte{goregular.TTF, gobold.TTF, goitalic.TTF} {
		f, err := sfnt.Parse(ttf)
		if err != nil {
			panic(err)
		}
		out[i] = &face{f: f, ttf: ttf, upem: float64(f.UnitsPerEm()), adv: map[rune]float64{}}
	}
	return out
}()

func (fc *face) advance(r rune) float64 {
	if a, ok := fc.adv[r]; ok {
		return a
	}
	a := 0.5
	if idx, err := fc.f.GlyphIndex(&fc.buf, r); err == nil && idx != 0 {
		if v, err := fc.f.GlyphAdvance(&fc.buf, idx, fixed.I(int(fc.upem)), font.HintingNone); err == nil {
			a = float64(v) / 64 / fc.upem
		}
	}
	fc.adv[r] = a
	return a
}

// textW is the width of s in mm at size pt.
func textW(st fontStyle, size float64, s string) float64 {
	fc := faces[st]
	fc.mu.Lock()
	defer fc.mu.Unlock()
	w := 0.0
	for _, r := range s {
		w += fc.advance(r)
	}
	return w * size * ptMM
}

// lineH is a line's height in mm: CSS line-height 1.28.
func lineH(size float64) float64 { return 1.28 * size * ptMM }

// baseline is where the text sits in a line box of its own size.
func baseline(size float64) float64 { return lineH(size)*0.5 + size*ptMM*0.35 }

// fitText cuts s with "…" so it fits in w.
func fitText(st fontStyle, size float64, s string, w float64) string {
	if textW(st, size, s) <= w {
		return s
	}
	r := []rune(s)
	for len(r) > 0 {
		r = r[:len(r)-1]
		t := strings.TrimRight(string(r), " ") + "…"
		if textW(st, size, t) <= w {
			return t
		}
	}
	return ""
}

// wrapText breaks s into lines no wider than w (a word too long is broken).
func wrapText(st fontStyle, size float64, s string, w float64) []string {
	if s == "" {
		return []string{""}
	}
	var lines []string
	line := ""
	for _, word := range strings.Fields(s) {
		try := word
		if line != "" {
			try = line + " " + word
		}
		if textW(st, size, try) <= w {
			line = try
			continue
		}
		if line != "" {
			lines = append(lines, line)
		}
		for textW(st, size, word) > w && utf8.RuneCountInString(word) > 1 {
			r := []rune(word)
			n := len(r) - 1
			for n > 1 && textW(st, size, string(r[:n])) > w {
				n--
			}
			lines = append(lines, string(r[:n]))
			word = string(r[n:])
		}
		line = word
	}
	return append(lines, line)
}

// ── the drawing steps ────────────────────────────────────────────────────

type opKind uint8

const (
	opText opKind = iota
	opRect
	opImage
)

// Op is one drawing step. Text: X, Y is the start of its baseline. Rect: a
// filled box (rules are thin boxes). Image: a logo by name.
type Op struct {
	K     opKind
	X, Y  float64
	W, H  float64
	S     string
	St    fontStyle
	Size  float64
	C     rgb
	Alpha float64 // images: 0 is opaque
}

type Page struct {
	W, H float64
	Ops  []Op
}

type logo struct {
	data []byte
	w, h int
}

var logos = func() map[string]logo {
	out := map[string]logo{}
	for name, b := range map[string][]byte{"samad": logoSamad, "ogc": logoOGC} {
		cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			panic(err)
		}
		out[name] = logo{b, cfg.Width, cfg.Height}
	}
	return out
}()

// ── layout ───────────────────────────────────────────────────────────────

const (
	sBody  = 8.6
	sSmall = 7.6
	sFoot  = 7.0
	sKPI   = 9.4
	sTitle = 15.0
	sNext  = 10.0
	sRef   = 8.0
	sHead  = 7.6 // table header
	sDense = 7.0 // a dense table's cells, for a wide sheet
	side   = 13.0
	padY   = 0.6 // table cell padding
	padX   = 1.4
	indent = 5.0
)

type layout struct {
	doc   *ReportDoc
	W, H  float64
	inner float64
	pages []*Page
	pg    *Page
	y     float64
	top   float64 // where the body starts on this page
	foot  float64 // where the footer starts
}

func (l *layout) text(x, y float64, s string, st fontStyle, size float64, c rgb) {
	if s == "" {
		return
	}
	l.pg.Ops = append(l.pg.Ops, Op{K: opText, X: x, Y: y, S: s, St: st, Size: size, C: c})
}

func (l *layout) rect(x, y, w, h float64, c rgb) {
	l.pg.Ops = append(l.pg.Ops, Op{K: opRect, X: x, Y: y, W: w, H: h, C: c})
}

func (l *layout) hrule(x, y, w, ptWidth float64, c rgb) { l.rect(x, y, w, ptWidth*ptMM, c) }

// box draws a rectangle's outline.
func (l *layout) box(x, y, w, h, ptWidth float64, c rgb) {
	t := ptWidth * ptMM
	l.rect(x, y, w, t, c)
	l.rect(x, y+h-t, w, t, c)
	l.rect(x, y, t, h, c)
	l.rect(x+w-t, y, t, h, c)
}

func (l *layout) newPage() {
	l.pg = &Page{W: l.W, H: l.H}
	l.pages = append(l.pages, l.pg)
	l.foot = l.H - (2 + lineH(sFoot) + 4)
	if len(l.pages) == 1 {
		l.firstHeader()
	} else {
		l.nextHeader()
	}
	l.top = l.y
}

func (l *layout) firstHeader() {
	d := l.doc
	l.rect(0, 0, l.W, 21, cBand)
	if lg := logos["samad"]; lg.h > 0 {
		h := 15.5
		l.pg.Ops = append(l.pg.Ops, Op{K: opImage, X: 12, Y: (21 - h) / 2, W: h * float64(lg.w) / float64(lg.h), H: h, S: "samad"})
	}
	if lg := logos["ogc"]; lg.h > 0 {
		h := 9.5
		w := h * float64(lg.w) / float64(lg.h)
		l.pg.Ops = append(l.pg.Ops, Op{K: opImage, X: l.W - 12 - w, Y: (21 - h) / 2, W: w, H: h, S: "ogc", Alpha: 0.78})
	}
	y := 21 + 5.0
	base := y + baseline(sTitle)
	// The number and date on the right, "Report no. X · Date Y".
	parts := []struct {
		s  string
		st fontStyle
		c  rgb
	}{{"Report no. ", fRegular, cMut}, {d.ReportNo, fBold, cInk}, {"  ·  Date ", fRegular, cMut}, {d.Date, fBold, cInk}}
	refW := 0.0
	for _, p := range parts {
		refW += textW(p.st, sRef, p.s)
	}
	x := side + l.inner - refW
	for _, p := range parts {
		l.text(x, base, p.s, p.st, sRef, p.c)
		x += textW(p.st, sRef, p.s)
	}
	l.text(side, base, fitText(fBold, sTitle, strings.ToUpper(d.Title), l.inner-refW-4), fBold, sTitle, cInk)
	y += lineH(sTitle) + 1.2
	l.hrule(side, y, l.inner, 1.2, cInk)
	y += 1.2*ptMM + 2.2

	// The facts, two to a row: a grey label, then the value in bold.
	half := l.inner / 2
	for i := 0; i < len(d.Info); i += 2 {
		rowH := lineH(sBody) + 1.1
		for j := 0; j < 2 && i+j < len(d.Info); j++ {
			p := d.Info[i+j]
			x := side + float64(j)*half
			b := y + 0.55 + baseline(sBody)
			l.text(x, b, fitText(fRegular, sBody, p.Label, 22), fRegular, sBody, cMut)
			l.text(x+23, b, fitText(fBold, sBody, p.Value, half-26), fBold, sBody, cInk)
		}
		y += rowH
	}
	l.y = y + 5
}

func (l *layout) nextHeader() {
	d := l.doc
	y := 6.0
	b := y + baseline(sNext)
	right := d.Company + " · " + d.ReportNo
	rw := textW(fRegular, sSmall, right)
	l.text(side+l.inner-rw, b, right, fRegular, sSmall, cMut)
	l.text(side, b, fitText(fBold, sNext, strings.ToUpper(d.Title), l.inner-rw-4), fBold, sNext, cInk)
	y += lineH(sNext) + 1.2
	l.hrule(side, y, l.inner, 1.2, cInk)
	l.y = y + 1.2*ptMM + 5
}

func (l *layout) footers() {
	n := len(l.pages)
	for i, p := range l.pages {
		l.pg = p
		y := l.foot
		l.hrule(0, y, l.W, 0.6, cRule)
		b := y + 2 + baseline(sFoot)
		pn := "Page " + itoa(i+1) + " of " + itoa(n)
		pw := textW(fRegular, sFoot, pn)
		l.text(l.W-side-pw, b, pn, fRegular, sFoot, cMut)
		l.text(side, b, fitText(fRegular, sFoot, l.doc.FootNote, l.inner-pw-6), fRegular, sFoot, cMut)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// fits: is there room for h more before the footer? At the top of a page
// there always is (a block taller than a page is drawn and cut).
func (l *layout) fits(h float64) bool { return l.y+h <= l.foot-1 || l.y <= l.top+0.01 }

func (l *layout) ensure(h float64) {
	if !l.fits(h) {
		l.newPage()
	}
}

// ── blocks ───────────────────────────────────────────────────────────────

const headingH = 3.2 + 0.6 + 1.4 // margins and the gap above the rule, plus the line

func (l *layout) headingHeight() float64 { return headingH + lineH(sBody) + 0.6*ptMM }

func (l *layout) heading(b Block) {
	y := l.y + 3.2
	base := y + baseline(sBody)
	sw := 0.0
	if b.Small != "" {
		sw = textW(fRegular, sSmall, b.Small)
		l.text(side+l.inner-sw, base, b.Small, fRegular, sSmall, cMut)
	}
	l.text(side, base, fitText(fBold, sBody, strings.ToUpper(b.Text), l.inner-sw-3), fBold, sBody, cInk)
	y += lineH(sBody) + 0.6
	l.hrule(side, y, l.inner, 0.6, cRule)
	l.y = y + 0.6*ptMM + 1.4
}

func (l *layout) kpiLayout(b Block) (w float64, labels [][]string, h float64) {
	n := len(b.KPIs)
	if n == 0 {
		return 0, nil, 0
	}
	w = l.inner / float64(n)
	most := 1
	for _, k := range b.KPIs {
		ls := wrapText(fRegular, sFoot, k.Label, w-3.2)
		labels = append(labels, ls)
		if len(ls) > most {
			most = len(ls)
		}
	}
	return w, labels, 1 + float64(most)*lineH(sFoot) + lineH(sKPI) + 1.1
}

// kpis: a row of boxes, each a small grey label over its figure in bold.
func (l *layout) kpis(b Block) {
	w, labels, h := l.kpiLayout(b)
	most := 0
	for _, ls := range labels {
		most = max(most, len(ls))
	}
	for i, k := range b.KPIs {
		x := side + float64(i)*w
		l.box(x, l.y, w, h, 0.6, cRule)
		for j, line := range labels[i] {
			l.text(x+1.6, l.y+1+float64(j)*lineH(sFoot)+baseline(sFoot), line, fRegular, sFoot, cMut)
		}
		l.text(x+1.6, l.y+1+float64(most)*lineH(sFoot)+baseline(sKPI), fitText(fBold, sKPI, k.Value, w-3.2), fBold, sKPI, cInk)
	}
	l.y += h
}

// ── a strip of counts ────────────────────────────────────────────────────

func countsH() float64 { return 2*padY + lineH(sSmall) + 0.6*ptMM + lineH(sKPI) + lineH(sSmall) + 1 }

// counts: one column per figure, centred: the label, a rule, the figure in
// bold and a grey line under it ("2 units").
func (l *layout) counts(b Block) {
	n := len(b.KPIs)
	if n == 0 {
		return
	}
	w := l.inner / float64(n)
	y := l.y
	centred := func(i int, s string, st fontStyle, size, at float64, c rgb) {
		s = fitText(st, size, s, w-2)
		l.text(side+float64(i)*w+(w-textW(st, size, s))/2, at, s, st, size, c)
	}
	for i, k := range b.KPIs {
		centred(i, k.Label, fRegular, sSmall, y+padY+baseline(sSmall), cMut)
	}
	y += 2*padY + lineH(sSmall)
	l.hrule(side, y, l.inner, 0.6, cRule)
	y += 0.6 * ptMM
	for i, k := range b.KPIs {
		centred(i, k.Value, fBold, sKPI, y+baseline(sKPI), cInk)
		centred(i, k.Sub, fRegular, sSmall, y+lineH(sKPI)+baseline(sSmall), cMut)
	}
	y += lineH(sKPI) + lineH(sSmall) + 1
	l.hrule(side, y-0.6*ptMM, l.inner, 0.6, cRule)
	l.y = y
}

// ── small tables, two side by side ───────────────────────────────────────

const groupGap = 10.0

func (l *layout) groupW() float64 { return (l.inner - groupGap) / 2 }

func (l *layout) groupTable(g SubTable, x float64) *tableLayout {
	if len(g.Cols) == 0 || len(g.Rows) == 0 {
		return nil
	}
	return l.tableLayoutAt(Block{Cols: g.Cols, Rows: g.Rows}, x, l.groupW())
}

func groupTitleH() float64 { return lineH(sBody) + 0.8 }

func (l *layout) groupH(g SubTable) float64 {
	h := groupTitleH() + 3.4 // the title, and room under the group
	if t := l.groupTable(g, side); t != nil {
		h += t.headH
		for _, r := range t.rowH {
			h += r
		}
		return h
	}
	return h + 1 + lineH(sBody)
}

// pairH is the height of the pair of groups starting at i.
func (l *layout) pairH(gs []SubTable, i int) float64 {
	h := l.groupH(gs[i])
	if i+1 < len(gs) {
		h = max(h, l.groupH(gs[i+1]))
	}
	return h
}

func (l *layout) group(g SubTable, x float64) {
	w := l.groupW()
	y := l.y
	sw := 0.0
	if g.Small != "" {
		sw = textW(fRegular, sSmall, g.Small)
		l.text(x+w-sw, y+baseline(sBody), g.Small, fRegular, sSmall, cMut)
	}
	l.text(x, y+baseline(sBody), fitText(fBold, sBody, g.Text, w-sw-3), fBold, sBody, cInk)
	y += groupTitleH()
	t := l.groupTable(g, x)
	if t == nil {
		empty := g.Empty
		if empty == "" {
			empty = "None."
		}
		l.text(x, y+0.5+baseline(sBody), fitText(fItalic, sBody, empty, w), fItalic, sBody, cMut)
		return
	}
	keep := l.y
	l.y = y
	l.tableHead(t)
	for r := range t.rows {
		l.tableRow(t, r)
	}
	l.hrule(t.x0, l.y-0.6*ptMM, t.wid, 0.6, cRule)
	l.y = keep
}

func (l *layout) groups(b Block) {
	for i := 0; i < len(b.Groups); i += 2 {
		h := l.pairH(b.Groups, i)
		l.ensure(h)
		l.group(b.Groups[i], side)
		if i+1 < len(b.Groups) {
			l.group(b.Groups[i+1], side+l.groupW()+groupGap)
		}
		l.y += h
	}
}

// ── bars ─────────────────────────────────────────────────────────────────

// leadingNumber reads "1,204 km" as 1204; nothing readable is 0.
func leadingNumber(s string) float64 {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		if r == ',' {
			continue
		}
		if (r >= '0' && r <= '9') || r == '.' {
			b.WriteRune(r)
			continue
		}
		if b.Len() > 0 {
			break
		}
	}
	f, err := strconv.ParseFloat(b.String(), 64)
	if err != nil || f < 0 {
		return 0
	}
	return f
}

func barH() float64 { return lineH(sBody) + 1.6 }

// bars: a horizontal bar per figure, longest for the largest, the label on
// the left and the figure (and its Sub) after the bar.
func (l *layout) bars(b Block) {
	labelW := 0.0
	most := 0.0
	for _, k := range b.KPIs {
		labelW = max(labelW, textW(fRegular, sBody, k.Label))
		most = max(most, leadingNumber(k.Value))
	}
	labelW = min(labelW+3, l.inner*0.3)
	room := l.inner - labelW - 60
	for _, k := range b.KPIs {
		l.ensure(barH())
		y := l.y
		base := y + 0.8 + baseline(sBody)
		l.text(side, base, fitText(fRegular, sBody, k.Label, labelW-3), fRegular, sBody, cInk)
		w := 0.0
		if most > 0 {
			w = room * leadingNumber(k.Value) / most
		}
		x := side + labelW
		if w > 0 {
			l.rect(x, y+0.8+lineH(sBody)*0.15, w, lineH(sBody)*0.7, cBar)
		}
		x += w + 1.6
		l.text(x, base, k.Value, fBold, sBody, cInk)
		if k.Sub != "" {
			x += textW(fBold, sBody, k.Value) + 2
			l.text(x, base, fitText(fRegular, sSmall, k.Sub, side+l.inner-x), fRegular, sSmall, cMut)
		}
		l.y += barH()
	}
}

// ── lines to write on, and signatures ────────────────────────────────────

const lineGap = 8.0

// linesH is the room the lines need, with the signatures that follow them:
// the handover is kept on one page.
func linesH(blocks []Block, i int) float64 {
	h := float64(blocks[i].N)*lineGap + 1
	if i+1 < len(blocks) && blocks[i+1].Type == "sign" {
		h += signH()
	}
	return h
}

func (l *layout) lines(b Block) {
	for i := 0; i < b.N; i++ {
		l.y += lineGap
		l.hrule(side, l.y, l.inner, 0.5, cRule)
	}
	l.y++
}

func signH() float64 { return 16 + 1.2 + lineH(sSmall) + 2 }

func (l *layout) sign(b Block) {
	n := len(b.KPIs)
	if n == 0 {
		return
	}
	l.ensure(signH())
	w := (l.inner - groupGap*float64(n-1)) / float64(n)
	for i, k := range b.KPIs {
		x := side + float64(i)*(w+groupGap)
		l.hrule(x, l.y+16, w, 0.8, cInk)
		l.text(x, l.y+16+1.2+baseline(sSmall), fitText(fRegular, sSmall, k.Label, w), fRegular, sSmall, cMut)
	}
	l.y += signH()
}

func (l *layout) note(b Block) {
	lines := wrapText(fRegular, sFoot, b.Text, l.inner)
	l.ensure(0.8 + float64(len(lines))*lineH(sFoot))
	l.y += 0.8
	for _, line := range lines {
		l.text(side, l.y+baseline(sFoot), line, fRegular, sFoot, cMut)
		l.y += lineH(sFoot)
	}
}

func (l *layout) empty(b Block) {
	h := 2 + lineH(sBody)
	l.ensure(h)
	l.text(side, l.y+1+baseline(sBody), fitText(fItalic, sBody, b.Text, l.inner), fItalic, sBody, cMut)
	l.y += h
}

// ── tables ───────────────────────────────────────────────────────────────

type tableLayout struct {
	x0, wid float64   // where the table sits
	x, w    []float64 // each column's left edge and width
	head    [][]string
	headSz  []float64 // a header's size: smaller when a word would not fit
	headH   float64
	rows    [][][]string // per row, per cell: its lines
	rowH    []float64
	b       Block
	padLeft []float64
	body    float64 // the cells' size: sBody, or sDense for a dense table
}

func (l *layout) tableLayout(b Block) *tableLayout { return l.tableLayoutAt(b, side, l.inner) }

func (l *layout) tableLayoutAt(b Block, x0, width float64) *tableLayout {
	t := &tableLayout{b: b, x0: x0, wid: width, body: sBody}
	if b.Dense {
		t.body = sDense
	}
	sum := 0.0
	for _, c := range b.Cols {
		sum += c.W
	}
	x := x0
	for i, c := range b.Cols {
		w := c.W / sum * width
		t.x, t.w = append(t.x, x), append(t.w, w)
		pl := padX
		if i == 0 {
			pl = 0
		}
		t.padLeft = append(t.padLeft, pl)
		x += w
	}
	most := 1
	for i, c := range b.Cols {
		room := t.w[i] - t.padLeft[i] - padX
		// A header word is never split ("Overspeedi-ng"): the header shrinks
		// to fit its longest word, down to 5.6 pt, and wraps between words.
		size := min(sHead, t.body)
		for _, word := range strings.Fields(c.H) {
			for size > 5.6 && textW(fBold, size, word) > room {
				size -= 0.2
			}
		}
		ls := wrapText(fBold, size, c.H, room)
		t.head = append(t.head, ls)
		t.headSz = append(t.headSz, size)
		if len(ls) > most {
			most = len(ls)
		}
	}
	t.headH = 2*padY + float64(most)*lineH(sHead) + 0.6*ptMM
	for _, row := range b.Rows {
		cells := make([][]string, len(b.Cols))
		lines := 1
		for i, c := range row {
			room := t.w[i] - t.padLeft[i] - padX
			if c.Indent {
				room -= indent
			}
			st := cellStyle(c)
			if c.Wrap {
				cells[i] = wrapText(st, t.body, c.Text, room)
			} else {
				cells[i] = []string{fitText(st, t.body, c.Text, room)}
			}
			if len(cells[i]) > lines {
				lines = len(cells[i])
			}
		}
		t.rows = append(t.rows, cells)
		t.rowH = append(t.rowH, 2*padY+float64(lines)*lineH(t.body))
	}
	return t
}

func cellStyle(c Cell) fontStyle {
	if c.Bold {
		return fBold
	}
	return fRegular
}

func (l *layout) tableHead(t *tableLayout) {
	for i, c := range t.b.Cols {
		sz := t.headSz[i]
		for j, line := range t.head[i] {
			x := t.x[i] + t.padLeft[i]
			if c.Right {
				x = t.x[i] + t.w[i] - padX - textW(fBold, sz, line)
			}
			l.text(x, l.y+padY+float64(j)*lineH(sHead)+baseline(sHead), line, fBold, sz, cMut)
		}
	}
	l.y += t.headH
	l.hrule(t.x0, l.y-0.6*ptMM, t.wid, 0.6, cRule)
}

// tableRow draws row r at the current line and moves under it.
func (l *layout) tableRow(t *tableLayout, r int) {
	b := t.b
	for i, lines := range t.rows[r] {
		c := b.Rows[r][i]
		st, col := cellStyle(c), cInk
		if c.Muted {
			col = cMut
		}
		for j, line := range lines {
			x := t.x[i] + t.padLeft[i]
			if c.Indent {
				x += indent
			}
			if b.Cols[i].Right {
				x = t.x[i] + t.w[i] - padX - textW(st, t.body, line)
			}
			l.text(x, l.y+padY+float64(j)*lineH(t.body)+baseline(t.body), line, st, t.body, col)
		}
	}
	l.y += t.rowH[r]
	l.hrule(t.x0, l.y-0.4*ptMM, t.wid, 0.4, cSoft)
}

func (l *layout) table(b Block) {
	t := l.tableLayout(b)
	first := t.headH
	if len(t.rowH) > 0 {
		first += t.rowH[0]
	}
	l.ensure(first)
	l.tableHead(t)
	last := -1.0 // the bottom of the last row drawn on this page
	for r := range t.rows {
		if !l.fits(t.rowH[r]) {
			if last >= 0 {
				l.hrule(side, last-0.6*ptMM, l.inner, 0.6, cRule)
			}
			l.newPage()
			l.tableHead(t)
		}
		l.tableRow(t, r)
		last = l.y
	}
	if last >= 0 {
		l.hrule(side, last-0.6*ptMM, l.inner, 0.6, cRule)
	}
}

// firstPartH is how much room the start of blocks[i] needs: a heading is
// kept with it.
func (l *layout) firstPartH(blocks []Block, i int) float64 {
	b := blocks[i]
	switch b.Type {
	case "kpis":
		_, _, h := l.kpiLayout(b)
		return h
	case "table":
		t := l.tableLayout(Block{Cols: b.Cols, Rows: b.Rows[:min(1, len(b.Rows))]})
		h := t.headH
		if len(t.rowH) > 0 {
			h += t.rowH[0]
		}
		return h
	case "note":
		return 0.8 + lineH(sFoot)
	case "empty":
		return 2 + lineH(sBody)
	case "counts":
		return countsH()
	case "groups":
		if len(b.Groups) > 0 {
			return l.pairH(b.Groups, 0)
		}
	case "bars":
		return barH()
	case "lines":
		return linesH(blocks, i)
	case "sign":
		return signH()
	}
	return 0
}

// layOut draws the document onto pages.
func layOut(d *ReportDoc) []*Page {
	l := &layout{doc: d, W: 210, H: 297}
	if d.Paper == "A3" {
		l.W, l.H = 297, 420
	}
	if d.Orientation == "landscape" {
		l.W, l.H = l.H, l.W
	}
	l.inner = l.W - 2*side
	l.newPage()
	for i, b := range d.Blocks {
		switch b.Type {
		case "heading":
			next := 0.0
			if i+1 < len(d.Blocks) {
				next = l.firstPartH(d.Blocks, i+1)
			}
			l.ensure(l.headingHeight() + next)
			l.heading(b)
		case "kpis":
			_, _, h := l.kpiLayout(b)
			l.ensure(h)
			l.kpis(b)
		case "table":
			l.table(b)
		case "note":
			l.note(b)
		case "empty":
			l.empty(b)
		case "spacer":
			if l.y > l.top+0.01 {
				l.y += 1.6
			}
		case "counts":
			l.ensure(countsH())
			l.counts(b)
		case "groups":
			l.groups(b)
		case "bars":
			l.bars(b)
		case "lines":
			l.ensure(linesH(d.Blocks, i))
			l.lines(b)
		case "sign":
			l.sign(b)
		}
	}
	l.footers()
	return l.pages
}
