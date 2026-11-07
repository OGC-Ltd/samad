package main

// A laid-out report (report_layout.go) as a PDF: real text (selectable,
// searchable, sharp at any zoom), the Go fonts embedded, the logos as images.

import (
	"bytes"
	"time"

	"github.com/go-pdf/fpdf"
)

var pdfFonts = [3]struct{ family, style string }{{"go", ""}, {"go", "B"}, {"go", "I"}}

func renderPDF(d *ReportDoc, pages []*Page, now time.Time) ([]byte, error) {
	orient := "P"
	if d.Orientation == "landscape" {
		orient = "L"
	}
	pdf := fpdf.NewCustom(&fpdf.InitType{OrientationStr: orient, UnitStr: "mm", SizeStr: "A4"})
	pdf.SetMargins(0, 0, 0)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCompression(true)
	pdf.SetTitle(d.Title+" "+d.Company+" "+d.Date, true)
	pdf.SetAuthor(d.Company, true)
	pdf.SetCreator("Samad Resources fleet dashboard", true)
	pdf.SetCreationDate(now)
	pdf.SetModificationDate(now)
	pdf.AddUTF8FontFromBytes("go", "", faces[fRegular].ttf)
	pdf.AddUTF8FontFromBytes("go", "B", faces[fBold].ttf)
	pdf.AddUTF8FontFromBytes("go", "I", faces[fItalic].ttf)
	for name, lg := range logos {
		pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(lg.data))
	}
	for _, p := range pages {
		pdf.AddPage()
		for _, op := range p.Ops {
			switch op.K {
			case opRect:
				pdf.SetFillColor(int(op.C.R), int(op.C.G), int(op.C.B))
				pdf.Rect(op.X, op.Y, op.W, op.H, "F")
			case opText:
				f := pdfFonts[op.St]
				pdf.SetFont(f.family, f.style, op.Size)
				pdf.SetTextColor(int(op.C.R), int(op.C.G), int(op.C.B))
				pdf.Text(op.X, op.Y, op.S)
			case opImage:
				if op.Alpha > 0 {
					pdf.SetAlpha(op.Alpha, "Normal")
				}
				pdf.ImageOptions(op.S, op.X, op.Y, op.W, op.H, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
				if op.Alpha > 0 {
					pdf.SetAlpha(1, "Normal")
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
