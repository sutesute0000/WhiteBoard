import fs from 'node:fs';
import path from 'node:path';
import { createStore } from './store.js';
import { createTurnBuffer } from './turnBuffer.js';
import { createOrchestrator } from './orchestrator.js';
import { config } from './config.js';

function uid(prefix = 'b') {
  return prefix + '-' + Math.random().toString(36).slice(2, 10);
}

function nowTitle() {
  return 'Meeting ' + new Date().toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function createBoardManager() {
  const filePath = path.resolve(process.cwd(), config.fileStorePath);
  const records = new Map();
  const contexts = new Map();
  let saveTimer = null;

  load();
  if (records.size === 0) createRecord({ id: 'default', title: 'Default Board' });

  function load() {
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const board of raw.boards || []) {
        if (!board?.id) continue;
        records.set(board.id, {
          id: board.id,
          title: board.title || board.id,
          createdAt: board.createdAt || Date.now(),
          updatedAt: board.updatedAt || Date.now(),
          canvas: Array.isArray(board.canvas) ? board.canvas : [],
          state: board.state || { items: [], summaries: {}, transcripts: [], turns: [] },
        });
      }
    } catch (e) {
      console.error('[boards] load failed', e?.message || e);
    }
  }

  function scheduleSave() {
    if (config.store === 'memory') return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 150);
  }

  function saveNow() {
    saveTimer = null;
    if (config.store === 'memory') return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const boards = listBoards().map(meta => {
      const rec = records.get(meta.id);
      const ctx = contexts.get(meta.id);
      return {
        ...meta,
        canvas: rec.canvas || [],
        state: ctx ? ctx.store.dumpState() : rec.state,
      };
    });
    fs.writeFileSync(filePath, JSON.stringify({ boards }, null, 2));
  }

  function createRecord({ id = uid(), title = nowTitle() } = {}) {
    const ts = Date.now();
    const rec = {
      id,
      title,
      createdAt: ts,
      updatedAt: ts,
      canvas: [],
      state: { items: [], summaries: {}, transcripts: [], turns: [] },
    };
    records.set(id, rec);
    scheduleSave();
    return rec;
  }

  function getContext(boardId = 'default') {
    if (!records.has(boardId)) return null;
    if (contexts.has(boardId)) return contexts.get(boardId);

    const rec = records.get(boardId);
    const store = createStore({
      onPersist: () => {
        rec.updatedAt = Date.now();
        scheduleSave();
      },
    });
    store.hydrate(rec.state || {});
    const orch = createOrchestrator(store);
    const turnBuf = createTurnBuffer({ onTurn: turn => orch.enqueueTurn(turn) });
    const ctx = { board: rec, store, orch, turnBuf };
    contexts.set(boardId, ctx);
    return ctx;
  }

  function listBoards() {
    return [...records.values()]
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function createBoard(title) {
    const rec = createRecord({ title: title?.trim() || nowTitle() });
    getContext(rec.id);
    saveNow();
    return rec;
  }

  function renameBoard(boardId = 'default', title) {
    const nextTitle = String(title || '').trim();
    if (!nextTitle) return null;
    const ctx = getContext(boardId);
    if (!ctx) return null;
    ctx.board.title = nextTitle;
    ctx.board.updatedAt = Date.now();
    saveNow();
    return ctx.board;
  }

  function deleteBoard(boardId = 'default') {
    if (!records.has(boardId)) return { deleted: false, nextBoard: listBoards()[0] || null };
    records.delete(boardId);
    contexts.delete(boardId);
    if (records.size === 0) createRecord({ id: 'default', title: 'Default Board' });
    saveNow();
    return { deleted: true, nextBoard: listBoards()[0] || null };
  }

  function getCanvas(boardId = 'default') {
    if (!records.has(boardId)) return null;
    return records.get(boardId)?.canvas || [];
  }

  function saveCanvas(boardId = 'default', items = []) {
    const ctx = getContext(boardId);
    if (!ctx) return null;
    ctx.board.canvas = Array.isArray(items) ? items : [];
    ctx.board.updatedAt = Date.now();
    scheduleSave();
    return ctx.board.canvas;
  }

  return {
    listBoards,
    createBoard,
    renameBoard,
    deleteBoard,
    hasBoard: (boardId = 'default') => records.has(boardId),
    getContext,
    getCanvas,
    saveCanvas,
    saveNow,
  };
}
