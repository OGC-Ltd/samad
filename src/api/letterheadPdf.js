// A letterhead report (lib/letterhead) into a PDF (ported from RaiTrack): the page is laid out in an
// off-screen frame, the flow is dealt onto A4 pages (layOutLetterhead), and each
// page is drawn into the PDF as one image. The same route the End of shift report
// took, so the two come out looking alike. The JPEG takes the same pages,
// drawn sharper and straight to the image (api/pdfJpeg).

import samadLogo from '../assets/samad-logo-letterhead.png';
import ogcLogo from '../assets/ogc-monitoring-logo.png';
import { layOutLetterhead } from '../lib/letterhead';

/** The logos as absolute URLs: the frame's document has no base of its own. */
export const letterheadLogos = () => ({
  left: new URL(samadLogo, window.location.href).href,
  leftAlt: 'Samad Resources',
  ogc: new URL(ogcLogo, window.location.href).href,
});

/** Hands a file to the browser to save. */
function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── the JPEG (RaiTrack api/pdfJpeg): the pages one under another, for a WhatsApp group ──
const GAP = 24;           // grey between the pages, so each reads as a sheet
const MAX_HEIGHT = 16_000;
// High enough that the browser keeps the colour detail of small text
const QUALITY = 0.95;

function toBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('The image could not be made.'))), 'image/jpeg', QUALITY));
}

/** The pages cut into runs that each fit on one image. */
function sheets(pages) {
  const out = [];
  let run = [];
  let height = 0;
  for (const p of pages) {
    const add = (run.length ? GAP : 0) + p.height;
    if (run.length && height + add > MAX_HEIGHT) { out.push(run); run = []; height = 0; }
    height += run.length ? GAP + p.height : p.height;
    run.push(p);
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * Drawn pages (canvases) saved as JPEG: one image, or several past MAX_HEIGHT.
 * @param {HTMLCanvasElement[]} pages
 * @param {string} filename the report's name; the image takes it with .jpg
 */
async function savePagesAsJpeg(pages, filename) {
  const runs = sheets(pages);
  const base = String(filename ?? 'Report.pdf').replace(/\.pdf$/i, '');
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const out = document.createElement('canvas');
    out.width = Math.max(...run.map((p) => p.width));
    out.height = run.reduce((h, p) => h + p.height, 0) + GAP * (run.length - 1);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#d9dce1';
    ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const p of run) {
      // Whole pixels, never scaled: drawn as they were made
      ctx.drawImage(p, Math.floor((out.width - p.width) / 2), y);
      y += p.height + GAP;
    }
    const name = runs.length === 1 ? `${base}.jpg` : `${base} (${i + 1} of ${runs.length}).jpg`;
    saveFile(await toBlob(out), name);
  }
}


const PDF_SCALE = 2.2;
// The JPEG is looked at zoomed in, on a phone: an A4 page 2382 px wide (~290 dpi)
const JPEG_SCALE = 3;

/**
 * The report's A4 pages drawn to canvases, laid out in an off-screen frame.
 * @returns {Promise<HTMLCanvasElement[]>}
 */
async function drawPages(html, { landscape, scale, onProgress }) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${landscape ? 1300 : 900}px;height:${landscape ? 900 : 1300}px;border:0;`;
  try {
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = () => reject(new Error('The report page could not be laid out.'));
      frame.srcdoc = html;
      document.body.appendChild(frame);
    });
    const doc = frame.contentDocument;
    await Promise.all([...doc.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
    await doc.fonts?.ready;
    // Split into A4 pages from here: the CSP stops a script inside the report.
    await layOutLetterhead(doc);
    const pages = [...doc.querySelectorAll('.page')];
    const { default: html2canvas } = await import('html2canvas');
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      onProgress?.(`Drawing page ${i + 1} of ${pages.length}`);
      out.push(await html2canvas(pages[i], { scale, backgroundColor: '#ffffff', useCORS: true, logging: false }));
    }
    return out;
  } finally {
    frame.remove();
  }
}

/**
 * @param {string} html  from renderLetterheadHtml
 * @param {{ filename: string, landscape?: boolean, onProgress?: (words: string) => void, keep?: boolean }} o
 *   `keep` hands back `{ blob, filename }` instead of saving it, for a preview
 *   whose Download then saves that same file.
 */
export async function saveLetterheadPdf(html, { filename, landscape = false, onProgress, keep = false }) {
  const pages = await drawPages(html, { landscape, scale: PDF_SCALE, onProgress });
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait', compress: true });
  const [w, h] = landscape ? [297, 210] : [210, 297];
  pages.forEach((canvas, i) => {
    if (i > 0) pdf.addPage('a4', landscape ? 'landscape' : 'portrait');
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, w, h);
  });
  if (keep) return { blob: pdf.output('blob'), filename };
  pdf.save(filename);
  return null;
}

/** The same report as a JPEG: the pages drawn once, at JPEG_SCALE, never through the PDF. */
export async function saveLetterheadJpeg(html, { filename, landscape = false, onProgress }) {
  const pages = await drawPages(html, { landscape, scale: JPEG_SCALE, onProgress });
  await savePagesAsJpeg(pages, filename);
}
