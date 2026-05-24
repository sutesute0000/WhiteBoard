// Azure OpenAI client.
// Uses the official openai SDK in Azure mode. If no endpoint/key is configured,
// returns a stub that does nothing (so the rest of the system still works in dev).

import { AzureOpenAI } from 'openai';
import { config } from './config.js';

let client = null;
function getClient() {
  if (client) return client;
  if (!config.azureOpenAIEndpoint || !config.azureOpenAIKey) return null;
  client = new AzureOpenAI({
    endpoint: config.azureOpenAIEndpoint,
    apiKey: config.azureOpenAIKey,
    apiVersion: config.azureOpenAIApiVersion,
    deployment: config.azureOpenAIDeployment,
  });
  return client;
}

const SYSTEM_PROMPT = `あなたは会議発言を1ターンごとに読み、その発言の論理構造を編集可能な図データとして可視化するエージェントです。

# 仕事
入力の newTurns に含まれる各発言ターンごとに、必ず 1 つの図を作ってください。
文章要約カードや画像ではなく、ノードとエッジからなる構造化データとして表現します。

# 図の選び方
- 時系列、段階、ロードマップ、手順: timeline、layout は LR
- 主張と理由、結論と根拠: logic、layout は TD
- 比較、選択肢、メリット/リスク: comparison、layout は TD
- 課題と対応策: logic または cause、layout は TD
- 担当・宿題・アクション: action、layout は LR
- 因果関係: cause、layout は LR

# 作図手順
1. まず発言を、独立して真偽や実行可否を判断できる 2〜6 個の命題に分解する。
2. 各命題を claim / reason / step / option / risk / action / result / issue のどれかに分類する。
3. 発話順ではなく、命題どうしの論理関係を優先してエッジを作る。
4. 関係が不明な命題は、無理に接続しない。根拠のないエッジより、孤立ノードの方がよい。
5. 1つの発言に複数論点が混ざる場合は、中心論点を1つ選び、周辺論点は必要最小限にする。

# 使用できるエッジ種別
edge.label は必ず次のいずれかにしてください。
- 理由: AがBの理由である
- 結果: Aの結果としてBが起きる
- 比較・対立: AとBが比較・対立している
- 前提: AがBの前提条件である
- 具体化: BがAを具体化している
- 例: BがAの例である
- リスク: AがBというリスクを生む
- 提案: Aを踏まえてBを提案している
- 結論: Aを踏まえてBという結論に至る
- 範囲: BがAの対象範囲に含まれる
- 範囲外: BがAの対象範囲から除外される
- 時系列: AのあとにBが発生

# エッジ方向の厳守
- 理由: reason -> claim/result/action
- 前提: issue/claim/step -> action/result
- 結論: reason/claim/premise -> result/claim
- 提案: issue/reason/claim -> action
- リスク: issue/action/claim -> risk
- 結果: action/claim/step -> result
- 具体化: abstract claim/issue -> concrete claim/action/step
- 例: concept claim/issue -> example
- 範囲: container/concept -> included target
- 範囲外: container/concept -> excluded target
- 時系列: earlier step -> later step
- 比較・対立: 比較元 -> 比較先。優劣や採否がある場合は、採用/結論ノードへ 結論 または 提案 で接続する。

# 品質チェック
- edge.label の意味を自然文で読んだとき、「from が to の <label> である」と読める向きにする。
- claim -> reason の「理由」エッジは禁止。理由は必ず reason 側から claim 側へ向ける。
- action -> issue の「提案」エッジは禁止。提案は issue/reason/claim 側から action 側へ向ける。
- risk へ入るエッジは原則「リスク」。risk から claim へ「理由」を張らない。
- ノードラベルは発言の一部をそのまま切り出さず、命題として短く言い換える。
- 迷った場合は、少ないノード・少ないエッジを選ぶ。

# 厳守事項
1. 1発言につき add_graph を1件返す。雑談や相槌だけなら ops に含めない。
2. 発言の逐語転記は禁止。ノード文言は短い日本語ラベルにする。
3. ノードIDは A, B, C1 のような ASCII のみ。
4. ノード数は 2〜6 個を目安にし、長い文章をそのまま入れない。
5. 発言者名は speaker フィールドに入れる。図ノードには発言者名を重複して入れない。
6. edge label は上記の使用できるエッジ種別から選ぶ。自由文は禁止。

# 出力フォーマット。厳格JSON、コメント不可
{
  "ops": [
    {
      "op": "add_graph",
      "turnId": "<turn id>",
      "speaker": "<speaker>",
      "title": "<図の短いタイトル>",
      "diagramType": "timeline|logic|comparison|action|cause",
      "layout": "LR|TD",
      "nodes": [
        { "id": "A", "label": "<短いラベル>", "kind": "claim|reason|step|option|risk|action|result|issue" }
      ],
      "edges": [
        { "from": "A", "to": "B", "label": "理由|結果|比較・対立|前提|具体化|例|リスク|提案|結論|範囲|範囲外|時系列" }
      ]
    }
  ],
  "rationale": "<図の選択理由を短く>"
}`;

export async function callLLM({ board, summaries, newTurns, recentTurns }) {
  const c = getClient();
  const userPayload = {
    board: {
      items: board.map(it => ({
        id: it.id,
        type: it.type,
        text: it.text,
        title: it.title,
        speaker: it.speaker,
        diagramType: it.diagramType,
        nodes: it.nodes,
        edges: it.edges,
        layout: it.layout,
        author: it.author,
        status: it.status,
        pinned: !!it.pinned,
      })),
    },
    summaries, // { sectionName: [{text}] }
    recentTurns: recentTurns.map(t => ({ speaker: t.speaker, text: t.text })),
    newTurns: newTurns.map(t => ({ id: t.id, speaker: t.speaker, text: t.text })),
  };

  if (!c) {
    console.log('[llm:stub] would call LLM with', newTurns.length, 'new turns (endpoint/key 未設定)');
    return fallbackDiff(newTurns, 'LLM未設定');
  }

  try {
    const resp = await c.chat.completions.create({
      model: config.azureOpenAIDeployment,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    const content = resp.choices?.[0]?.message?.content || '{"ops":[]}';
    console.log('[llm] raw response:', content.slice(0, 300));
    try {
      return JSON.parse(content);
    } catch (e) {
      console.error('[llm] JSON parse failed:', content);
      return { ops: [], rationale: '(parse error)' };
    }
  } catch (e) {
    console.error('[llm] API call failed:', e?.status, e?.message);
    if (e?.error) console.error('[llm] error detail:', JSON.stringify(e.error).slice(0, 400));
    return fallbackDiff(newTurns, 'api error: ' + (e?.message || 'unknown'));
  }
}

function fallbackDiff(turns, reason) {
  if (!config.llmFallback) {
    return { ops: [], rationale: `(${reason}: fallback disabled)` };
  }
  const ops = [];
  for (const turn of turns) {
    const diagram = fallbackDiagram(turn);
    if (!diagram) continue;
    ops.push({
      op: 'add_graph',
      turnId: turn.id,
      speaker: turn.speaker,
      title: diagram.title,
      diagramType: diagram.diagramType,
      layout: diagram.layout,
      nodes: diagram.nodes,
      edges: diagram.edges,
    });
  }
  return {
    ops,
    rationale: `(${reason}: dev fallbackで${ops.length}件生成)`,
  };
}

function fallbackDiagram(turn) {
  const clean = String(turn.text || '')
    .replace(/\s+/g, ' ')
    .replace(/[「」]/g, '')
    .trim();
  if (!clean) return '';
  const parts = splitUtterance(clean).slice(0, 5);
  const labels = (parts.length ? parts : [clean]).map(shortLabel);
  if (/次|まず|その後|最後|段階|フェーズ|短期|中期|長期|ロードマップ/.test(clean)) {
    return makeGraph('時系列整理', 'timeline', 'LR', labels, 'step');
  }
  if (/理由|なぜ|ため|なので|だから|根拠|背景/.test(clean)) {
    return {
      title: '主張と理由',
      diagramType: 'logic',
      layout: 'TD',
      nodes: [
        { id: 'A', label: labels[0] || '主張', kind: 'claim' },
        { id: 'B', label: labels[1] || '理由', kind: 'reason' },
        { id: 'C', label: labels[2] || '結論', kind: 'result' },
      ],
      edges: [
        { from: 'B', to: 'A', label: '理由' },
        { from: 'A', to: 'C', label: '結論' },
      ],
    };
  }
  if (/担当|宿題|確認|作成|共有|依頼|対応/.test(clean)) {
    return {
      title: 'アクション整理',
      diagramType: 'action',
      layout: 'LR',
      nodes: [
        { id: 'A', label: turn.speaker || '担当', kind: 'option' },
        { id: 'B', label: labels[0] || '作業', kind: 'action' },
        { id: 'C', label: labels[1] || '成果物', kind: 'result' },
      ],
      edges: [
        { from: 'A', to: 'B', label: '提案' },
        { from: 'B', to: 'C', label: '結果' },
      ],
    };
  }
  return makeGraph('論理構造', 'logic', 'TD', labels, 'claim');
}

function makeGraph(title, diagramType, layout, labels, kind) {
  const nodes = labels.map((label, i) => ({
    id: nodeId(i),
    label,
    kind: i === labels.length - 1 && labels.length > 1 ? 'result' : kind,
  }));
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, label: diagramType === 'timeline' ? '時系列' : '結果' });
  }
  return { title, diagramType, layout, nodes, edges };
}

function splitUtterance(text) {
  const bySentence = String(text || '').split(/[。！？!?]/).map(s => s.trim()).filter(Boolean);
  const parts = [];
  for (const sentence of bySentence.length ? bySentence : [text]) {
    const chunks = sentence
      .replace(/(まず|次に|その後|最後に|短期は|中期は|長期は)/g, '。$1')
      .split('。')
      .map(s => s.trim())
      .filter(Boolean);
    parts.push(...chunks);
  }
  return parts.length ? parts : [String(text || '').trim()].filter(Boolean);
}

function nodeId(i) {
  return String.fromCharCode(65 + i);
}

function shortLabel(text) {
  const value = String(text || '').trim();
  return value.length > 22 ? value.slice(0, 21) + '...' : value;
}

const SUMMARIZE_SYSTEM = `あなたは会議ホワイトボードの特定セクションを圧縮するエージェントです。
入力として渡されるアイテム群を、論旨を保ったまま 2〜3行の要点に再構成してください。
出力は JSON: { "summary": "<2-3行の要点>" }。逐語転記は不要、固有名詞・数値は保持。`;

export async function summarizeSection({ section, items }) {
  const c = getClient();
  if (!c) return { summary: items.map(i => '・' + i.text).join('\n') };
  const resp = await c.chat.completions.create({
    model: config.azureOpenAIDeployment,
    messages: [
      { role: 'system', content: SUMMARIZE_SYSTEM },
      { role: 'user', content: JSON.stringify({ section, items: items.map(i => ({ text: i.text })) }) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });
  try {
    return JSON.parse(resp.choices?.[0]?.message?.content || '{"summary":""}');
  } catch {
    return { summary: '' };
  }
}
