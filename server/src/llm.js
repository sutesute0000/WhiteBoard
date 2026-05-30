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
1. まず発言を分割し、発言の中で真偽・評価・判断対象になっている最小単位の”命題”を作成する。
2. 各命題を claim / reason / step / option / risk / action / result / issue のどれかに分類する。
3. 発話順ではなく、命題どうしの論理関係を優先してエッジを作る。
4. 関係が不明な命題は、無理に接続しない。根拠のないエッジより、孤立ノードの方がよい。
5. 1つの発言に複数論点が混ざる場合は、中心論点を1つ選び、周辺論点は必要最小限にする。

# エッジ種別
edge.label は、原則として次の固定ラベルのみを使用してください。

- 原因: AがBの原因である
- 結果: AからBが生じる
- 根拠: AがBを根拠として支えている
- 反論: AがBに反論・懸念を示している
- 条件: AがBの成立条件である
- 制約: AがBを制約している
- 選択肢: AがBに対する選択肢である
- 比較: AとBを比較している
- 対応: Aに対してBで対応する
- 含む: AがBを範囲・概念として含む
- 順序: Aの次にBが来る

# 自由ラベル
固定ラベルで正確に表せない場合のみ、2〜8文字程度の短い日本語ラベルを自由記述してよい。

自由ラベルの条件:
- 動詞句または関係名にする
- 長文説明は禁止
- 固定ラベルで代替できる場合は禁止
- 同じ意味の自由ラベルを乱立させない

# エッジ方向の厳守
- 原因: 原因 -> 結果
- 結果: 起点・出来事 -> 結果
- 根拠: 根拠・理由 -> 主張・判断・結論
- 反論: 懸念・反対意見・課題 -> 対象の主張・案
- 条件: 条件・前提 -> 成立する行動・結果・主張
- 制約: 制約・リスク -> 制約される行動・選択肢
- 選択肢: 選択肢 -> 解くべき課題・判断対象
- 比較: 比較元 -> 比較先
- 対応: 課題・理由・条件 -> 対応策・行動
- 含む: 範囲・上位概念 -> 含まれる対象
- 順序: 先に起きる手順・出来事 -> 次の手順・出来事

# 品質チェック
- edge.label の意味を自然文で読んだとき、「from が to に対して <label> の関係である」と読める向きにする。
- claim -> reason の「根拠」エッジは禁止。根拠は必ず reason 側から claim 側へ向ける。
- action -> issue の「対応」エッジは禁止。対応は issue/reason/claim/condition 側から action 側へ向ける。
- risk へ入るエッジは原則「原因」「結果」「制約」のいずれかにする。
- ノードラベルは発言の逐語転記ではなく、短い命題として言い換える。
- 迷った場合は、少ないノード・少ないエッジを選ぶ。

# 厳守事項
1. 1発言につき add_graph を1件返す。雑談や相槌だけなら ops に含めない。
2. 発言の逐語転記は禁止。ノード文言は短い日本語ラベルにする。
3. ノードIDは A, B, C1 のような ASCII のみ。
4. ノード数は 2〜6 個を目安にし、長い文章をそのまま入れない。
5. 発言者名は speaker フィールドに入れる。図ノードには発言者名を重複して入れない。
6. edge label は推奨エッジ種別を優先する。合わない場合だけ短い自由記述ラベルを使う。

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
        { "from": "A", "to": "B", "label": "原因|結果|根拠|反論|条件|制約|選択肢|比較|対応|含む|順序|短い自由記述" }
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
        { from: 'B', to: 'A', label: '根拠' },
        { from: 'A', to: 'C', label: '結果' },
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
        { from: 'A', to: 'B', label: '対応' },
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
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, label: diagramType === 'timeline' ? '順序' : '結果' });
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
