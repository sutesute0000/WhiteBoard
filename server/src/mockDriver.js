// Replays meeting_log_revised.txt as a transcript stream.
// Run: node src/mockDriver.js [serverUrl] [logPath] [speedMs]
//   serverUrl default: http://localhost:8787
//   logPath   default: ../meeting_log_revised.txt
//   speedMs   default: 800 (delay between paragraphs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serverUrl = process.argv[2] || 'http://localhost:8787';
const logPath = process.argv[3] || path.resolve(__dirname, '../../meeting_log_revised.txt');
const speed = parseInt(process.argv[4] || '800', 10);

function parseLog(text) {
  // Format: a speaker line, then blank, then a quoted paragraph (possibly multiline) starting with 「 and ending with 」
  // We split by blank lines and then walk pairs.
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    // skip blank
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const speaker = lines[i].trim();
    i++;
    // skip blank between speaker and content
    while (i < lines.length && !lines[i].trim()) i++;
    // collect content lines until blank
    const buf = [];
    while (i < lines.length && lines[i].trim()) { buf.push(lines[i]); i++; }
    const content = buf.join('\n').replace(/^「/, '').replace(/」$/, '');
    blocks.push({ speaker, text: content });
  }
  return blocks;
}

async function send(speaker, text) {
  try {
    const r = await fetch(`${serverUrl}/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker, text }),
    });
    if (!r.ok) console.warn('send failed', r.status);
  } catch (e) {
    console.error('send error', e.message);
  }
}

async function main() {
  const text = fs.readFileSync(logPath, 'utf8');
  const blocks = parseLog(text);
  console.log(`[mock] ${blocks.length} blocks parsed; speed=${speed}ms`);
  for (const b of blocks) {
    // Split long blocks by newlines (paragraphs) into separate utterances by same speaker —
    // this simulates the natural rhythm of speech rather than 1 huge utterance.
    const paragraphs = b.text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (const p of paragraphs) {
      console.log(`[mock] ${b.speaker}: ${p.slice(0, 40)}${p.length > 40 ? '…' : ''}`);
      await send(b.speaker, p);
      await new Promise(r => setTimeout(r, speed));
    }
  }
  // final flush
  await fetch(`${serverUrl}/transcript/flush`, { method: 'POST' }).catch(() => {});
  console.log('[mock] done');
}

main();
