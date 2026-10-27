// Shared PDF report builder used by the per-entity export buttons (single
// driver, single vehicle, depot/warehouse). Org-level section reports come
// from the server's template renderer instead (api/reports.js).
//
// Follows the same "Fleet Analytics Report" template visual system as the
// server renderer (server/src/modules/reports/report-pdf.renderer.ts): cream
// page with a deep-green + amber top strip, FLEET TRACKING eyebrow +
// CONFIDENTIAL chip, white KPI tiles (the last one deep green), hairline
// tables, and the confidential footer with a deep-green bottom strip.

import { jsPDF } from "jspdf";
import autoTableModule from "jspdf-autotable";

// Bundler/Node resolve this package's CJS default export differently;
// unwrap whichever shape arrived.
const autoTable = typeof autoTableModule === "function" ? autoTableModule : autoTableModule.default;

const C = {
  bg:        "#f7f4ee",
  card:      "#ffffff",
  border:    "#e9e3d8",
  ink:       "#1d1a16",
  sub:       "#7d766b",
  faint:     "#a9a294",
  green:     "#1e6f4e",
  greenDeep: "#173d2f",
  greenSoft: "#cfe0d6",
  amber:     "#d97706",
  chipInk:   "#8a6a3a",
  hairline:  "#f0ebe1",
};

const MARGIN   = 34;
const FOOTER_H = 54;

/** Cream page ground; the green/amber strip only tops the first page. */
function paintPage(doc, { first = false } = {}) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  doc.setFillColor(C.bg);
  doc.rect(0, 0, w, h, "F");
  if (first) {
    doc.setFillColor(C.greenDeep);
    doc.rect(0, 0, w * 0.74, 4, "F");
    doc.setFillColor(C.amber);
    doc.rect(w * 0.74, 0, w * 0.26, 4, "F");
  }
}

// `accentColor` is accepted for call-site compatibility but the template uses
// its own fixed palette, so it is deliberately unused.
export function createReport({ companyName, reportTitle, subtitle }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();

  paintPage(doc, { first: true });

  let y = 34;
  doc.setFillColor(C.green);
  doc.circle(MARGIN + 3, y - 2.5, 2.6, "F");
  doc.setTextColor(C.green);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setCharSpace(2);
  doc.text("FLEET TRACKING", MARGIN + 11, y);
  doc.setCharSpace(0);

  // CONFIDENTIAL chip, top right
  const chipW = 92;
  doc.setDrawColor(C.border);
  doc.roundedRect(pageW - MARGIN - chipW, y - 12, chipW, 17, 3, 3, "S");
  doc.setTextColor(C.chipInk);
  doc.setFontSize(6.5);
  doc.setCharSpace(1.5);
  doc.text("CONFIDENTIAL", pageW - MARGIN - chipW / 2, y - 1, { align: "center" });
  doc.setCharSpace(0);

  y += 24;
  doc.setTextColor(C.ink);
  doc.setFontSize(21);
  doc.text(reportTitle, MARGIN, y);

  // Org block, right-aligned
  doc.setFontSize(11);
  doc.text((companyName || "Fleet").toUpperCase(), pageW - MARGIN, y - 2, { align: "right" });

  y += 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(C.sub);
  const dateStr = new Date().toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
  const metaLine = [companyName, subtitle, `Generated ${dateStr}`].filter(Boolean).join("  ·  ");
  doc.text(metaLine, MARGIN, y);

  doc._cursorY = y + 26;
  return doc;
}

export function addSectionTitle(doc, title) {
  doc.setTextColor(C.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(title, MARGIN, doc._cursorY);
  doc._cursorY += 12;
}

export function addSummaryCards(doc, cards) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const usableWidth = pageWidth - MARGIN * 2;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 58;
  const y = doc._cursorY;

  cards.forEach((card, i) => {
    const x = MARGIN + i * (cardWidth + gap);
    const dark = i === cards.length - 1;   // the template's highlighted deep-green tile

    doc.setFillColor(dark ? C.greenDeep : C.card);
    doc.setDrawColor(C.border);
    doc.roundedRect(x, y, cardWidth, cardHeight, 6, 6, dark ? "F" : "FD");

    doc.setTextColor(dark ? C.greenSoft : C.faint);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setCharSpace(1);
    doc.text(String(card.label).toUpperCase(), x + 13, y + 17, { maxWidth: cardWidth - 26 });
    doc.setCharSpace(0);

    doc.setTextColor(dark ? "#ffffff" : C.ink);
    doc.setFontSize(15);
    doc.text(String(card.value), x + 13, y + 39);
  });

  doc._cursorY = y + cardHeight + 24;
}

// `accentColor` accepted for call-site compatibility; the template's tables
// use faint uppercase heads and hairline row rules instead of colored fills.
export function addTable(doc, { head, body }) {
  const pageW = doc.internal.pageSize.getWidth();
  autoTable(doc, {
    startY: doc._cursorY,
    head: [head.map((h) => String(h).toUpperCase())],
    body,
    theme: "plain",
    styles: { font: "helvetica", fontSize: 8.5, textColor: C.ink, cellPadding: { top: 6, bottom: 6, left: 6, right: 6 } },
    headStyles: { fillColor: false, textColor: C.faint, fontStyle: "bold", fontSize: 6.8 },
    margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: FOOTER_H },
    // Pages the table itself adds still need the cream ground.
    willDrawPage: (data) => { if (data.pageNumber > 1) paintPage(doc); },
    // Hairline under every body row, template-style.
    didDrawCell: (data) => {
      if (data.section !== "body" || data.column.index !== 0) return;
      doc.setDrawColor(C.hairline);
      doc.setLineWidth(0.5);
      doc.line(MARGIN, data.cell.y, pageW - MARGIN, data.cell.y);
    },
  });
  doc._cursorY = doc.lastAutoTable.finalY + 22;
}

export function downloadReport(doc, filename) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(C.border);
    doc.setLineWidth(1);
    doc.line(MARGIN, pageHeight - 38, pageWidth - MARGIN, pageHeight - 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(C.faint);
    doc.setCharSpace(1);
    doc.text("FLEET TRACKING: CONFIDENTIAL", MARGIN, pageHeight - 24);
    doc.setCharSpace(0);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - MARGIN, pageHeight - 24, { align: "right" });
    doc.setFillColor(C.greenDeep);
    doc.rect(0, pageHeight - 4, pageWidth, 4, "F");
  }

  doc.save(filename);
}
