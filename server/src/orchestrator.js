// Orchestrates LLM calls.
// - A single in-flight LLM call at any time.
// - While in-flight, additional turns queue up and are coalesced into the next call.
// - After each successful diff apply, checks if "stable" sections grew large enough
//   to summarize (compression).

import { callLLM, summarizeSection } from './llm.js';
import { config } from './config.js';

export function createOrchestrator(store) {
  let inflight = false;
  let queuedTurns = [];
  let lastCallAt = 0;
  let coolingTimer = null;

  async function enqueueTurn(turn) {
    store.addTurn(turn);
    queuedTurns.push(turn);
    schedule();
  }

  async function schedule() {
    if (inflight) return;
    if (queuedTurns.length === 0) return;
    // 前回呼び出しから最低 llmMinIntervalMs 経過するまで待機
    const wait = Math.max(0, lastCallAt + config.llmMinIntervalMs - Date.now());
    if (wait > 0) {
      if (coolingTimer) return; // 既に待機中
      coolingTimer = setTimeout(() => {
        coolingTimer = null;
        schedule();
      }, wait);
      console.log(`[orch] cooldown ${wait}ms (queued=${queuedTurns.length})`);
      return;
    }
    inflight = true;
    lastCallAt = Date.now();
    const batch = queuedTurns;
    queuedTurns = [];
    try {
      const board = store.listItems();
      const summaries = store.getBoard().summaries;
      const recent = store.recentTurns(6);
      const result = await callLLM({
        board,
        summaries,
        newTurns: batch,
        recentTurns: recent.filter(t => !batch.find(b => b.id === t.id)),
      });
      console.log('[orch] rationale:', result.rationale || '(none)', 'ops:', (result.ops || []).length);
      const applied = store.applyDiff(result.ops || [], 'ai');
      store.markTurnsProcessed(batch.map(t => t.id));
      // Post-step: summarize stable sections if grown.
      await maybeSummarize();
    } catch (e) {
      console.error('[orch] LLM call failed', e);
    } finally {
      inflight = false;
      if (queuedTurns.length > 0) setImmediate(schedule);
    }
  }

  async function maybeSummarize() {
    for (const section of config.stableSections) {
      const items = store.listItems().filter(it => it.section === section && it.author === 'ai' && it.status !== 'tentative');
      if (items.length < config.sectionSummarizeThreshold) continue;
      try {
        const { summary } = await summarizeSection({ section, items });
        if (!summary) continue;
        // Replace items with a single summary entry stored in summaries map,
        // and remove the original AI items (only those, not human).
        store.setSummary(section, summary, items.map(i => i.id));
        // Remove the underlying AI items
        store.applyDiff(items.map(it => ({ op: 'remove', id: it.id })), 'ai');
      } catch (e) {
        console.error('[orch] summarize failed', e);
      }
    }
  }

  function status() {
    return { inflight, queued: queuedTurns.length };
  }

  return { enqueueTurn, status };
}
