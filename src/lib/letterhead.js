// The report letterhead, as RaiTrack's reports have it (operator, 2026-11-03:
// "the same for Samad, but the left logo should be for Samad"). A dark band
// with Samad Resources' logo on the left and OGC Monitoring's on the right, the
// title and report number under a rule, a facts table, then the report as one
// flow of headings and tables. Black, white and greys only.
//
// The flow is dealt onto A4 pages by a small script inside the page: a block
// that does not fit moves to the next page, a long table is split between rows
// with its header repeated, and a heading is never left alone at a page foot.
// api/letterheadPdf then draws each page into the PDF.
//
// Pure: returns an HTML string.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * A list table. `cols` = [{ h, w, r? }] (w in mm or %, r = right-aligned);
 * each row an array of cell HTML, already escaped.
 */
export function table(cols, rows) {
  const cg = cols.map((c) => `<col style="width:${c.w}">`).join('');
  const th = cols.map((c) => `<th class="${c.r ? 'r' : ''}">${c.h}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((v, i) => {
    const cell = typeof v === 'object' && v ? v : { html: v };
    return `<td class="${cols[i]?.r ? 'r ' : ''}${cell.cls ?? ''}"${cell.style ? ` style="${cell.style}"` : ''}>${cell.html ?? ''}</td>`;
  }).join('')}</tr>`).join('');
  return `<table class="lst"><colgroup>${cg}</colgroup><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** The boxed figures row: [[label, value html], …]. */
export const cells = (list) => `<table class="cells"><tr>${list.map(([k, v]) => `<td>${v}<span>${esc(k)}</span></td>`).join('')}</tr></table>`;

/** An outlined tag, for a note on a row ("Check sensor", "2 trackers"). */
export const tag = (text, strong = false) => `<span class="tag${strong ? ' s' : ''}">${esc(text)}</span>`;

const css = (landscape) => `
@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 0 }
:root { --bg:#fff; --ink:#1c1c1c; --mut:#5c5c5c; --rule:#bfbfbf; --soft:#e6e6e6; --shade:#f3f3f3; --band:#212121 }
* { box-sizing:border-box; margin:0; padding:0 }
html, body { background:var(--bg); color:var(--ink); font-family:Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size:8.6pt; line-height:1.28;
  -webkit-print-color-adjust:exact; print-color-adjust:exact }
@media screen { html { background:#8a8f96 } body { background:transparent; padding:24px 0 } .page { margin:0 auto 18px; box-shadow:0 2px 18px rgba(0,0,0,.35) } }
.page { width:${landscape ? '297mm' : '210mm'}; height:${landscape ? '210mm' : '297mm'}; display:flex; flex-direction:column; overflow:hidden; background:var(--bg); position:relative }
.lh { background:var(--band); height:21mm; display:flex; align-items:center; justify-content:space-between; padding:0 12mm; flex:none }
.lh .rai { height:15.5mm } .lh .ogc { height:9.5mm; opacity:.78 }
.lh2 { display:flex; justify-content:space-between; align-items:baseline; border-bottom:1.2pt solid var(--ink); margin:6mm 13mm 0; padding-bottom:1.2mm; flex:none }
.lh2 b { font-size:10pt; letter-spacing:.04em } .lh2 span { color:var(--mut); font-size:7.6pt }
.body { padding:5mm 13mm 0; flex:1; min-height:0; overflow:hidden }
.title { display:flex; justify-content:space-between; align-items:baseline; border-bottom:1.2pt solid var(--ink); padding-bottom:1.2mm }
.title h1 { font-size:15pt; font-weight:700; letter-spacing:.04em }
.title .ref { color:var(--mut); font-size:8pt } .title .ref b { color:var(--ink) }
table { width:100%; border-collapse:collapse }
.info { margin-top:2.2mm }
.info th { text-align:left; font-weight:400; color:var(--mut); width:23mm; padding:.55mm 0; vertical-align:top }
.info td { padding:.55mm 3mm .55mm 0; font-weight:700 }
h2 { font-size:8.6pt; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--ink);
  border-bottom:.6pt solid var(--rule); padding-bottom:.6mm; margin:3.2mm 0 1.4mm }
h2 small { float:right; text-transform:none; letter-spacing:0; font-weight:400; color:var(--mut); font-size:7.6pt }
.cells td { border:.6pt solid var(--rule); padding:1mm 1.6mm 1.1mm; font-weight:700; font-size:9.4pt; vertical-align:top }
.cells td span { display:block; font-weight:400; font-size:7pt; color:var(--mut) }
.lst { table-layout:fixed }
.lst th { text-align:left; font-weight:700; font-size:7.6pt; color:var(--mut); border-bottom:.6pt solid var(--rule); padding:.6mm 1.4mm; overflow:hidden; white-space:nowrap }
.lst td { padding:.6mm 1.4mm; border-bottom:.4pt solid var(--soft); vertical-align:top; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.lst tbody tr:last-child td { border-bottom:.6pt solid var(--rule) }
.lst .r { text-align:right } .lst td:first-child, .lst th:first-child { padding-left:0 }
.lst td.b { font-weight:700 } .lst td.m { color:var(--mut) } .lst td.wrap { white-space:normal }
.lst tr.sum td { font-weight:700; border-top:.6pt solid var(--ink) }
.lst.grid th, .lst.grid td { padding-left:.6mm; padding-right:.6mm }
.lst.grid th.r { font-size:6.6pt }
.lst.grid td.h { background:rgba(0,0,0,var(--a,0)) } .lst.grid td.h.dk { color:#fff }
.tag { display:inline-block; margin-left:1.2mm; font-size:6.4pt; font-weight:700; padding:0 1mm; border:.5pt solid var(--mut); color:var(--mut); border-radius:2px; line-height:1.45; vertical-align:.3mm }
.tag.s { border-color:var(--ink); color:var(--ink); background:var(--shade) }
.none { color:var(--mut); font-style:italic; padding:1mm 0 }
.note { font-size:7pt; color:var(--mut); margin-top:.8mm }
.contact { font-size:7pt; font-style:italic; color:var(--mut); margin-top:6mm; padding-top:2mm; border-top:.5pt solid var(--rule) }
.foot { display:flex; justify-content:space-between; color:var(--mut); font-size:7pt; padding:2mm 13mm 4mm; border-top:.6pt solid var(--rule); flex:none }
#flow { position:absolute; left:-10000px; top:0; width:${landscape ? '271mm' : '184mm'} }
`;

const PAGER = `
// Laid out once the fonts and pictures are in: measured earlier, the rows can
// grow when the real font arrives and run past the page foot (operator,
// 2026-11-03: "the list is been cut out").
// Anything still past a page's foot moves to the next page (made if needed),
// a table a row at a time with its header repeated, so nothing is ever cut.
function samadSettle() {
  var tpl = document.getElementById('tpl-next').innerHTML;
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  for (var k = 0; k < pages.length; k++) {
    var pb = pages[k].querySelector('.body');
    var guard = 0;
    while (pb.scrollHeight > pb.clientHeight + 1 && pb.children.length > 1 && guard++ < 500) {
      if (k === pages.length - 1) {
        var np = document.createElement('div'); np.className = 'page'; np.innerHTML = tpl;
        pages[k].parentNode.insertBefore(np, pages[k].nextSibling); pages.push(np);
      }
      var into = pages[k + 1].querySelector('.body');
      var last = pb.lastElementChild;
      var t = last.tagName === 'TABLE' && last.classList.contains('lst') ? last : null;
      if (t && t.tBodies[0].rows.length > 1) {
        var head = into.firstElementChild;
        // Join a table with the same columns already at the top of the next page.
        var cont = head && head.tagName === 'TABLE' && head.classList.contains('lst') && head.tHead && t.tHead
          && head.tHead.innerHTML === t.tHead.innerHTML ? head : null;
        if (!cont) {
          cont = t.cloneNode(true); cont.tBodies[0].innerHTML = '';
          into.insertBefore(cont, into.firstChild);
        }
        cont.tBodies[0].insertBefore(t.tBodies[0].rows[t.tBodies[0].rows.length - 1], cont.tBodies[0].firstChild);
      } else {
        var top = into.firstElementChild;
        if (t && top && top.tagName === 'TABLE' && top.classList.contains('lst') && top.tHead && t.tHead
          && top.tHead.innerHTML === t.tHead.innerHTML) {
          // A table's last piece joins the rest of it on the next page.
          while (t.tBodies[0].rows.length) top.tBodies[0].insertBefore(t.tBodies[0].rows[t.tBodies[0].rows.length - 1], top.tBodies[0].firstChild);
          pb.removeChild(t);
        } else {
          into.insertBefore(last, into.firstChild);
        }
        var before = pb.lastElementChild;
        if (before && /^H[23]$/.test(before.tagName)) into.insertBefore(before, into.firstChild);
      }
    }
  }
  var n = pages.length;
  pages.forEach(function (p, k) { var f = p.querySelector('.pn'); if (f) f.textContent = 'Page ' + (k + 1) + ' of ' + n; });
  document.body.setAttribute('data-pages', String(n));
}
function samadPage() {
  var flow = document.getElementById('flow');
  var tpl = document.getElementById('tpl-next').innerHTML;
  var pages = [document.querySelector('.page')];
  var body = pages[0].querySelector('.body');
  function room() { return body.scrollHeight <= body.clientHeight + 1; }
  function newPage() {
    var p = document.createElement('div'); p.className = 'page'; p.innerHTML = tpl;
    var lastPage = pages[pages.length - 1];
    lastPage.parentNode.insertBefore(p, lastPage.nextSibling); pages.push(p); body = p.querySelector('.body');
  }
  function place(el) {
    body.appendChild(el);
    if (room()) return;
    body.removeChild(el);
    var tbl = el.tagName === 'TABLE' && el.classList.contains('lst') ? el : null;
    var rows = tbl ? Array.prototype.slice.call(tbl.tBodies[0].rows) : null;
    if (tbl && rows.length > 1) {
      var part = tbl.cloneNode(true); var pb = part.tBodies[0]; pb.innerHTML = '';
      body.appendChild(part);
      var i = 0;
      for (; i < rows.length; i++) { pb.appendChild(rows[i].cloneNode(true)); if (!room()) { pb.removeChild(pb.lastChild); break; } }
      if (i === 0) { body.removeChild(part); } else if (i === rows.length) { return; }
      var restT = tbl.cloneNode(true); var rb = restT.tBodies[0]; rb.innerHTML = '';
      for (var j = i; j < rows.length; j++) rb.appendChild(rows[j]);
      var head = i === 0 && body.lastElementChild && /^H[23]$/.test(body.lastElementChild.tagName) ? body.lastElementChild : null;
      newPage(); if (head) body.appendChild(head); place(restT); return;
    }
    var prev = body.lastElementChild;
    newPage();
    if (prev && /^H[23]$/.test(prev.tagName)) { body.appendChild(prev); }
    body.appendChild(el);
  }
  var blocks = Array.prototype.slice.call(flow.children);
  blocks.forEach(function (b) { flow.removeChild(b); place(b); });
  flow.remove();
  samadSettle();
  pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var n = pages.length;
  pages.forEach(function (p, k) { var f = p.querySelector('.pn'); if (f) f.textContent = 'Page ' + (k + 1) + ' of ' + n; });
  document.body.setAttribute('data-pages', String(n));
}
(function () {
  var started = false;
  function go() { if (started) return; started = true; samadPage(); }
  var imgs = Array.prototype.slice.call(document.images).map(function (i) {
    return i.complete ? null : new Promise(function (ok) { i.onload = i.onerror = ok; });
  });
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : null;
  Promise.all(imgs.concat([fonts])).then(go, go);
  setTimeout(go, 3000);
})();
`;

/**
 * @param {object} o
 * @param {string} o.title        "HARSH ACCELERATION BY HOUR"
 * @param {string} o.reportNo     "HA-MENENGAI-20261101-1320"
 * @param {string} o.date         the date shown beside the number
 * @param {string} o.companyName
 * @param {Array<[string, string]>} o.info   facts under the title, two to a row: [label, value html]
 * @param {string[]} o.flow       the report's blocks, in order (headings, tables, notes)
 * @param {string} o.footNote     left of the footer
 * @param {{left: string, ogc: string, leftAlt?: string}} o.logos
 * @param {boolean} [o.landscape]
 */
export function renderLetterheadHtml({ title, reportNo, date, companyName, info = [], flow, footNote, logos, landscape = false }) {
  const rows = [];
  for (let i = 0; i < info.length; i += 2) {
    const [a, b] = [info[i], info[i + 1]];
    rows.push(`<tr><th>${esc(a[0])}</th><td>${a[1]}</td>${b ? `<th>${esc(b[0])}</th><td>${b[1]}</td>` : '<th></th><td></td>'}</tr>`);
  }
  const foot = `<div class="foot"><span>${esc(footNote)}</span><span class="pn"></span></div>`;
  const first = `<div class="lh"><img class="rai" src="${logos.left}" alt="${esc(logos.leftAlt ?? companyName)}"><img class="ogc" src="${logos.ogc}" alt="OGC Monitoring"></div>
<div class="body">
  <div class="title"><h1>${esc(title)}</h1><div class="ref">Report no. <b>${esc(reportNo)}</b> &nbsp;·&nbsp; Date <b>${esc(date)}</b></div></div>
  <table class="info">${rows.join('')}</table>
</div>${foot}`;
  const next = `<div class="lh2"><b>${esc(title)}</b><span>${esc(companyName)} · ${esc(reportNo)}</span></div><div class="body"></div>${foot}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} ${esc(companyName)} ${esc(date)}</title><style>${css(landscape)}</style></head><body>
<div class="page">${first}</div>
<template id="tpl-next">${next}</template>
<div id="flow">${flow.filter(Boolean).join('\n')}</div>
<script>${PAGER}</script>
</body></html>`;
}
