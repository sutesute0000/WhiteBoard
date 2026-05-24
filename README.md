# Realtime Whiteboard Agent

会議の文字起こしをリアルタイムに LLM 処理し、参加者の「共通認識」をホワイトボード上に可視化するエージェント。Microsoft Agent Hackathon 2026 用構成（Azure OpenAI + Azure Container Apps）。

## アーキテクチャ

```
[文字起こしストリーム]
  - ローカル検証: meeting_log_revised.txt のサンプル投入
  - ブラウザ検証: Azure Speech + マイク
  - 実運用想定: Teams audio ingestor / Teams media bot
       │
       ▼
   Turn Buffer       (話者IDの変化＋短発言ゲートで 1 ターン確定)
       │
       ▼
   Orchestrator      (in-flight ロック＋未処理ターンの coalesce)
       │
       ▼
   Azure OpenAI      (現在の盤面 + 新ターン → 構造化 diff JSON)
       │
       ▼
   Store + SSE       (差分配信 → フロント反映)
       │
       ▼
   Whiteboard UI     (AI カード / tentative→人間が確定)
```

### 主な設計判断

| 領域 | 方針 |
|---|---|
| トリガ | 話者IDの変化で話者交代を検出（次話者の発言が 20 文字以上で前ターン emit） |
| 短発言 | 相槌は破棄せず、現ターンに `[話者: 内容]` として注記 |
| LLM 入力 | 盤面の全アイテム（human/ai 種別と status 含む）+ 直近 6 ターン + 新ターン |
| LLM 出力 | `{ops:[{op:add_graph,nodes,edges,...}], rationale}` |
| 人 vs AI | `author:'human'` / `status:'confirmed'` / `pinned:true` の AI 書き換え禁止（バックエンドで強制） |
| 図化 | 1発言ターンごとに、編集可能なノード/エッジの図を生成 |
| 話者 | 実名特定は必須ではない。`speakerId` を `Speaker 1` のような安定匿名ラベルに正規化 |
| 抽出粒度 | 逐語転記しない。短いノードラベルと意味つきエッジで表現 |

## ローカル起動

### 1. バックエンド

```bash
cd server
npm install

# Azure OpenAI (必須)
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
export AZURE_OPENAI_KEY=...
export AZURE_OPENAI_DEPLOYMENT=gpt-5.4
export AZURE_OPENAI_API_VERSION=2024-10-21

# Azure AI Speech (任意: マイク入力を使う場合)
export AZURE_SPEECH_KEY=...
export AZURE_SPEECH_REGION=japaneast

# Cosmos DB (任意: 永続化する場合)
export STORE=cosmos
export COSMOS_ENDPOINT=https://<account>.documents.azure.com:443/
export COSMOS_KEY=...
export COSMOS_DATABASE=whiteboard

npm run dev   # http://localhost:8787
```

`STORE=cosmos` を指定すると、起動時に DB/コンテナを `createIfNotExists` し、既存の items/turns/summaries を hydrate して再開します。書き込みは write-through で非同期反映。

未設定、または LLM 接続に失敗した場合は、ローカル検証用の簡易フォールバックで
短い AI カードを生成します。実 LLM なしで `npm run mock` の表示確認ができます。
本番相当の挙動で空 ops にしたい場合は `LLM_FALLBACK=off` を指定してください。

### 2. フロントエンド

```bash
npm install
npm run dev   # http://localhost:5173
```

`VITE_SERVER_URL` でバックエンド URL を上書き可能（既定: `http://localhost:8787`）。

## ボード管理と永続化

既定では `STORE=file` として、会議ボード、AI生成図、文字起こしターン、手動キャンバスオブジェクトを
`server/data/boards.json` に保存します。ブラウザを更新しても、選択中ボードのノード位置、手動追加した
ノード/矢印/テキスト/ペン描画は復元されます。

画面左上のボードセレクタで履歴を切り替え、`新規` ボタンで会議ごとのボードを作成します。
録音やサンプル投入は、現在開いている `boardId` に紐づきます。

環境変数:

```bash
STORE=file
FILE_STORE_PATH=./data/boards.json
```

一時メモリだけで動かしたい場合は `STORE=memory` を指定します。

### 3. モック文字起こし投入

別ターミナルで:

```bash
cd server
npm run mock                                                   # 既定速度
node src/mockDriver.js http://localhost:8787 ../meeting_log_revised.txt 600
```

`meeting_log_revised.txt` を話者ごとのブロックに分解し、段落単位で発言を POST します。

このサンプル投入は、実運用の Teams 音声とは独立したテスト運用として残しています。
図作成ロジックやUI確認では、まずこの経路で再現性のある検証を行います。

## Teams 音声入力方針

オンライン会議の本番想定は、Teams 会議に参加する音声収集プロセスを WhiteBoard 本体とは別に置く構成です。

```
Teams Meeting
       │
       ▼
Teams audio ingestor / Teams media bot
       │  音声のみ取得。画面共有・映像は扱わない
       ▼
Speech-to-Text
       │  { speakerId, text, meetingId, at }
       ▼
POST /teams/transcript
       │
       ▼
Turn Buffer → LLM 図化 → Whiteboard UI
```

話者の実名特定は必須にしません。ただし、話者が変わったことはシステム処理上重要なので、
Teams/Speech 側から得た安定した `speakerId` を必ず送ります。バックエンドは
`speakerId` を `Speaker 1`, `Speaker 2` のような匿名ラベルに正規化し、その変化で
ターンを区切ります。

Teams 側の実装は別サービスとして作る想定です。

```
teams-audio-ingestor/
  - Teams 会議に Bot として参加
  - 音声だけ受信
  - Speech-to-Text で発話テキスト化
  - speakerId の変化を保ったまま /teams/transcript に POST
```

これにより、WhiteBoard 本体はサンプル投入、ブラウザマイク、Teams音声のどれから来た発話でも
同じ `Turn Buffer → LLM → SSE` の処理で扱えます。

### 個人検証モード

Teams Bot を作る前に、個人でも Teams 音声経路を検証できるように、フロントのマイク入力は
`/teams/transcript` に送る疑似 Teams ingestor として動きます。

使い方:

1. 画面上部の `Speaker 1 / Speaker 2 / Speaker 3` を選ぶ
2. マイクボタンを押して話す
3. 話者が変わった想定にしたいときは、プルダウンで別 Speaker に切り替える
4. 認識された発話は `{meetingId:"browser-teams-test", speakerId, text}` として `/teams/transcript` に送られる

実Teamsの音声は取りませんが、WhiteBoard側の `speakerId` 正規化、話者交代によるターン分割、
LLM図化、SSE反映までを個人で確認できます。

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/events` | SSE: `snapshot`, `board.diff`, `summary.added` |
| GET | `/board` | 現在の盤面スナップショット |
| GET | `/boards` | ボード履歴一覧 |
| POST | `/boards` | `{title}` 新規ボード作成 |
| GET | `/canvas?boardId=...` | 手動キャンバス状態の取得 |
| POST | `/canvas` | `{boardId, items}` 手動キャンバス状態の保存 |
| POST | `/transcript` | `{speaker, text, at?}` を投入 |
| POST | `/transcript/external` | `{speakerId?, speaker?, text, meetingId?, at?}` 外部文字起こしを投入 |
| POST | `/teams/transcript` | `{speakerId?, speaker?, text, meetingId?, at?}` Teams音声ingestorから投入 |
| POST | `/transcript/flush` | 残りターンの強制 emit |
| POST | `/items` | `{section, text}` 人手で追加 |
| POST | `/items/:id/confirm` | tentative → confirmed |
| POST | `/items/:id/pin` / `/unpin` | AI ロック |
| POST | `/items/:id/dismiss` | 却下（削除） |
| GET | `/speech/token` | Azure Speech 認可トークン発行（10分有効） |

## SSE イベント

```
event: snapshot
data: {"type":"snapshot","board":{...}}

event: board.diff
data: {"type":"board.diff","ops":[{"op":"add","item":{...}}, ...]}

event: summary.added
data: {"type":"summary.added","section":"論点","entry":{...}}
```

## フロント UI

- **ライブインジケータ** 右上に `LIVE / OFFLINE`
- **AI カード** 各セクションの直下に縦積み配置
  - **暫定 (tentative)**: 破線枠 + `AI 提案` バッジ + ✓ボタン + ×ボタン
  - **確定 (confirmed)**: 実線枠
- **✓ で確定** AI は以後そのアイテムを書き換え不可
- **× で却下** アイテム削除
- 既存のペン/テキスト/選択/グループ化等は従来通り、それらは `author=human` 相当として扱う想定（必要なら同期エンドポイント `POST /items` を呼ぶ実装に拡張可）

## Azure へのデプロイ（最小構成）

1. **Azure OpenAI** リソースを作成し、`gpt-5.4` の deployment を作成
2. **Azure Container Apps** にバックエンドをデプロイ
   ```bash
   az containerapp up \
     --name whiteboard-agent \
     --resource-group <rg> \
     --location japaneast \
     --source ./server \
     --ingress external --target-port 8787 \
     --env-vars AZURE_OPENAI_ENDPOINT=... AZURE_OPENAI_KEY=... AZURE_OPENAI_DEPLOYMENT=gpt-5.4
   ```
3. **Azure Static Web Apps** にフロントをデプロイ
   ```bash
   az staticwebapp create --name whiteboard-ui --source . --location japaneast \
     --app-location / --output-location dist --branch main
   ```
   ビルド時に `VITE_SERVER_URL` を Container Apps の URL に。

## 人手書きテキストの自動同期

ボード上で T キー or テキストツールでテキストを書き込むと、確定時に
`POST /items` で backend へ送られ `author='human'` として記録されます。
配置座標から自動的にセクションが推定されます（最近接のセクションヘッダ）。
LLM はこれを「信頼情報」として参照しつつ、書き換え・削除はできません。

## 音声入力 (Azure AI Speech)

ツールバー右端のマイクボタンで起動。`AZURE_SPEECH_KEY` が設定されていれば
`/speech/token` 経由で short-lived な認可トークンが発行され、ブラウザ側の
`ConversationTranscriber` が話者分離付きで日本語をリアルタイム認識します。
認識フレーズは `speakerId` 付きで `/transcript` に投入され、既存のターンバッファ
で同じく処理されます。

Teams 音声の場合はブラウザのマイクではなく、別プロセスの Teams audio ingestor が
`/teams/transcript` に発話を投入します。WhiteBoard 本体では実名ではなく匿名話者ラベルを使い、
話者交代だけを安定して保持します。

注意:
- Speech SDK はブラウザのマイク権限が必要
- HTTPS 環境（または localhost）でないとマイク取得不可
- 話者分離は `speakerId` ベースで自動。実名へのマッピングは未実装

