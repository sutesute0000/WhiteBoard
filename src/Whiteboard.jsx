import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useBoardStream } from './useBoardStream.js';
import { useSpeech, postUtterance } from './useSpeech.js';

const COLORS = ['#22252c', '#d94f4a', '#3760e0', '#0fa37f', '#e8a23c', '#7e57c2', '#e26ca5'];
const NODE_COLORS = {
  claim: '#fff7cc',
  reason: '#e8f2ff',
  step: '#eaf8ed',
  option: '#f2ecff',
  risk: '#ffe6e3',
  action: '#e2faf3',
  result: '#fff0d7',
  issue: '#ffe9ef',
};
const EDGE_TYPES = ['理由', '結果', '比較・対立', '前提', '具体化', '例', 'リスク', '提案', '結論', '範囲', '範囲外', '時系列'];
const uid = () => Math.random().toString(36).slice(2, 10);

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export default function Whiteboard() {
  const canvasRef = useRef(null);
  const textareaRef = useRef(null);
  const ingestedGraphIdsRef = useRef(new Set());
  const stateRef = useRef({
    items: [],
    history: [],
    future: [],
    view: { x: 0, y: 0, scale: 1 },
    drawing: null,
    panning: null,
    dragging: null,
    marquee: null,
    edgeDraft: null,
    spaceDown: false,
    selected: new Set(),
  });

  const [tool, setTool] = useState('select');
  const [color, setColor] = useState('#2b2d33');
  const [size, setSize] = useState(3);
  const [zoom, setZoom] = useState(1);
  const [edgeType, setEdgeType] = useState('理由');
  const [textInput, setTextInput] = useState(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [, force] = useState(0);
  const rerender = useCallback(() => force(n => n + 1), []);

  const { items: streamItems, connected } = useBoardStream();
  const graphItems = useMemo(() => streamItems.filter(it => it.type === 'graph'), [streamItems]);
  const { listening, error: speechError, start: startSpeech, stop: stopSpeech } = useSpeech({
    onUtterance: ({ speaker, text }) => postUtterance(speaker, text),
  });

  const toolRef = useRef(tool); toolRef.current = tool;
  const colorRef = useRef(color); colorRef.current = color;
  const sizeRef = useRef(size); sizeRef.current = size;
  const edgeTypeRef = useRef(edgeType); edgeTypeRef.current = edgeType;

  const worldFromScreen = (sx, sy) => {
    const v = stateRef.current.view;
    return { x: sx / v.scale - v.x, y: sy / v.scale - v.y };
  };

  const openTextInputAt = useCallback((screenX, screenY, value = '', editingId = null) => {
    const wp = worldFromScreen(screenX, screenY);
    setTextInput({
      screenX,
      screenY,
      worldX: wp.x,
      worldY: wp.y,
      value,
      editingId,
    });
  }, []);

  const snapshot = () => JSON.parse(JSON.stringify(stateRef.current.items));
  const pushHistory = () => {
    const st = stateRef.current;
    st.history.push(snapshot());
    if (st.history.length > 80) st.history.shift();
    st.future = [];
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const v = stateRef.current.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.x * v.scale, dpr * v.y * v.scale);

    drawGrid(ctx, w, h, v);
    for (const it of stateRef.current.items) drawItem(ctx, it);
    if (stateRef.current.drawing) drawItem(ctx, stateRef.current.drawing);
    if (stateRef.current.edgeDraft) drawEdgeDraft(ctx, stateRef.current.edgeDraft);
    drawSelection(ctx, v);
    if (stateRef.current.marquee) drawMarquee(ctx, v);
  }, []);

  useEffect(() => {
    const unseen = graphItems.filter(item => !ingestedGraphIdsRef.current.has(item.id));
    if (unseen.length === 0) return;
    pushHistory();
    const st = stateRef.current;
    const existing = st.items.filter(it => it.type === 'graphTitle').length;
    for (let i = 0; i < unseen.length; i++) {
      const graph = unseen[i];
      ingestedGraphIdsRef.current.add(graph.id);
      st.items.push(...graphToCanvasItems(graph, existing + i));
    }
    draw();
    rerender();
  }, [graphItems, draw, rerender]);

  useEffect(() => {
    if (!textInput || !textareaRef.current) return;
    const id = window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [textInput?.editingId, textInput?.screenX, textInput?.screenY]);

  function drawGrid(ctx, w, h, v) {
    const spacing = 40;
    const minX = -v.x;
    const minY = -v.y;
    const maxX = minX + w / v.scale;
    const maxY = minY + h / v.scale;
    ctx.fillStyle = 'rgba(15,23,42,0.12)';
    const r = Math.max(0.55, 1 / v.scale);
    for (let x = Math.floor(minX / spacing) * spacing; x < maxX; x += spacing) {
      for (let y = Math.floor(minY / spacing) * spacing; y < maxY; y += spacing) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawItem(ctx, it) {
    if (it.type === 'graphEdge') return drawGraphEdge(ctx, it);
    if (it.type === 'graphNode') return drawGraphNode(ctx, it);
    if (it.type === 'graphTitle') return drawGraphTitle(ctx, it);
    if (it.type === 'stroke') {
      ctx.strokeStyle = it.color;
      ctx.fillStyle = it.color;
      ctx.lineWidth = it.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = it.erase ? 'destination-out' : 'source-over';
      const pts = it.points;
      ctx.beginPath();
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, it.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      return;
    }
    if (it.type === 'text') {
      ctx.fillStyle = it.color;
      ctx.font = `400 ${it.size}px "Klee One", "Yomogi", "Yu Gothic UI", cursive`;
      ctx.textBaseline = 'top';
      it.text.split('\n').forEach((line, i) => ctx.fillText(line, it.x, it.y + i * it.size * 1.3));
    }
  }

  function drawGraphNode(ctx, it) {
    ctx.save();
    ctx.fillStyle = it.fill || NODE_COLORS[it.kind] || '#ffffff';
    ctx.strokeStyle = '#24262d';
    ctx.lineWidth = 2;
    roughRoundRect(ctx, it.x, it.y, it.w, it.h, 12, it.id);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(36,38,45,0.45)';
    ctx.lineWidth = 1.2;
    roughRoundRect(ctx, it.x + 2, it.y - 1, it.w - 1, it.h + 2, 12, it.id + 'b');
    ctx.stroke();

    ctx.fillStyle = '#1f232b';
    ctx.font = `400 ${it.fontSize || 17}px "Yomogi", "Klee One", "Yu Gothic UI", cursive`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const lines = wrapText(ctx, it.label, it.w - 24, 3);
    const lineHeight = (it.fontSize || 17) * 1.25;
    const top = it.y + it.h / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => ctx.fillText(line, it.x + it.w / 2, top + i * lineHeight));
    ctx.restore();
  }

  function drawGraphTitle(ctx, it) {
    ctx.save();
    ctx.fillStyle = '#1f232b';
    ctx.font = '400 19px "Yomogi", "Klee One", "Yu Gothic UI", cursive';
    ctx.textBaseline = 'top';
    ctx.fillText(it.speaker || 'Speaker', it.x, it.y);
    ctx.font = '400 24px "Yomogi", "Klee One", "Yu Gothic UI", cursive';
    ctx.fillText(it.label || '発言の構造', it.x, it.y + 24);
    ctx.strokeStyle = 'rgba(31,35,43,0.5)';
    ctx.lineWidth = 1.5;
    roughLine(ctx, it.x, it.y + 57, it.x + Math.min(280, Math.max(120, it.w)), it.y + 57, it.id);
    ctx.restore();
  }

  function drawGraphEdge(ctx, it) {
    const from = findItem(it.from);
    const to = findItem(it.to);
    if (!from || !to) return;
    const a = nodeCenter(from);
    const b = nodeCenter(to);
    const start = pointOnRect(from, b.x - a.x, b.y - a.y);
    const end = pointOnRect(to, a.x - b.x, a.y - b.y);
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const bend = it.layout === 'TD'
      ? { x: mid.x + jitter(it.id, 0, 14), y: mid.y + jitter(it.id, 1, 10) }
      : { x: mid.x + jitter(it.id, 0, 10), y: mid.y + jitter(it.id, 1, 14) };

    ctx.save();
    ctx.strokeStyle = '#24262d';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(start.x + jitter(it.id, i + 2, 2), start.y + jitter(it.id, i + 3, 2));
      ctx.quadraticCurveTo(bend.x, bend.y, end.x + jitter(it.id, i + 4, 2), end.y + jitter(it.id, i + 5, 2));
      ctx.stroke();
    }
    drawArrow(ctx, bend, end, it.id);
    if (it.label) drawEdgeLabel(ctx, it.label, mid.x, mid.y);
    ctx.restore();
  }

  function drawEdgeLabel(ctx, label, x, y) {
    ctx.font = '400 15px "Yomogi", "Klee One", "Yu Gothic UI", cursive';
    const w = ctx.measureText(label).width + 18;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(x - w / 2, y - 13, w, 25);
    ctx.fillStyle = '#333842';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }

  function drawEdgeDraft(ctx, draft) {
    const from = findItem(draft.from);
    if (!from) return;
    const a = nodeCenter(from);
    const end = draft.to;
    const start = pointOnRect(from, end.x - a.x, end.y - a.y);
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    ctx.save();
    ctx.strokeStyle = 'rgba(36,38,45,0.58)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.quadraticCurveTo(mid.x + jitter(draft.from, 30, 10), mid.y + jitter(draft.from, 31, 10), end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawArrow(ctx, mid, end, draft.from + '-draft');
    ctx.restore();
  }

  function drawSelection(ctx, v) {
    const groups = groupBoundsForSelection();
    if (groups.length === 0) return;
    ctx.lineWidth = 1.5 / v.scale;
    ctx.setLineDash([6 / v.scale, 4 / v.scale]);
    ctx.strokeStyle = '#3760e0';
    for (const b of groups) {
      const pad = 6 / v.scale;
      ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2);
    }
    ctx.setLineDash([]);
  }

  function drawMarquee(ctx, v) {
    const m = stateRef.current.marquee;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    ctx.fillStyle = 'rgba(55,96,224,0.08)';
    ctx.strokeStyle = '#3760e0';
    ctx.lineWidth = 1 / v.scale;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  function boundsOf(it) {
    if (it.type === 'graphNode') return { minX: it.x, minY: it.y, maxX: it.x + it.w, maxY: it.y + it.h };
    if (it.type === 'graphTitle') return { minX: it.x, minY: it.y, maxX: it.x + it.w, maxY: it.y + it.h };
    if (it.type === 'graphEdge') {
      const from = findItem(it.from);
      const to = findItem(it.to);
      if (!from || !to) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const a = nodeCenter(from), b = nodeCenter(to);
      return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    }
    if (it.type === 'stroke') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of it.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const pad = it.size / 2;
      return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.font = `400 ${it.size}px "Klee One", "Yomogi", "Yu Gothic UI", cursive`;
    const lines = it.text.split('\n');
    const width = Math.max(...lines.map(line => ctx.measureText(line).width), 1);
    ctx.restore();
    return { minX: it.x, minY: it.y, maxX: it.x + width, maxY: it.y + lines.length * it.size * 1.3 };
  }

  function groupBoundsForSelection() {
    const st = stateRef.current;
    const buckets = new Map();
    for (const id of st.selected) {
      const it = st.items.find(x => x.id === id);
      if (!it) continue;
      const key = it.groupId || '_' + it.id;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(it);
    }
    const out = [];
    for (const bucket of buckets.values()) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const it of bucket) {
        const b = boundsOf(it);
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      }
      out.push({ minX, minY, maxX, maxY });
    }
    return out;
  }

  function hitTest(wx, wy) {
    const st = stateRef.current;
    const tol = 10 / st.view.scale;
    for (let i = st.items.length - 1; i >= 0; i--) {
      const it = st.items[i];
      if (it.type === 'stroke') {
        const pts = it.points;
        const r = it.size / 2 + tol;
        for (let j = 0; j < pts.length - 1; j++) {
          if (distToSeg(wx, wy, pts[j], pts[j + 1]) <= r) return it;
        }
      } else if (it.type === 'text' || it.type === 'graphNode' || it.type === 'graphTitle') {
        const b = boundsOf(it);
        if (wx >= b.minX - tol && wx <= b.maxX + tol && wy >= b.minY - tol && wy <= b.maxY + tol) return it;
      } else if (it.type === 'graphEdge') {
        const from = findItem(it.from);
        const to = findItem(it.to);
        if (!from || !to) continue;
        const a = nodeCenter(from), b = nodeCenter(to);
        if (distToSeg(wx, wy, a, b) <= tol + 8) return it;
      }
    }
    return null;
  }

  function findItem(id) {
    return stateRef.current.items.find(it => it.id === id);
  }

  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  function expandToGroup(ids) {
    const st = stateRef.current;
    const groups = new Set();
    for (const id of ids) {
      const it = st.items.find(x => x.id === id);
      if (it?.groupId) groups.add(it.groupId);
    }
    const out = new Set(ids);
    for (const it of st.items) if (it.groupId && groups.has(it.groupId)) out.add(it.id);
    return out;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      draw();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e) => {
      if (textInput) return;
      const st = stateRef.current;
      const wp = worldFromScreen(e.clientX, e.clientY);
      const isPan = toolRef.current === 'hand' || e.button === 1 || st.spaceDown;

      if (toolRef.current === 'text' && !isPan) {
        openTextInputAt(e.clientX, e.clientY);
        return;
      }

      canvas.setPointerCapture(e.pointerId);

      if (isPan) {
        st.panning = { sx: e.clientX, sy: e.clientY, view: { ...st.view } };
        canvas.style.cursor = 'grabbing';
        return;
      }

      if (toolRef.current === 'node') {
        const node = createGraphNode(wp.x, wp.y);
        pushHistory();
        st.items.push(node);
        st.selected = new Set([node.id]);
        setSelectionVersion(v => v + 1);
        draw();
        rerender();
        setTextInput({
          screenX: e.clientX,
          screenY: e.clientY,
          worldX: node.x + 14,
          worldY: node.y + 14,
          value: node.label,
          editingId: node.id,
        });
        return;
      }

      if (toolRef.current === 'edge') {
        const hit = hitTest(wp.x, wp.y);
        if (!hit || !isConnectable(hit)) {
          st.edgeDraft = null;
          draw();
          return;
        }
        if (!st.edgeDraft) {
          st.edgeDraft = { from: hit.id, to: wp };
          st.selected = new Set([hit.id]);
          setSelectionVersion(v => v + 1);
          draw();
          return;
        }
        if (st.edgeDraft.from !== hit.id) {
          pushHistory();
          st.items.splice(firstNodeIndex(st.items), 0, {
            id: `user-edge-${uid()}`,
            type: 'graphEdge',
            graphId: 'user',
            from: st.edgeDraft.from,
            to: hit.id,
            label: edgeTypeRef.current,
            layout: Math.abs(nodeCenter(findItem(st.edgeDraft.from)).x - nodeCenter(hit).x) >= Math.abs(nodeCenter(findItem(st.edgeDraft.from)).y - nodeCenter(hit).y) ? 'LR' : 'TD',
          });
          st.selected = new Set();
          st.edgeDraft = null;
          draw();
          rerender();
          setSelectionVersion(v => v + 1);
        }
        return;
      }

      if (toolRef.current === 'select') {
        const hit = hitTest(wp.x, wp.y);
        if (hit) {
          let sel = st.selected;
          if (e.shiftKey) {
            if (sel.has(hit.id)) sel.delete(hit.id); else sel.add(hit.id);
          } else if (!sel.has(hit.id)) {
            sel = new Set([hit.id]);
          }
          st.selected = expandToGroup(sel);
          const movable = [...st.selected].map(id => st.items.find(x => x.id === id)).filter(Boolean).filter(it => it.type !== 'graphEdge');
          if (movable.length === 0) {
            draw();
            return;
          }
          const startPos = new Map();
          for (const it of movable) {
            startPos.set(it.id, it.type === 'stroke' ? it.points.map(p => ({ ...p })) : { x: it.x, y: it.y });
          }
          st.dragging = { ids: movable.map(it => it.id), startPos, sx: wp.x, sy: wp.y, moved: false };
        } else {
          if (!e.shiftKey) st.selected = new Set();
          st.marquee = { x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
        }
        setSelectionVersion(v => v + 1);
        draw();
        return;
      }

      st.drawing = {
        id: uid(),
        type: 'stroke',
        color: colorRef.current,
        size: toolRef.current === 'eraser' ? sizeRef.current * 4 / st.view.scale : sizeRef.current / st.view.scale,
        erase: toolRef.current === 'eraser',
        points: [wp],
      };
      draw();
    };

    const onPointerMove = (e) => {
      const st = stateRef.current;
      const wp = worldFromScreen(e.clientX, e.clientY);
      if (st.panning) {
        st.view = {
          ...st.panning.view,
          x: st.panning.view.x + (e.clientX - st.panning.sx) / st.view.scale,
          y: st.panning.view.y + (e.clientY - st.panning.sy) / st.view.scale,
        };
        draw();
        return;
      }
      if (st.dragging) {
        const dx = wp.x - st.dragging.sx;
        const dy = wp.y - st.dragging.sy;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) st.dragging.moved = true;
        for (const id of st.dragging.ids) {
          const it = st.items.find(x => x.id === id);
          const start = st.dragging.startPos.get(id);
          if (!it || !start) continue;
          if (it.type === 'stroke') it.points = start.map(p => ({ x: p.x + dx, y: p.y + dy }));
          else { it.x = start.x + dx; it.y = start.y + dy; }
        }
        draw();
        return;
      }
      if (st.marquee) {
        st.marquee.x1 = wp.x;
        st.marquee.y1 = wp.y;
        draw();
        return;
      }
      if (st.edgeDraft) {
        st.edgeDraft.to = wp;
        draw();
        return;
      }
      if (st.drawing) {
        st.drawing.points.push(wp);
        draw();
        return;
      }
      if (toolRef.current === 'select' && !st.spaceDown) {
        const hit = hitTest(wp.x, wp.y);
        canvas.style.cursor = hit ? 'move' : 'default';
      }
    };

    const onPointerUp = (e) => {
      const st = stateRef.current;
      if (st.panning) {
        st.panning = null;
        canvas.style.cursor = cursorFor(toolRef.current, st.spaceDown);
        return;
      }
      if (st.dragging) {
        if (st.dragging.moved) pushHistory();
        st.dragging = null;
        rerender();
        return;
      }
      if (st.marquee) {
        const m = st.marquee;
        const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
        const picked = new Set(e.shiftKey ? st.selected : []);
        for (const it of st.items) {
          const b = boundsOf(it);
          if (b.minX >= x0 && b.maxX <= x1 && b.minY >= y0 && b.maxY <= y1) picked.add(it.id);
        }
        st.selected = expandToGroup(picked);
        st.marquee = null;
        setSelectionVersion(v => v + 1);
        draw();
        return;
      }
      if (st.drawing) {
        pushHistory();
        st.items.push(st.drawing);
        st.drawing = null;
        draw(); rerender();
      }
    };

    const onDoubleClick = (e) => {
      if (toolRef.current !== 'select') return;
      const wp = worldFromScreen(e.clientX, e.clientY);
      const hit = hitTest(wp.x, wp.y);
      if (!hit || !['text', 'graphNode', 'graphTitle', 'graphEdge'].includes(hit.type)) return;
      const value = hit.type === 'text' ? hit.text : hit.label;
      setTextInput({
        screenX: e.clientX,
        screenY: e.clientY,
        worldX: wp.x,
        worldY: wp.y,
        value: value || '',
        editingId: hit.id,
      });
    };

    const onWheel = (e) => {
      e.preventDefault();
      const st = stateRef.current;
      const newScale = Math.min(8, Math.max(0.1, st.view.scale * Math.exp(-e.deltaY * 0.0015)));
      const wx = e.clientX / st.view.scale - st.view.x;
      const wy = e.clientY / st.view.scale - st.view.y;
      st.view = { scale: newScale, x: e.clientX / newScale - wx, y: e.clientY / newScale - wy };
      setZoom(newScale);
      draw();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [draw, rerender, textInput]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const st = stateRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); savePng(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelection() : groupSelection(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
      if (e.code === 'Space') { st.spaceDown = true; canvasRef.current.style.cursor = 'grab'; return; }
      if (e.key.toLowerCase() === 'v') setTool('select');
      else if (e.key.toLowerCase() === 'p') setTool('pen');
      else if (e.key.toLowerCase() === 'e') setTool('eraser');
      else if (e.key.toLowerCase() === 't') activateTextTool();
      else if (e.key.toLowerCase() === 'n') setTool('node');
      else if (e.key.toLowerCase() === 'a') setTool('edge');
      else if (e.key.toLowerCase() === 'h') setTool('hand');
      else if (e.key === '[') setSize(s => Math.max(1, s - 1));
      else if (e.key === ']') setSize(s => Math.min(60, s + 1));
      else if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resetView(); }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') {
        stateRef.current.spaceDown = false;
        if (canvasRef.current) canvasRef.current.style.cursor = cursorFor(toolRef.current, false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (canvasRef.current) canvasRef.current.style.cursor = cursorFor(tool, stateRef.current.spaceDown);
    stateRef.current.edgeDraft = null;
    draw();
  }, [tool, draw]);

  const doUndo = () => {
    const st = stateRef.current;
    if (st.history.length === 0) return;
    st.future.push(snapshot());
    st.items = st.history.pop();
    st.selected = new Set();
    draw(); rerender(); setSelectionVersion(v => v + 1);
  };

  const doRedo = () => {
    const st = stateRef.current;
    if (st.future.length === 0) return;
    st.history.push(snapshot());
    st.items = st.future.pop();
    st.selected = new Set();
    draw(); rerender(); setSelectionVersion(v => v + 1);
  };

  const deleteSelection = () => {
    const st = stateRef.current;
    if (st.selected.size === 0) return;
    pushHistory();
    const rm = new Set(st.selected);
    for (const it of st.items) {
      if (it.type === 'graphEdge' && (rm.has(it.from) || rm.has(it.to))) rm.add(it.id);
    }
    st.items = st.items.filter(it => !rm.has(it.id));
    st.selected = new Set();
    draw(); rerender(); setSelectionVersion(v => v + 1);
  };

  const groupSelection = () => {
    const st = stateRef.current;
    if (st.selected.size < 2) return;
    pushHistory();
    const gid = 'g-' + uid();
    for (const it of st.items) if (st.selected.has(it.id)) it.groupId = gid;
    draw(); rerender();
  };

  const ungroupSelection = () => {
    const st = stateRef.current;
    pushHistory();
    for (const it of st.items) if (st.selected.has(it.id)) delete it.groupId;
    draw(); rerender();
  };

  const clearAll = () => {
    if (!confirm('すべて消去しますか？')) return;
    const st = stateRef.current;
    pushHistory();
    st.items = [];
    st.selected = new Set();
    ingestedGraphIdsRef.current.clear();
    draw(); rerender(); setSelectionVersion(v => v + 1);
  };

  const resetView = () => {
    stateRef.current.view = { x: 0, y: 0, scale: 1 };
    setZoom(1); draw();
  };

  const setZoomLevel = (factor) => {
    const st = stateRef.current;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const wx = cx / st.view.scale - st.view.x;
    const wy = cy / st.view.scale - st.view.y;
    const scale = Math.min(8, Math.max(0.1, st.view.scale * factor));
    st.view = { scale, x: cx / scale - wx, y: cy / scale - wy };
    setZoom(scale); draw();
  };

  const savePng = () => {
    const canvas = canvasRef.current;
    const link = document.createElement('a');
    link.download = `whiteboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const commitText = () => {
    const value = textInput?.value.trim();
    if (textInput?.editingId) {
      if (value) {
        pushHistory();
        const it = findItem(textInput.editingId);
        if (it?.type === 'text') it.text = value;
        else if (it) it.label = value;
        draw(); rerender();
      }
      setTextInput(null);
      return;
    }
    if (value) {
      pushHistory();
      stateRef.current.items.push({
        id: uid(),
        type: 'text',
        x: textInput.worldX,
        y: textInput.worldY,
        text: value,
        color,
        size: Math.max(18, size * 5),
      });
      draw(); rerender();
    }
    setTextInput(null);
  };

  const activateTextTool = () => {
    setTool('text');
    if (!textInput) {
      openTextInputAt(window.innerWidth / 2 - 80, window.innerHeight / 2 - 18);
    }
  };

  const createGraphNode = (x, y) => ({
    id: `user-node-${uid()}`,
    type: 'graphNode',
    graphId: 'user',
    x: x - 78,
    y: y - 37,
    w: 156,
    h: 74,
    label: '新しいノード',
    kind: 'claim',
    fill: NODE_COLORS.claim,
    fontSize: 17,
  });

  const st = stateRef.current;
  const selectedItems = [...st.selected].map(id => st.items.find(x => x.id === id)).filter(Boolean);
  const canGroup = selectedItems.length >= 2;
  const canUngroup = selectedItems.some(it => it.groupId);
  const canDelete = selectedItems.length > 0;
  void selectionVersion;

  return (
    <div className="board-root">
      <canvas ref={canvasRef} className="board" />

      <div className={`stream-indicator ${connected ? 'on' : 'off'}`}>
        <span className="dot" />
        <span>{connected ? 'LIVE' : 'OFFLINE'}</span>
      </div>

      {textInput && (
        <textarea
          ref={(el) => { textareaRef.current = el; }}
          autoFocus
          className="text-input"
          style={{
            left: textInput.screenX,
            top: textInput.screenY,
            color,
            fontSize: Math.max(18, size * 5) * st.view.scale + 'px',
            lineHeight: 1.3,
          }}
          value={textInput.value}
          onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
            else if (e.key === 'Escape') { e.preventDefault(); setTextInput(null); }
          }}
          onBlur={commitText}
          rows={1}
        />
      )}

      <div className="toolbar">
        <ToolBtn active={tool === 'select'} onClick={() => setTool('select')} tooltip="選択 (V)">
          <Icon><path d="M3 3l7.5 17.5 2.5-8 8-2.5L3 3z"/></Icon>
        </ToolBtn>
        <ToolBtn active={tool === 'pen'} onClick={() => setTool('pen')} tooltip="ペン (P)">
          <Icon><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></Icon>
        </ToolBtn>
        <ToolBtn active={tool === 'eraser'} onClick={() => setTool('eraser')} tooltip="消しゴム (E)">
          <Icon><path d="M20 20H7L3 16a2 2 0 010-2.83l10-10a2 2 0 012.83 0l5.66 5.66a2 2 0 010 2.83L11.41 20"/><path d="M18 13l-6-6"/></Icon>
        </ToolBtn>
        <ToolBtn active={tool === 'text'} onClick={activateTextTool} tooltip="テキスト (T)">
          <Icon><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></Icon>
        </ToolBtn>
        <ToolBtn active={tool === 'node'} onClick={() => setTool('node')} tooltip="ノード追加 (N)">
          <Icon><rect x="4" y="5" width="16" height="12" rx="3"/><path d="M12 9v4M10 11h4"/></Icon>
        </ToolBtn>
        <ToolBtn active={tool === 'edge'} onClick={() => setTool('edge')} tooltip="矢印追加: ノード/テキスト (A)">
          <Icon><path d="M5 12h13"/><path d="M14 7l5 5-5 5"/><circle cx="5" cy="12" r="2"/></Icon>
        </ToolBtn>
        <select
          className="edge-type-select"
          value={edgeType}
          onChange={(e) => setEdgeType(e.target.value)}
          title="矢印の意味"
        >
          {EDGE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
        <ToolBtn active={tool === 'hand'} onClick={() => setTool('hand')} tooltip="移動 (H / Space)">
          <Icon>
            <path d="M5.5 11.5v4.2A6.8 6.8 0 0012.3 22h1.2a5.8 5.8 0 005-2.8l3.1-5.4a2 2 0 00-.8-2.7 2 2 0 00-2.7.8L16 15.4V7.2a1.8 1.8 0 00-3.6 0v4.6"/>
            <path d="M12.4 11.8V5.5a1.8 1.8 0 00-3.6 0v6.3"/>
            <path d="M8.8 11.8V7.2a1.8 1.8 0 00-3.6 0v8"/>
            <path d="M16 11.8V8.4a1.8 1.8 0 013.6 0v3.2"/>
          </Icon>
        </ToolBtn>

        <div className="divider" />
        <div className="color-row">
          {COLORS.map(c => (
            <button key={c} className={`color ${color === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => { setColor(c); if (tool === 'eraser') setTool('pen'); }} />
          ))}
        </div>
        <div className="divider" />
        <div className="size-wrap">
          <div className="size-preview">
            <div className="size-dot" style={{ width: Math.min(size, 18) + 'px', height: Math.min(size, 18) + 'px', background: color }} />
          </div>
          <input className="size" type="range" min="1" max="60" value={size}
            style={{ '--p': ((size - 1) / 59 * 100) + '%' }}
            onChange={(e) => setSize(parseInt(e.target.value, 10))} />
        </div>
        <div className="divider" />
        <ToolBtn disabled={!canGroup} onClick={groupSelection} tooltip="グループ化 (Ctrl+G)">
          <Icon><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>
        </ToolBtn>
        <ToolBtn disabled={!canUngroup} onClick={ungroupSelection} tooltip="グループ解除 (Ctrl+Shift+G)">
          <Icon><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 7h4M7 10v4"/></Icon>
        </ToolBtn>
        <ToolBtn disabled={!canDelete} onClick={deleteSelection} tooltip="削除 (Del)">
          <Icon><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></Icon>
        </ToolBtn>
        <div className="divider" />
        <ToolBtn disabled={st.history.length === 0} onClick={doUndo} tooltip="元に戻す (Ctrl+Z)">
          <Icon><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-15-6.7L3 13"/></Icon>
        </ToolBtn>
        <ToolBtn disabled={st.future.length === 0} onClick={doRedo} tooltip="やり直す (Ctrl+Y)">
          <Icon><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0115-6.7L21 13"/></Icon>
        </ToolBtn>
        <ToolBtn onClick={clearAll} tooltip="クリア">
          <Icon><path d="M21 6H8M21 12H8M21 18H8"/><path d="M3 6l2 2-2 2M3 12l2 2-2 2"/></Icon>
        </ToolBtn>
        <div className="divider" />
        <ToolBtn onClick={savePng} tooltip="PNG保存 (Ctrl+S)">
          <Icon><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></Icon>
        </ToolBtn>
        <div className="divider" />
        <button
          className={`tool mic ${listening ? 'listening' : ''}`}
          onClick={() => (listening ? stopSpeech() : startSpeech())}
          data-tooltip={listening ? '録音停止' : 'マイク開始'}
          title={speechError || ''}
        >
          {listening ? (
            <Icon><rect x="6" y="6" width="12" height="12" rx="2"/></Icon>
          ) : (
            <Icon><path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></Icon>
          )}
        </button>
      </div>

      <div className="hint">矢印は種別を選んでから A で接続 · ノード/テキストを動かすと矢印も追従</div>
      <div className="bottom-bar">
        <button className="tool" onClick={() => setZoomLevel(1/1.2)} data-tooltip="縮小"><Icon><line x1="5" y1="12" x2="19" y2="12"/></Icon></button>
        <div className="zoom-label">{Math.round(zoom * 100)}%</div>
        <button className="tool" onClick={() => setZoomLevel(1.2)} data-tooltip="拡大"><Icon><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></Icon></button>
        <div className="divider" />
        <button className="tool" onClick={resetView} data-tooltip="ビューリセット (Ctrl+0)"><Icon><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="15"/></Icon></button>
      </div>
    </div>
  );
}

function graphToCanvasItems(graph, index) {
  const col = index % 2;
  const row = Math.floor(index / 2);
  const baseX = 80 + col * 700;
  const baseY = 80 + row * 430;
  const groupId = `graph-${graph.id}`;
  const nodeMap = new Map();
  const layout = graph.layout === 'LR' ? 'LR' : 'TD';
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const positions = layoutGraph(nodes, edges, layout);

  const title = {
    id: `${groupId}-title`,
    type: 'graphTitle',
    graphId: graph.id,
    groupId,
    x: baseX,
    y: baseY,
    w: 330,
    h: 62,
    label: graph.title || '発言の構造',
    speaker: graph.speaker || 'Speaker',
  };

  const canvasNodes = nodes.map((node) => {
    const pos = positions.get(node.id) || { x: 0, y: 0 };
    const item = {
      id: `${groupId}-n-${node.id}`,
      type: 'graphNode',
      graphId: graph.id,
      groupId,
      sourceNodeId: node.id,
      x: baseX + pos.x,
      y: baseY + 95 + pos.y,
      w: 156,
      h: 74,
      label: node.label || '',
      kind: node.kind || 'claim',
      fill: NODE_COLORS[node.kind] || NODE_COLORS.claim,
      fontSize: 17,
    };
    nodeMap.set(node.id, item.id);
    return item;
  });

  const canvasEdges = edges
    .filter(edge => nodeMap.has(edge.from) && nodeMap.has(edge.to))
    .map((edge, i) => ({
      id: `${groupId}-e-${i}`,
      type: 'graphEdge',
      graphId: graph.id,
      groupId,
      from: nodeMap.get(edge.from),
      to: nodeMap.get(edge.to),
      label: edge.label || '',
      layout,
    }));

  return [title, ...canvasEdges, ...canvasNodes];
}

function layoutGraph(nodes, edges, layout) {
  const ids = nodes.map(node => node.id);
  const incoming = new Map(ids.map(id => [id, 0]));
  const outgoing = new Map(ids.map(id => [id, []]));
  edges.forEach(edge => {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) return;
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  });
  const roots = ids.filter(id => incoming.get(id) === 0);
  const order = roots.length ? roots : ids.slice(0, 1);
  const depth = new Map(ids.map(id => [id, 0]));
  for (let p = 0; p < order.length; p++) {
    const id = order[p];
    for (const next of outgoing.get(id) || []) {
      depth.set(next, Math.max(depth.get(next) || 0, (depth.get(id) || 0) + 1));
      if (!order.includes(next)) order.push(next);
    }
  }
  ids.forEach(id => { if (!order.includes(id)) order.push(id); });
  const lanes = new Map();
  const positions = new Map();
  for (const id of order) {
    const d = depth.get(id) || 0;
    const lane = lanes.get(d) || 0;
    lanes.set(d, lane + 1);
    if (layout === 'LR') positions.set(id, { x: d * 205, y: lane * 104 });
    else positions.set(id, { x: lane * 205, y: d * 112 });
  }
  return positions;
}

function ToolBtn({ active, disabled, onClick, tooltip, children }) {
  return (
    <button className={`tool ${active ? 'active' : ''}`} disabled={disabled}
      onClick={onClick} data-tooltip={tooltip}>{children}</button>
  );
}

function cursorFor(tool, spaceDown) {
  if (spaceDown || tool === 'hand') return 'grab';
  if (tool === 'text') return 'text';
  if (tool === 'node') return 'copy';
  if (tool === 'edge') return 'crosshair';
  if (tool === 'eraser') return 'cell';
  if (tool === 'select') return 'default';
  return 'crosshair';
}

function firstNodeIndex(items) {
  const index = items.findIndex(it => it.type === 'graphNode' || it.type === 'text' || it.type === 'stroke');
  return index < 0 ? items.length : index;
}

function isConnectable(item) {
  return item?.type === 'graphNode' || item?.type === 'text';
}

function nodeCenter(node) {
  if (node.type === 'text') {
    const b = textBounds(node);
    return { x: b.minX + (b.maxX - b.minX) / 2, y: b.minY + (b.maxY - b.minY) / 2 };
  }
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function pointOnRect(node, dx, dy) {
  if (node.type === 'text') {
    const b = textBounds(node);
    return pointOnBounds(b, dx, dy);
  }
  return pointOnBounds({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.w,
    maxY: node.y + node.h,
  }, dx, dy);
}

function pointOnBounds(bounds, dx, dy) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const cx = bounds.minX + w / 2;
  const cy = bounds.minY + h / 2;
  const scale = Math.min(Math.abs((w / 2) / (dx || 0.0001)), Math.abs((h / 2) / (dy || 0.0001)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function textBounds(item) {
  const lines = String(item.text || '').split('\n');
  const width = Math.max(...lines.map(line => approximateTextWidth(line, item.size)), 1);
  return {
    minX: item.x,
    minY: item.y,
    maxX: item.x + width,
    maxY: item.y + lines.length * item.size * 1.3,
  };
}

function approximateTextWidth(text, size) {
  let units = 0;
  for (const ch of String(text || '')) units += /[ -~]/.test(ch) ? 0.58 : 1;
  return units * size;
}

function drawArrow(ctx, control, end, seed) {
  const angle = Math.atan2(end.y - control.y, end.x - control.x);
  const len = 13;
  const spread = 0.55;
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - Math.cos(angle - spread) * len + jitter(seed, 9, 1.5), end.y - Math.sin(angle - spread) * len + jitter(seed, 10, 1.5));
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - Math.cos(angle + spread) * len + jitter(seed, 11, 1.5), end.y - Math.sin(angle + spread) * len + jitter(seed, 12, 1.5));
  ctx.stroke();
}

function roughLine(ctx, x1, y1, x2, y2, seed) {
  ctx.beginPath();
  ctx.moveTo(x1 + jitter(seed, 0, 1.5), y1 + jitter(seed, 1, 1.5));
  ctx.lineTo(x2 + jitter(seed, 2, 1.5), y2 + jitter(seed, 3, 1.5));
  ctx.stroke();
}

function roughRoundRect(ctx, x, y, w, h, r, seed) {
  const j = (n) => jitter(seed, n, 2.4);
  ctx.beginPath();
  ctx.moveTo(x + r + j(1), y + j(2));
  ctx.lineTo(x + w - r + j(3), y + j(4));
  ctx.quadraticCurveTo(x + w + j(5), y + j(6), x + w + j(7), y + r + j(8));
  ctx.lineTo(x + w + j(9), y + h - r + j(10));
  ctx.quadraticCurveTo(x + w + j(11), y + h + j(12), x + w - r + j(13), y + h + j(14));
  ctx.lineTo(x + r + j(15), y + h + j(16));
  ctx.quadraticCurveTo(x + j(17), y + h + j(18), x + j(19), y + h - r + j(20));
  ctx.lineTo(x + j(21), y + r + j(22));
  ctx.quadraticCurveTo(x + j(23), y + j(24), x + r + j(25), y + j(26));
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const chars = String(text || '').split('');
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (chars.length && lines.join('').length < chars.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/.$/, '…');
  }
  return lines.length ? lines : [''];
}

function jitter(seed, salt, amount) {
  const str = `${seed}:${salt}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 1000) / 500 - 1) * amount;
}
