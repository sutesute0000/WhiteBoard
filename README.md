# Realtime Whiteboard Agent

会議の文字起こしをリアルタイムに LLM 処理し、参加者の「共通認識」をホワイトボード上に可視化するエージェント。Microsoft Agent Hackathon 2026 用構成（Azure OpenAI + Azure Container Apps）。

## アーキテクチャ

```
[文字起こしストリーム]
       │
       ▼
   Turn Buffer       (話者交代＋短発言ゲートで 1 ターン確定)
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
| トリガ | 話者交代の確定（次話者の発言が 20 文字以上で前ターン emit） |
| 短発言 | 相槌は破棄せず、現ターンに `[話者: 内容]` として注記 |
| LLM 入力 | 盤面の全アイテム（human/ai 種別と status 含む）+ 直近 6 ターン + 新ターン |
| LLM 出力 | `{ops:[{op:add|update|remove|merge,...}], rationale}` |
| 人 vs AI | `author:'human'` / `status:'confirmed'` / `pinned:true` の AI 書き換え禁止（バックエンドで強制） |
| 決定事項 | AI が add すると必ず `tentative`。人が ✓ で confirm |
| 圧縮 | 「会議の目的」「論点」のような stable セクションは閾値超で要約化（旧アイテムは削除） |
| 抽出粒度 | 逐語転記しない。日本語で 40 字目安の核のみ |

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

### 3. モック文字起こし投入

別ターミナルで:

```bash
cd server
npm run mock                                                   # 既定速度
node src/mockDriver.js http://localhost:8787 ../meeting_log_revised.txt 600
```

`meeting_log_revised.txt` を話者ごとのブロックに分解し、段落単位で発言を POST します。

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/events` | SSE: `snapshot`, `board.diff`, `summary.added` |
| GET | `/board` | 現在の盤面スナップショット |
| POST | `/transcript` | `{speaker, text, at?}` を投入 |
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

注意:
- Speech SDK はブラウザのマイク権限が必要
- HTTPS 環境（または localhost）でないとマイク取得不可
- 話者分離は `speakerId` ベースで自動。実名へのマッピングは未実装

## 今後の拡張ポイント

- **多会議対応**: 現状はシングルテナント (roomId='default')。room/session ID をパス・ヘッダで分離
- **複数同時編集**: Azure Web PubSub で WebSocket 化
- **話者名の永続化**: speakerId → 実名のマッピング UI
- **音声波形の可視化**: 録音中の VU メータ
