// Turn buffer
// - 同一話者の連続発言は 1 ターンに集約
// - 別話者の発言が来たとき、その発言が minTurnChars 以上なら「話者交代確定」とみなし
//   現在のターンを emit、新話者でターン開始
// - 短い相槌 (< minTurnChars) は emit せず、現在ターンの末尾に [話者: 内容] として
//   注記して文脈を残す
// - 無音時間だけでは emit しない
// - flush() で残りを強制 emit

import { config } from './config.js';

function uid() { return 't-' + Math.random().toString(36).slice(2, 10); }

export function createTurnBuffer({ onTurn }) {
  let current = null; // { speaker, speakerId?, source?, meetingId?, text, startedAt }

  function emit() {
    if (!current) return;
    const text = current.text.trim();
    if (text.length >= config.minTurnChars) {
      const turn = {
        id: uid(),
        speaker: current.speaker,
        speakerId: current.speakerId || null,
        source: current.source || 'manual',
        meetingId: current.meetingId || null,
        text,
        startedAt: current.startedAt,
        endedAt: Date.now(),
      };
      console.log('[turn.emit]', turn.speaker, turn.speakerId || '-', text.slice(0, 80));
      onTurn(turn);
    }
    current = null;
  }

  function add({ speaker, speakerId, source = 'manual', meetingId = null, text, at = Date.now() }) {
    const clean = (text || '').trim();
    if (!clean) return;

    if (!current) {
      current = { speaker, speakerId, source, meetingId, text: clean, startedAt: at };
      return;
    }
    if (current.speaker === speaker) {
      current.text += '\n' + clean;
      return;
    }
    // 別話者
    if (clean.length < config.minTurnChars) {
      // 短い相槌として現ターンに注記
      current.text += ` [${speaker}: ${clean}]`;
      return;
    }
    // 話者交代を確定
    emit();
    current = { speaker, speakerId, source, meetingId, text: clean, startedAt: at };
  }

  function flush() { emit(); }

  return { add, flush };
}
