package main

// A laid-out report (report_layout.go) drawn as pictures: the JPEG download
// (the pages one under another, for a WhatsApp group, as the dashboard made
// it) and the preview pages the Reports page shows. Pure Go: the image has no
// browser to draw with.

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"math"
	"sync"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

const (
	jpegDPI     = 180
	previewDPI  = 110
	sheetGap    = 24     // px of grey between pages, so each reads as a sheet
	sheetMaxH   = 10_000 // px: a taller report is cut into several images
	jpegQuality = 92
)

var sheetGrey = color.RGBA{0xd9, 0xdc, 0xe1, 0xff}

var decodedLogos = sync.OnceValue(func() map[string]image.Image {
	out := map[string]image.Image{}
	for name, lg := range logos {
		img, _, err := image.Decode(bytes.NewReader(lg.data))
		if err == nil {
			out[name] = img
		}
	}
	return out
})

type rasterizer struct {
	dpi   float64
	faces map[[2]float64]font.Face // style, size → face at this dpi
}

func (r *rasterizer) px(mm float64) float64 { return mm * r.dpi / 25.4 }

func (r *rasterizer) face(st fontStyle, size float64) font.Face {
	k := [2]float64{float64(st), size}
	if f, ok := r.faces[k]; ok {
		return f
	}
	f, err := opentype.NewFace(faces[st].f, &opentype.FaceOptions{Size: size, DPI: r.dpi, Hinting: font.HintingNone})
	if err != nil {
		return nil
	}
	r.faces[k] = f
	return f
}

func (r *rasterizer) close() {
	for _, f := range r.faces {
		f.Close()
	}
}

func rgba(c rgb) color.RGBA { return color.RGBA{c.R, c.G, c.B, 0xff} }

// pagePx is a page's size in pixels at this resolution.
func (r *rasterizer) pagePx(p *Page) (int, int) {
	return int(math.Round(r.px(p.W))), int(math.Round(r.px(p.H)))
}

// draw paints one page into dst with its top left corner at off.
func (r *rasterizer) draw(dst *image.RGBA, off image.Point, p *Page) {
	w, h := r.pagePx(p)
	draw.Draw(dst, image.Rect(0, 0, w, h).Add(off), image.White, image.Point{}, draw.Src)
	for _, op := range p.Ops {
		switch op.K {
		case opRect:
			x0, y0 := int(math.Round(r.px(op.X))), int(math.Round(r.px(op.Y)))
			x1, y1 := int(math.Round(r.px(op.X+op.W))), int(math.Round(r.px(op.Y+op.H)))
			if x1 <= x0 {
				x1 = x0 + 1 // a hairline still shows
			}
			if y1 <= y0 {
				y1 = y0 + 1
			}
			draw.Draw(dst, image.Rect(x0, y0, x1, y1).Add(off), image.NewUniform(rgba(op.C)), image.Point{}, draw.Over)
		case opText:
			f := r.face(op.St, op.Size)
			if f == nil {
				continue
			}
			d := font.Drawer{Dst: dst, Src: image.NewUniform(rgba(op.C)), Face: f,
				Dot: fixed.Point26_6{X: fixed.Int26_6((r.px(op.X) + float64(off.X)) * 64), Y: fixed.Int26_6((r.px(op.Y) + float64(off.Y)) * 64)}}
			d.DrawString(op.S)
		case opImage:
			src := decodedLogos()[op.S]
			if src == nil {
				continue
			}
			rect := image.Rect(int(math.Round(r.px(op.X))), int(math.Round(r.px(op.Y))),
				int(math.Round(r.px(op.X+op.W))), int(math.Round(r.px(op.Y+op.H)))).Add(off)
			tmp := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
			xdraw.CatmullRom.Scale(tmp, tmp.Bounds(), src, src.Bounds(), draw.Src, nil)
			var mask image.Image
			if op.Alpha > 0 {
				mask = image.NewUniform(color.Alpha{uint8(op.Alpha * 255)})
			}
			draw.DrawMask(dst, rect, tmp, image.Point{}, mask, image.Point{}, draw.Over)
		}
	}
}

// sheets groups the pages into runs that each fit on one image.
func sheets(pageH, n int) [][2]int {
	per := max(1, (sheetMaxH+sheetGap)/(pageH+sheetGap))
	var out [][2]int
	for i := 0; i < n; i += per {
		out = append(out, [2]int{i, min(n, i+per)})
	}
	return out
}

// renderJPEG draws sheet `which` (0-based) of the report; it also says how
// many sheets there are.
func renderJPEG(pages []*Page, which int) ([]byte, int, error) {
	r := &rasterizer{dpi: jpegDPI, faces: map[[2]float64]font.Face{}}
	defer r.close()
	w, h := r.pagePx(pages[0])
	runs := sheets(h, len(pages))
	if which < 0 || which >= len(runs) {
		which = 0
	}
	run := runs[which]
	n := run[1] - run[0]
	img := image.NewRGBA(image.Rect(0, 0, w, n*h+(n-1)*sheetGap))
	draw.Draw(img, img.Bounds(), image.NewUniform(sheetGrey), image.Point{}, draw.Src)
	for i := run[0]; i < run[1]; i++ {
		r.draw(img, image.Point{0, (i - run[0]) * (h + sheetGap)}, pages[i])
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, 0, err
	}
	return buf.Bytes(), len(runs), nil
}

// renderPreview draws each page small, as JPEGs for the Reports page.
func renderPreview(pages []*Page) ([][]byte, error) {
	r := &rasterizer{dpi: previewDPI, faces: map[[2]float64]font.Face{}}
	defer r.close()
	out := make([][]byte, 0, len(pages))
	for _, p := range pages {
		w, h := r.pagePx(p)
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		r.draw(img, image.Point{}, p)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
			return nil, err
		}
		out = append(out, buf.Bytes())
	}
	return out, nil
}
