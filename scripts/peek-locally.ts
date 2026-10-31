import fs from 'node:fs';
import path from 'node:path';

// Dev-time check: fetch a page from the local server with the demo credentials read from .env, strip
// the markup, and print only the text the reviewer would see. No secret is printed.
const env = fs.readFileSync(path.resolve('.env'), 'utf8');
const pw = /^DEMO_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim();
const target = process.argv[2] ?? '/';
const res = await fetch(`http://localhost:3100${target}`, {
  headers: pw ? { Authorization: `Basic ${Buffer.from(`desk:${pw}`).toString('base64')}` } : {}
});
console.log('HTTP', res.status);
const html = await res.text();
console.log(html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, Number(process.argv[3] ?? 3000)));
