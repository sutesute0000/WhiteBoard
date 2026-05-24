import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { createStore } from './store.js';
import { createTurnBuffer } from './turnBuffer.js';
import { createOrchestrator } from './orchestrator.js';

const fastify = Fastify({ logger: { level: 'info' } });
await fastify.register(cors, { origin: true });

function check(v, looksFakePat) {
  if (!v) return '✗ (missing)';
  if (looksFakePat && looksFakePat.test(v)) return '⚠ (placeholder: ' + v.slice(0, 40) + ')';
  return '✓';
}
console.log('[config]', {
  openaiEndpoint: check(config.azureOpenAIEndpoint, /your-resource|example|placeholder/i),
  openaiKey: check(config.azureOpenAIKey, /^(xxx|your|placeholder|<)/i),
  deployment: config.azureOpenAIDeployment,
  apiVersion: config.azureOpenAIApiVersion,
  speechKey: check(config.azureSpeechKey, /^(xxx|your|placeholder|<)/i),
  store: config.store,
  llmInterval: config.llmMinIntervalMs + 'ms',
});

let store;
if (config.store === 'cosmos') {
  const { createCosmosStore } = await import('./cosmosStore.js');
  store = await createCosmosStore();
  console.log('[store] cosmos');
} else {
  store = createStore();
  console.log('[store] memory');
}
const orch = createOrchestrator(store);
const turnBuf = createTurnBuffer({ onTurn: (turn) => orch.enqueueTurn(turn) });

// ---- SSE: /events ----
fastify.get('/events', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // snapshot first
  const snapshot = { type: 'snapshot', board: store.getBoard() };
  reply.raw.write(`event: ${snapshot.type}\ndata: ${JSON.stringify(snapshot)}\n\n`);

  const unsub = store.subscribe((event) => {
    try {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {}
  });

  const ping = setInterval(() => {
    try { reply.raw.write(`: ping\n\n`); } catch {}
  }, 15000);

  req.raw.on('close', () => {
    clearInterval(ping);
    unsub();
  });
});

// ---- REST ----
fastify.get('/board', async () => store.getBoard());

fastify.post('/transcript', async (req, reply) => {
  // body: {speaker:string, text:string, at?:number}
  const { speaker, text, at } = req.body || {};
  if (!speaker || !text) return reply.code(400).send({ error: 'speaker and text required' });
  turnBuf.add({ speaker, text, at });
  return { ok: true, status: orch.status() };
});

fastify.post('/transcript/flush', async () => {
  turnBuf.flush();
  return { ok: true };
});

// Human ops
fastify.post('/items/:id/confirm', async (req) => {
  const it = store.confirmItem(req.params.id);
  return { ok: !!it, item: it };
});

fastify.post('/items/:id/pin', async (req) => {
  const it = store.pinItem(req.params.id, true);
  return { ok: !!it, item: it };
});
fastify.post('/items/:id/unpin', async (req) => {
  const it = store.pinItem(req.params.id, false);
  return { ok: !!it, item: it };
});

// Human-authored item add (when user types text on the board)
fastify.post('/items', async (req, reply) => {
  const { section, text } = req.body || {};
  if (!section || !text) return reply.code(400).send({ error: 'section and text required' });
  const applied = store.applyDiff([{ op: 'add', section, text }], 'human');
  return { ok: true, item: applied[0]?.item };
});

// Azure AI Speech: クライアント用の short-lived 認可トークン発行
fastify.get('/speech/token', async (req, reply) => {
  if (!config.azureSpeechKey) return reply.code(503).send({ error: 'speech not configured' });
  try {
    const r = await fetch(
      `https://${config.azureSpeechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.azureSpeechKey } }
    );
    if (!r.ok) return reply.code(502).send({ error: 'token issue failed', status: r.status });
    const token = await r.text();
    return { token, region: config.azureSpeechRegion };
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
});

fastify.post('/items/:id/dismiss', async (req) => {
  const applied = store.applyDiff([{ op: 'remove', id: req.params.id }], 'human');
  return { ok: applied.length > 0 };
});

fastify.get('/health', async () => ({ ok: true }));

await fastify.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[server] listening on :${config.port}`);
