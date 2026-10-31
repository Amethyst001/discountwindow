// Capability probe: does the configured reader accept an image part at all? Nothing is built on the
// vision path until this answers yes.
import fs from 'node:fs';
import { config, assertSandbox } from '../src/config.ts';

const file = process.argv[2] ?? 'temp/probe.png';
const bytes = fs.readFileSync(file);
const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';

async function tokenLike() {
  const res = await fetch(`${config.geminiBase}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.geminiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.geminiModel,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Transcribe exactly what is printed in the image. Reply with the text only.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image follows.' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(60_000)
  });
  const payload: any = await res.json().catch(() => null);
  console.log(`http=${res.status} model=${payload?.model ?? '-'}`);
  if (!res.ok) { console.log(JSON.stringify(payload).slice(0, 600)); return; }
  console.log('content:', String(payload?.choices?.[0]?.message?.content ?? '').slice(0, 400));
}

assertSandbox();
await tokenLike();
