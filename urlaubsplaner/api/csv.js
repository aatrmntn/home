// CSV for Excel in Austria: semicolons, UTF-8 with BOM, CRLF.
// Cells that start like a formula are prefixed with ' so Excel shows them as text.
export function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}
