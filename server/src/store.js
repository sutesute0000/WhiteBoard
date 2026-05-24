// In-memory store. Designed so a Cosmos DB adapter can replace this 1:1.
import { EventEmitter } from 'node:events';

const SECTIONS = [];

function uid(prefix = 'i') {
  return prefix + '-' + Math.random().toString(36).slice(2, 10);
}

export function createStore({ onPersist } = {}) {
  const emitter = new EventEmitter();
  const state = {
    items: [],            // graph item: {id,type:'graph',speaker,title,diagramType,nodes,edges,turnId,createdAt,updatedAt}
    summaries: {},        // section -> [{id, text, coversTurnIds:[]}]
    turns: [],            // {id, speaker, text, startedAt, endedAt}
    processedTurnIds: new Set(),
  };

  function hydrate({ items, turns, summaries }) {
    if (items) state.items = items;
    if (turns) state.turns = turns;
    if (summaries) state.summaries = summaries;
  }

  function dumpState() {
    return {
      items: state.items,
      summaries: state.summaries,
      turns: state.turns,
    };
  }

  function persist(kind, payload) {
    if (onPersist) {
      try { onPersist(kind, payload); } catch (e) { console.error('[persist]', e); }
    }
  }

  function publish(event) {
    emitter.emit('event', event);
  }

  function subscribe(handler) {
    emitter.on('event', handler);
    return () => emitter.off('event', handler);
  }

  function listItems() { return state.items; }
  function getItem(id) { return state.items.find(it => it.id === id); }
  function getBoard() {
    return {
      sections: SECTIONS,
      items: state.items,
      summaries: state.summaries,
    };
  }

  function addTurn(turn) {
    state.turns.push(turn);
    publish({ type: 'turn.added', turn });
    persist('turn.add', turn);
  }
  function markTurnsProcessed(ids) { ids.forEach(id => state.processedTurnIds.add(id)); }
  function unprocessedTurns() { return state.turns.filter(t => !state.processedTurnIds.has(t.id)); }
  function recentTurns(n = 6) { return state.turns.slice(-n); }

  // ---- diff application ----
  // op: {op:'add_graph', speaker?, title?, diagramType?, layout?, nodes?, edges?, turnId?}
  function applyDiff(ops, source = 'ai') {
    const applied = [];
    const now = Date.now();
    for (const op of ops) {
      if (op.op === 'add_graph') {
        const nodes = Array.isArray(op.nodes) ? op.nodes.map((node, index) => ({
          id: String(node.id || `N${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '') || `N${index + 1}`,
          label: String(node.label || '').trim(),
          kind: String(node.kind || 'claim').trim(),
        })).filter(node => node.label) : [];
        const nodeIds = new Set(nodes.map(node => node.id));
        const edges = Array.isArray(op.edges) ? op.edges.map(edge => ({
          from: String(edge.from || '').trim(),
          to: String(edge.to || '').trim(),
          label: String(edge.label || '').trim(),
        })).filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to) : [];
        if (nodes.length === 0) continue;
        const item = {
          id: uid(),
          type: 'graph',
          speaker: (op.speaker || '').trim(),
          title: (op.title || '').trim(),
          diagramType: (op.diagramType || 'logic').trim(),
          layout: op.layout === 'LR' ? 'LR' : 'TD',
          nodes,
          edges,
          turnId: op.turnId || null,
          text: (op.title || '').trim(),
          author: source,
          status: 'confirmed',
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        state.items.push(item);
        applied.push({ op: 'add', item });
      } else if (op.op === 'add_diagram') {
        const item = {
          id: uid(),
          type: 'diagram',
          speaker: (op.speaker || '').trim(),
          title: (op.title || '').trim(),
          diagramType: (op.diagramType || 'logic').trim(),
          mermaid: (op.mermaid || '').trim(),
          turnId: op.turnId || null,
          text: (op.title || '').trim(),
          author: source,
          status: 'confirmed',
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        if (!item.mermaid) continue;
        state.items.push(item);
        applied.push({ op: 'add', item });
      } else if (op.op === 'add') {
        const item = {
          id: uid(),
          type: 'note',
          section: op.section || '',
          text: (op.text || '').trim(),
          author: source,
          status: 'confirmed',
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        if (!item.text) continue;
        state.items.push(item);
        applied.push({ op: 'add', item });
      } else if (op.op === 'update') {
        const it = getItem(op.id);
        if (!it) continue;
        // AI cannot edit human/confirmed items
        if (source === 'ai' && (it.author === 'human' || it.status === 'confirmed' || it.pinned)) continue;
        if (op.text != null) it.text = op.text.trim();
        if (op.section != null) it.section = op.section;
        if (op.status != null) it.status = op.status;
        it.updatedAt = now;
        applied.push({ op: 'update', item: it });
      } else if (op.op === 'remove') {
        const idx = state.items.findIndex(x => x.id === op.id);
        if (idx < 0) continue;
        const it = state.items[idx];
        if (source === 'ai' && (it.author === 'human' || it.status === 'confirmed' || it.pinned)) continue;
        state.items.splice(idx, 1);
        applied.push({ op: 'remove', id: op.id });
      } else if (op.op === 'merge') {
        const ids = op.mergeIds || [];
        const targets = ids.map(getItem).filter(Boolean);
        if (targets.length < 2) continue;
        // AI cannot merge if any target is human/confirmed
        if (source === 'ai' && targets.some(it => it.author === 'human' || it.status === 'confirmed' || it.pinned)) continue;
        const section = targets[0].section;
        const merged = {
          id: uid(),
          section,
          text: (op.text || targets.map(t => t.text).join(' / ')).trim(),
          author: source,
          status: 'confirmed',
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        // remove targets, push merged
        for (const t of targets) {
          const idx = state.items.findIndex(x => x.id === t.id);
          if (idx >= 0) state.items.splice(idx, 1);
        }
        state.items.push(merged);
        applied.push({ op: 'merge', removedIds: targets.map(t => t.id), item: merged });
      }
    }
    if (applied.length) {
      publish({ type: 'board.diff', ops: applied });
      persist('items.diff', applied);
    }
    return applied;
  }

  // ---- human operations ----
  function confirmItem(id) {
    const it = getItem(id);
    if (!it) return null;
    it.status = 'confirmed';
    it.updatedAt = Date.now();
    publish({ type: 'board.diff', ops: [{ op: 'update', item: it }] });
    persist('item.update', it);
    return it;
  }

  function pinItem(id, pinned = true) {
    const it = getItem(id);
    if (!it) return null;
    it.pinned = pinned;
    it.updatedAt = Date.now();
    publish({ type: 'board.diff', ops: [{ op: 'update', item: it }] });
    persist('item.update', it);
    return it;
  }

  function setSummary(section, text, coversTurnIds = []) {
    if (!state.summaries[section]) state.summaries[section] = [];
    const entry = { id: uid('s'), text, coversTurnIds };
    state.summaries[section].push(entry);
    publish({ type: 'summary.added', section, entry });
    persist('summary.add', { section, entry });
    return entry;
  }

  return {
    SECTIONS,
    listItems, getItem, getBoard,
    addTurn, markTurnsProcessed, unprocessedTurns, recentTurns,
    applyDiff,
    confirmItem, pinItem,
    setSummary,
    subscribe, publish,
    hydrate, dumpState,
  };
}
