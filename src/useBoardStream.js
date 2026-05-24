import { useEffect, useState, useCallback } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8787';

export function useBoardStream() {
  const [items, setItems] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER_URL}/board`)
      .then(r => r.ok ? r.json() : null)
      .then((board) => {
        if (!board || cancelled) return;
        setItems(board.items || []);
        setSummaries(board.summaries || {});
      })
      .catch(() => {});

    const es = new EventSource(`${SERVER_URL}/events`);
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));

    es.addEventListener('snapshot', (e) => {
      try {
        const data = JSON.parse(e.data);
        setItems(data.board.items || []);
        setSummaries(data.board.summaries || {});
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

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const confirmItem = useCallback(async (id) => {
    await fetch(`${SERVER_URL}/items/${id}/confirm`, { method: 'POST' });
  }, []);

  const dismissItem = useCallback(async (id) => {
    await fetch(`${SERVER_URL}/items/${id}/dismiss`, { method: 'POST' });
  }, []);

  const pinItem = useCallback(async (id) => {
    await fetch(`${SERVER_URL}/items/${id}/pin`, { method: 'POST' });
  }, []);

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

  return { items, aiItems, summaries, connected, confirmItem, dismissItem, pinItem, addHumanItem };
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
