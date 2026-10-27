/**
 * The roster as a CSV file.
 *
 * Client-side on purpose: the rows are already in memory, already filtered,
 * and already scoped by the server to what this administrator may see. Asking
 * the API for an export would be a second implementation of the same
 * permission rules, and the two would disagree the first time either changed.
 *
 * What it exports is WHAT IS ON SCREEN — the current filters, the current
 * column choice, the current sort. An export that quietly returned the whole
 * roster would hand somebody a file that disagrees with the page they exported
 * it from, which is worse than no export.
 */

/**
 * One CSV field, RFC 4180.
 *
 * The leading-character guard is not cosmetic: a value beginning `=`, `+`, `-`
 * or `@` is executed as a formula when the file is opened in Excel or Sheets.
 * A person free to type their own display name is therefore free to type a
 * formula into every administrator's spreadsheet, so those values are prefixed
 * with a tab, which Excel strips on display but will not evaluate.
 */
export function csvField(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `\t${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * @param {Array<object>} rows
 * @param {Array<{ key: string, label: string, value: (row: object) => unknown }>} columns
 */
export function toCsv(rows, columns) {
  const cols = columns ?? [];
  const head = cols.map((c) => csvField(c.label)).join(",");
  const body = (rows ?? []).map((row) =>
    cols.map((c) => csvField(c.value(row))).join(","),
  );
  // CRLF, which is what RFC 4180 specifies and what Excel expects on Windows.
  return [head, ...body].join("\r\n");
}

/** `people-sukari-2026-09-21.csv` — scope and date, so two exports never collide. */
export function exportFilename(scopeName, when = new Date()) {
  const slug = String(scopeName ?? "roster")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "roster";
  const iso = Number.isNaN(when?.getTime?.()) ? "" : when.toISOString().slice(0, 10);
  return `people-${slug}${iso ? `-${iso}` : ""}.csv`;
}

/**
 * Hand the file to the browser.
 *
 * A BOM, because Excel reads a UTF-8 CSV as the system codepage without one
 * and turns every non-ASCII name into mojibake — which on this fleet's roster
 * is not a rare case.
 */
export function downloadCsv(text, filename) {
  // Written as an escape, never as a literal BOM in this file: an invisible
  // U+FEFF in source is a character no reviewer can see, and eslint
  // (no-irregular-whitespace) rightly refuses it.
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Freed on the next tick: revoking synchronously races the click in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
