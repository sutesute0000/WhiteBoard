// Cosmos DB 永続化アダプタ。
// 仕組み: メモリストアを source of truth とし、書き込みを Cosmos に非同期反映する
// (write-through)。起動時に Cosmos から hydrate して状態を復元する。
//
// コンテナ構成 (DB: whiteboard, partitionKey: /roomId):
//   - items     : board item ドキュメント
//   - turns     : 文字起こしターン
//   - summaries : セクション要約
// roomId は単一テナント想定で 'default'。マルチルーム時はパスから渡す。

import { CosmosClient } from '@azure/cosmos';
import { createStore } from './store.js';
import { config } from './config.js';

const ROOM_ID = 'default';

async function ensureContainer(db, id) {
  const { container } = await db.containers.createIfNotExists({
    id,
    partitionKey: { paths: ['/roomId'] },
  });
  return container;
}

export async function createCosmosStore() {
  if (!config.cosmosEndpoint || !config.cosmosKey) {
    throw new Error('Cosmos endpoint/key not configured');
  }
  const client = new CosmosClient({
    endpoint: config.cosmosEndpoint,
    key: config.cosmosKey,
  });
  const { database } = await client.databases.createIfNotExists({ id: config.cosmosDatabase });
  const itemsC = await ensureContainer(database, 'items');
  const turnsC = await ensureContainer(database, 'turns');
  const sumsC  = await ensureContainer(database, 'summaries');

  // Persist queue (シリアル書き込み): SSE には影響させずバックグラウンドで反映
  const queue = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const task = queue.shift();
      try { await task(); } catch (e) { console.error('[cosmos]', e?.message || e); }
    }
    draining = false;
  }
  function enqueue(task) { queue.push(task); drain(); }

  function onPersist(kind, payload) {
    switch (kind) {
      case 'turn.add':
        enqueue(() => turnsC.items.upsert({ ...payload, roomId: ROOM_ID, _kind: 'turn' }));
        break;
      case 'summary.add':
        enqueue(() => sumsC.items.upsert({
          ...payload.entry, section: payload.section, roomId: ROOM_ID, _kind: 'summary'
        }));
        break;
      case 'items.diff':
        // payload は applied ops 配列
        for (const op of payload) {
          if (op.op === 'add' || op.op === 'update' || op.op === 'merge') {
            const it = op.item;
            enqueue(() => itemsC.items.upsert({ ...it, roomId: ROOM_ID, _kind: 'item' }));
          } else if (op.op === 'remove') {
            enqueue(() => itemsC.item(op.id, ROOM_ID).delete().catch(() => {}));
          }
          if (op.op === 'merge' && op.removedIds) {
            for (const id of op.removedIds) {
              enqueue(() => itemsC.item(id, ROOM_ID).delete().catch(() => {}));
            }
          }
        }
        break;
      case 'item.update':
        enqueue(() => itemsC.items.upsert({ ...payload, roomId: ROOM_ID, _kind: 'item' }));
        break;
    }
  }

  const store = createStore({ onPersist });

  // Hydrate
  const { resources: items } = await itemsC.items.query({
    query: 'SELECT * FROM c WHERE c.roomId = @r',
    parameters: [{ name: '@r', value: ROOM_ID }],
  }).fetchAll();
  const { resources: turns } = await turnsC.items.query({
    query: 'SELECT * FROM c WHERE c.roomId = @r',
    parameters: [{ name: '@r', value: ROOM_ID }],
  }).fetchAll();
  const { resources: sums } = await sumsC.items.query({
    query: 'SELECT * FROM c WHERE c.roomId = @r',
    parameters: [{ name: '@r', value: ROOM_ID }],
  }).fetchAll();
  const summariesMap = {};
  for (const s of sums) {
    const sec = s.section;
    if (!summariesMap[sec]) summariesMap[sec] = [];
    summariesMap[sec].push({ id: s.id, text: s.text, coversTurnIds: s.coversTurnIds || [] });
  }
  store.hydrate({
    items: items.map(({ _kind, _rid, _self, _etag, _attachments, _ts, roomId, ...rest }) => rest),
    turns: turns.map(({ _kind, _rid, _self, _etag, _attachments, _ts, roomId, ...rest }) => rest),
    summaries: summariesMap,
  });
  console.log(`[cosmos] hydrated items=${items.length} turns=${turns.length} summaries=${sums.length}`);
  return store;
}
