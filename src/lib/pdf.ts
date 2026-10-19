/**
 * Minimal PDF 1.4 writer (no dependencies) for quote and invoice documents.
 * Standard Helvetica fonts with WinAnsi encoding; text, lines and filled rectangles.
 */

// Helvetica advance widths (per 1000 em) for the characters we print; others use 556.
const W: Record<string, number> = { ' ': 278, '.': 278, ',': 278, ':': 278, '-': 333, '(': 333, ')': 333, '/': 278, '#': 556, '%': 889, '@': 1015, '&': 667, "'": 191, '×': 584, '·': 278 };
for (const c of '0123456789$') W[c] = 556;
for (const c of 'ijl') W[c] = 222;
for (const c of 'frt') W[c] = c === 'f' ? 278 : c === 'r' ? 333 : 278;
for (const c of 'mw') W[c] = c === 'm' ? 833 : 722;
for (const c of 'ABCDEFGHKNOPQRSUVXYZ') W[c] = 667;
for (const c of 'IJ') W[c] = c === 'I' ? 278 : 500;
for (const c of 'LT') W[c] = 556;
for (const c of 'MW') W[c] = c === 'M' ? 833 : 944;

export function textWidth(s: string, size: number, bold = false) {
  let w = 0;
  for (const ch of s) w += W[ch] ?? (/[a-z]/.test(ch) ? 500 : 556);
  return (w / 1000) * size * (bold ? 1.05 : 1);
}

const esc = (s: string) =>
  s.replace(/[^\x20-\x7e×·]/g, '?').replace(/×/g, 'x').replace(/·/g, '-').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export class PdfPage {
  ops: string[] = [];
  constructor(public width = 612, public height = 792) {}
  text(x: number, y: number, s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; align?: 'left' | 'right' } = {}) {
    const size = opts.size ?? 10;
    const tx = opts.align === 'right' ? x - textWidth(s, size, opts.bold) : x;
    const [r, g, b] = opts.color ?? [0.1, 0.1, 0.1];
    this.ops.push(`BT ${r} ${g} ${b} rg /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(2)} ${(this.height - y).toFixed(2)} Td (${esc(s)}) Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, gray = 0.85) {
    this.ops.push(`${gray} G 0.75 w ${x1} ${this.height - y1} m ${x2} ${this.height - y2} l S`);
  }
  rect(x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
    this.ops.push(`${rgb.join(' ')} rg ${x} ${this.height - y - h} ${w} ${h} re f`);
  }
}

export function renderPdf(pages: PdfPage[], title: string): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${esc(title)}) /Producer (Tessera) >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const content = p.ops.join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export type DocumentSpec = {
  kind: string;
  number: string | null;
  merchant: { name: string; email?: string | null };
  billTo: { name?: string | null; email?: string | null; address?: any };
  meta: [string, string][];
  header?: string | null;
  lines: { description: string; quantity: number; unit: string; amount: string; note?: string }[];
  totals: [string, string, boolean?][];
  footer?: string | null;
  status?: string | null;
};

/** Lays out a one-or-more page commercial document (quote, invoice). */
export function documentPdf(d: DocumentSpec): Buffer {
  const pages: PdfPage[] = [];
  let p = new PdfPage();
  pages.push(p);
  const L = 54;
  const R = 558;
  p.rect(0, 0, 612, 6, [0.06, 0.48, 0.4]);
  p.text(L, 64, d.kind, { size: 22, bold: true });
  if (d.status) p.text(R, 64, d.status.toUpperCase(), { size: 10, bold: true, align: 'right', color: [0.06, 0.48, 0.4] });
  let y = 92;
  for (const [k, v] of d.meta) {
    p.text(L, y, k, { size: 9, color: [0.42, 0.42, 0.4] });
    p.text(L + 110, y, v, { size: 9 });
    y += 14;
  }
  y = Math.max(y + 16, 160);
  p.text(L, y, d.merchant.name, { size: 10, bold: true });
  if (d.merchant.email) p.text(L, y + 14, d.merchant.email, { size: 9, color: [0.42, 0.42, 0.4] });
  p.text(320, y, 'Bill to', { size: 9, color: [0.42, 0.42, 0.4] });
  let by = y + 14;
  for (const s of [d.billTo.name, d.billTo.email, d.billTo.address?.line1, [d.billTo.address?.city, d.billTo.address?.state, d.billTo.address?.postal_code].filter(Boolean).join(' '), d.billTo.address?.country].filter(Boolean)) {
    p.text(320, by, String(s), { size: 10 });
    by += 14;
  }
  y = Math.max(by, y + 30) + 20;
  if (d.header) {
    p.text(L, y, d.header, { size: 11, bold: true });
    y += 24;
  }
  const header = () => {
    p.text(L, y, 'Description', { size: 9, bold: true, color: [0.42, 0.42, 0.4] });
    p.text(390, y, 'Qty', { size: 9, bold: true, color: [0.42, 0.42, 0.4], align: 'right' });
    p.text(470, y, 'Unit price', { size: 9, bold: true, color: [0.42, 0.42, 0.4], align: 'right' });
    p.text(R, y, 'Amount', { size: 9, bold: true, color: [0.42, 0.42, 0.4], align: 'right' });
    y += 8;
    p.line(L, y, R, y, 0.7);
    y += 16;
  };
  header();
  for (const l of d.lines) {
    if (y > 700) {
      p = new PdfPage();
      pages.push(p);
      y = 60;
      header();
    }
    const desc = l.description.length > 58 ? l.description.slice(0, 57) + '...' : l.description;
    p.text(L, y, desc, { size: 10 });
    p.text(390, y, String(l.quantity), { size: 10, align: 'right' });
    p.text(470, y, l.unit, { size: 10, align: 'right' });
    p.text(R, y, l.amount, { size: 10, align: 'right' });
    if (l.note) {
      y += 12;
      p.text(L, y, l.note, { size: 8, color: [0.42, 0.42, 0.4] });
    }
    y += 10;
    p.line(L, y, R, y);
    y += 16;
  }
  y += 6;
  for (const [k, v, bold] of d.totals) {
    if (y > 740) {
      p = new PdfPage();
      pages.push(p);
      y = 60;
    }
    p.text(400, y, k, { size: bold ? 11 : 10, bold: !!bold, align: 'right' });
    p.text(R, y, v, { size: bold ? 11 : 10, bold: !!bold, align: 'right' });
    y += bold ? 20 : 16;
  }
  if (d.footer) {
    // Wrap at ~110 characters; lines stack upwards from the bottom margin.
    const out: string[] = [];
    for (const para of d.footer.split('\n')) {
      let line = '';
      for (const w of para.split(' ')) {
        if ((line + ' ' + w).trim().length > 110) { out.push(line.trim()); line = w; } else line += ' ' + w;
      }
      if (line.trim()) out.push(line.trim());
    }
    out.slice(0, 6).forEach((t, i, all) => p.text(L, 756 - (all.length - 1 - i) * 11, t, { size: 8, color: [0.42, 0.42, 0.4] }));
  }
  pages.forEach((pg, i) => pg.text(R, 772, `Page ${i + 1} of ${pages.length}`, { size: 8, align: 'right', color: [0.55, 0.55, 0.52] }));
  return renderPdf(pages, `${d.kind} ${d.number ?? ''}`.trim());
}
