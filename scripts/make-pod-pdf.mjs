// Builds a one page, text-layer PDF from a list of lines. Used to produce the demo's proof of
// delivery documents and to exercise the upload path with a real file rather than a fixture string.
import fs from 'node:fs';

export function buildPdf(lines, { width = 595, height = 842, size = 12 } = {}) {
  const escaped = lines.map((l) => String(l).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  const content = ['BT', `/F1 ${size} Tf`, `${size + 6} TL`, `${48} ${height - 72} Td`]
    .concat(escaped.map((l) => `(${l}) Tj T*`))
    .concat(['ET']).join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [, , specFile, outFile] = process.argv;
  const lines = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  fs.writeFileSync(outFile, buildPdf(lines));
  console.log(`wrote ${outFile} (${fs.statSync(outFile).size} bytes)`);
}
