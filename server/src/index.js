import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { createBoardManager } from './boardManager.js';

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

const boards = createBoardManager();
console.log('[store]', config.store);
const speakerAliases = new Map();

function boardIdFrom(req) {
  return req.params?.boardId || req.query?.boardId || req.body?.boardId || 'default';
}

function anonymousSpeaker(source, meetingId, speakerId) {
  const key = `${source || 'external'}:${meetingId || 'default'}:${speakerId || 'unknown'}`;
  if (!speakerAliases.has(key)) speakerAliases.set(key, `Speaker ${speakerAliases.size + 1}`);
  return speakerAliases.get(key);
}

function normalizeTranscript(body = {}, source = 'manual') {
  const text = String(body.text || '').trim();
  const speakerId = body.speakerId != null ? String(body.speakerId).trim() : '';
  const speaker = String(body.speaker || '').trim() || (speakerId ? anonymousSpeaker(source, body.meetingId, speakerId) : '');
  return {
    speaker,
    speakerId: speakerId || null,
    source,
    meetingId: body.meetingId || null,
    text,
    at: body.at,
  };
}

// ---- SSE: /events ----
fastify.get('/events', async (req, reply) => {
  const ctx = boards.getContext(boardIdFrom(req));
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // snapshot first
  const snapshot = { type: 'snapshot', board: ctx.store.getBoard() };
  reply.raw.write(`event: ${snapshot.type}\ndata: ${JSON.stringify(snapshot)}\n\n`);

  const unsub = ctx.store.subscribe((event) => {
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
fastify.get('/boards', async () => ({ boards: boards.listBoards() }));

fastify.post('/boards', async (req) => {
  const board = boards.createBoard(req.body?.title);
  return { ok: true, board };
});

fastify.get('/board', async (req) => boards.getContext(boardIdFrom(req)).store.getBoard());

fastify.get('/boards/:boardId/board', async (req) => boards.getContext(boardIdFrom(req)).store.getBoard());

fastify.get('/canvas', async (req) => ({ items: boards.getCanvas(boardIdFrom(req)) }));

fastify.post('/canvas', async (req) => {
  const items = boards.saveCanvas(boardIdFrom(req), req.body?.items || []);
  return { ok: true, count: items.length };
});

fastify.post('/transcript', async (req, reply) => {
  const ctx = boards.getContext(boardIdFrom(req));
  // body: {speaker:string, text:string, at?:number}
  const { speaker, text, at } = normalizeTranscript(req.body, 'manual');
  if (!speaker || !text) return reply.code(400).send({ error: 'speaker and text required' });
  const turn = { speaker, text, at };
  ctx.store.addTranscript(turn);
  ctx.turnBuf.add(turn);
  return { ok: true, status: ctx.orch.status() };
});

fastify.post('/transcript/external', async (req, reply) => {
  const ctx = boards.getContext(boardIdFrom(req));
  // body: {speakerId?:string, speaker?:string, text:string, meetingId?:string, at?:number}
  // speakerId は実名ではなく、話者交代検出用の安定IDとして扱う。
  const turn = normalizeTranscript(req.body, req.body?.source || 'external');
  if (!turn.speaker || !turn.text) return reply.code(400).send({ error: 'speakerId or speaker, and text required' });
  ctx.store.addTranscript(turn);
  ctx.turnBuf.add(turn);
  return { ok: true, speaker: turn.speaker, status: ctx.orch.status() };
});

fastify.post('/teams/transcript', async (req, reply) => {
  const ctx = boards.getContext(boardIdFrom(req));
  // Teams audio ingestor / Teams media bot からの受け口。
  // 実名特定は不要。speakerId の変化だけでターン境界を維持する。
  const turn = normalizeTranscript(req.body, 'teams');
  if (!turn.speaker || !turn.text) return reply.code(400).send({ error: 'speakerId or speaker, and text required' });
  if (req.body?.debugOnly) return { ok: true, debugOnly: true, speaker: turn.speaker };
  console.log('[teams/transcript]', turn.speaker, turn.speakerId || '-', turn.text.slice(0, 80));
  ctx.store.addTranscript(turn);
  ctx.turnBuf.add(turn);
  return { ok: true, speaker: turn.speaker, status: ctx.orch.status() };
});

fastify.post('/transcript/flush', async (req) => {
  boards.getContext(boardIdFrom(req)).turnBuf.flush();
  return { ok: true };
});

// Human ops
fastify.post('/items/:id/confirm', async (req) => {
  const it = boards.getContext(boardIdFrom(req)).store.confirmItem(req.params.id);
  return { ok: !!it, item: it };
});

fastify.post('/items/:id/pin', async (req) => {
  const it = boards.getContext(boardIdFrom(req)).store.pinItem(req.params.id, true);
  return { ok: !!it, item: it };
});
fastify.post('/items/:id/unpin', async (req) => {
  const it = boards.getContext(boardIdFrom(req)).store.pinItem(req.params.id, false);
  return { ok: !!it, item: it };
});

// Human-authored item add (when user types text on the board)
fastify.post('/items', async (req, reply) => {
  const { section, text } = req.body || {};
  if (!section || !text) return reply.code(400).send({ error: 'section and text required' });
  const applied = boards.getContext(boardIdFrom(req)).store.applyDiff([{ op: 'add', section, text }], 'human');
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
  const applied = boards.getContext(boardIdFrom(req)).store.applyDiff([{ op: 'remove', id: req.params.id }], 'human');
  return { ok: applied.length > 0 };
});

fastify.get('/health', async () => ({ ok: true }));

await fastify.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[server] listening on :${config.port}`);
