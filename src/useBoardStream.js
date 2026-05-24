import { useEffect, useState, useCallback } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8787';

export function useBoardStream(boardId = 'default') {
  const [items, setItems] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [transcripts, setTranscripts] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = `?boardId=${encodeURIComponent(boardId)}`;
    const loadSnapshot = () => fetch(`${SERVER_URL}/board${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then((board) => {
        if (!board || cancelled) return;
        setItems(board.items || []);
        setSummaries(board.summaries || {});
        setTranscripts(board.transcripts || []);
      })
      .catch(() => {});

    loadSnapshot();
    const poll = setInterval(loadSnapshot, 2500);

    const es = new EventSource(`${SERVER_URL}/events${qs}`);
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));

    es.addEventListener('snapshot', (e) => {
      try {
        const data = JSON.parse(e.data);
        setItems(data.board.items || []);
        setSummaries(data.board.summaries || {});
        setTranscripts(data.board.transcripts || []);
      } catch {}
    });

    es.addEventListener('board.diff', (e) => {
      try {
        const data = JSON.parse(e.data);
        setItems((prev) => applyOps(prev, data.ops || []));
      } catch {}
    });

    es.addEventListener('summary.added', (e) => {
      try {
        const data = JSON.parse(e.data);
        setSummaries((prev) => {
          const next = { ...prev };
          next[data.section] = [...(next[data.section] || []), data.entry];
          return next;
        });
      } catch {}
    });

    es.addEventListener('transcript.added', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.transcript) return;
        setTranscripts((prev) => [...prev, data.transcript].slice(-200));
      } catch {}
    });

    return () => {
      cancelled = true;
      clearInterval(poll);
      es.close();
    };
  }, [boardId]);

  const confirmItem = useCallback(async (id) => {
    await fetch(`${SERVER_URL}/items/${id}/confirm?boardId=${encodeURIComponent(boardId)}`, { method: 'POST' });
  }, [boardId]);

  const dismissItem = useCallback(async (id) => {
    await fetch(`${SERVER_URL}/items/${id}/dismiss?boardId=${encodeURIComponent(boardId)}`, { method: 'POST' });
  }, [boardId]);

  const pinItem = useCallback(async (id) => {
    await fetch(`${SERVER_URL}/items/${id}/pin?boardId=${encodeURIComponent(boardId)}`, { method: 'POST' });
  }, [boardId]);

  const addHumanItem = useCallback(async (section, text) => {
    try {
      const r = await fetch(`${SERVER_URL}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section, text }),
      });
      return r.ok;
    } catch { return false; }
  }, []);

  // AI 表示用には author='ai' のみ。human はキャンバスで既に描画済み。
  const aiItems = items.filter(it => it.author === 'ai');

  const loadCanvas = useCallback(async () => {
    const r = await fetch(`${SERVER_URL}/canvas?boardId=${encodeURIComponent(boardId)}`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.items || [];
  }, [boardId]);

  const saveCanvas = useCallback(async (items) => {
    try {
      await fetch(`${SERVER_URL}/canvas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ boardId, items }),
      });
    } catch {}
  }, [boardId]);

  return { items, aiItems, summaries, transcripts, connected, confirmItem, dismissItem, pinItem, addHumanItem, loadCanvas, saveCanvas };
}

function applyOps(prev, ops) {
  let arr = prev.slice();
  for (const op of ops) {
    if (op.op === 'add' && op.item) {
      arr.push(op.item);
    } else if (op.op === 'update' && op.item) {
      const i = arr.findIndex(x => x.id === op.item.id);
      if (i >= 0) arr[i] = op.item; else arr.push(op.item);
    } else if (op.op === 'remove' && op.id) {
      arr = arr.filter(x => x.id !== op.id);
    } else if (op.op === 'merge' && op.item) {
      const rm = new Set(op.removedIds || []);
      arr = arr.filter(x => !rm.has(x.id));
      arr.push(op.item);
    }
  }
  return arr;
}
