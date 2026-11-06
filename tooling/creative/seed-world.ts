/**
 * 建一份能直接打开的创作台世界观（MVP-1A 验收用）。
 *
 * 走真实页面同一条 HTTP 路径（登录 → 建档案 → 操作批次 → 导入 OSM → 触发推断路线），
 * 不直接写库。默认建在试用账户（B）下，也可以 --user A。
 *
 * 用法：
 *   pnpm tsx tooling/creative/seed-world.ts            # 试用账户，建 OSM 世界观 + 架空世界观
 *   pnpm tsx tooling/creative/seed-world.ts --user A --osm-only
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CONTROL = process.env.REINLAB_CONTROL_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:3001';

type Credentials = { email: string; password: string };
type Session = { cookie: string };

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function credentialsFor(user: 'A' | 'B'): Credentials {
  const file = path.join(homedir(), '.local/state/reinlab/803a04fcd69a/verification-users.env');
  const env = parseEnvFile(file);
  const email = env[`${user}_EMAIL`];
  const password = env[`${user}_PASSWORD`];
  if (!email || !password) throw new Error(`没有找到 ${user} 账户的凭据。`);
  return { email, password };
}

const headers = (extra: Record<string, string> = {}) => ({
  Origin: CONTROL,
  'Content-Type': 'application/json',
  'X-ReinLab-CSRF': '1',
  ...extra,
});

async function login(user: 'A' | 'B'): Promise<Session> {
  const { email, password } = credentialsFor(user);
  const response = await fetch(`${CONTROL}/auth/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`);
  const cookie = response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0])
    .find((item) => item.startsWith('rl_session='));
  if (!cookie) throw new Error('登录成功但没有拿到会话 Cookie。');
  return { cookie };
}

async function call(session: Session, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${CONTROL}${pathname}`, {
    ...init,
    headers: headers({ Cookie: session.cookie, ...(init.headers ?? {}) }),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok)
    throw new Error(`${init.method ?? 'GET'} ${pathname} → ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

const idem = () => ({ 'Idempotency-Key': randomUUID() });

/** 这次建的档案（失败时删掉，别在文件列表里留垃圾）。 */
let currentDossier: string | null = null;

async function createWorld(session: Session, title: string, intent: string): Promise<{ id: string; revision: number }> {
  const dossier = await call(session, '/v1/dossiers', {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ bench: 'creative', kind: 'workspace', title, intent }),
  });
  currentDossier = dossier.id;
  const snapshot = await call(session, `/v1/creative/worlds/${dossier.id}`);
  return { id: dossier.id, revision: snapshot.world.revision };
}

async function ops(session: Session, dossierId: string, baseRevision: number, ops: unknown[]): Promise<any> {
  return call(session, `/v1/creative/worlds/${dossierId}/ops`, {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ baseRevision, ops }),
  });
}

const snapshotOf = (session: Session, dossierId: string) => call(session, `/v1/creative/worlds/${dossierId}`);

const placeOp = (
  name: string,
  coordinates: [number, number] | null,
  level: string,
  parentName?: string,
  connects: { to: string; passable: boolean }[] = [],
  summary?: string,
) => ({
  op: 'entity.add',
  entity: {
    kind: 'place',
    name,
    aliases: [],
    ...(summary ? { summary } : {}),
    place: {
      level,
      parentId: null,
      geo: coordinates ? { type: 'Point', coordinates } : null,
      geoCertainty: coordinates ? 'exact' : 'unlocated',
      connects,
    },
    ...(parentName ? { parentName } : {}),
  },
});

const personOp = (name: string, summary: string) => ({
  op: 'entity.add',
  entity: { kind: 'person', name, aliases: [], summary, person: {} },
});

const eventOp = (
  title: string,
  what: string,
  kind: string,
  entityName: string,
  placeName: string | null,
  start: string,
  end: string,
  options: { participation?: string; travel?: { from?: string; to?: string; modeId?: string } | null; narrative?: string } = {},
) => ({
  op: 'event.add',
  event: {
    title,
    what,
    kind,
    participants: [{ entityName, as: options.participation ?? 'actor' }],
    placeName,
    travel: options.travel ?? null,
    narrative: options.narrative ?? 'fact',
    start: { input: start },
    end: { input: end },
  },
});

/** 页面上手写的是名字；这里把名字换成 id 再提交（服务端只认 id）。 */
function resolveNames(ops: any[], ids: Map<string, string>): any[] {
  return ops.map((op) => {
    if (op.op === 'entity.add' && op.entity.parentName) {
      const parentId = ids.get(op.entity.parentName);
      return {
        op: 'entity.add',
        entity: {
          ...op.entity,
          parentName: undefined,
          place: { ...op.entity.place, parentId: parentId ?? null },
        },
      };
    }
    if (op.op === 'event.add') {
      const placeId = op.event.placeName ? ids.get(op.event.placeName) ?? null : null;
      return {
        op: 'event.add',
        event: {
          ...op.event,
          entityName: undefined,
          placeName: undefined,
          participants: op.event.participants.map((item: any) => ({
            entityId: ids.get(item.entityName) ?? '',
            as: item.as,
          })),
          placeId,
          travel: op.event.travel
            ? {
                fromId: op.event.travel.from ? ids.get(op.event.travel.from) ?? null : null,
                toId: op.event.travel.to ? ids.get(op.event.travel.to) ?? null : null,
                modeId: op.event.travel.modeId ?? null,
              }
            : null,
        },
      };
    }
    return op;
  });
}

async function seedOsmWorld(session: Session, user: string): Promise<string> {
  const world = await createWorld(
    session,
    '阊门到山村 · 旧河道考',
    '作者手搭的世界观：一块真实的苏州城西，三个人物，一段走不通的行程。',
  );
  console.log(`  档案 ${world.id}（user ${user}）`);
  let revision = world.revision;

  // ── 一、地点与人物 ──
  const places = await ops(session, world.id, revision, [
    placeOp('苏州', [120.601, 31.312], 'city', undefined, [], '城西一带'),
    placeOp('阊门', [120.6005, 31.3165], 'site'),
    placeOp('悦来客栈', [120.6014, 31.3152], 'building'),
    placeOp('天字客房', null, 'room', '悦来客栈', [{ to: '楼下的门厅', passable: true }]),
    placeOp('支硎山下的小村', [120.49, 31.285], 'site', undefined, [], '支硎山北麓的山坳，只有一条老路进出'),
    personOp('沈砚', '落第书生，带着一卷旧河道图'),
    personOp('顾嬷嬷', '客栈掌柜'),
    personOp('王二', '赶车的把式'),
  ]);
  revision = places.revision;

  // 房间挂到楼上、门厅连回客房：靠名字先在本地换 id。
  let snapshot = await snapshotOf(session, world.id);
  const ids = new Map<string, string>(snapshot.entities.map((item: any) => [item.name, item.id]));
  const yuelai = ids.get('悦来客栈')!;
  const fang = ids.get('天字客房')!;
  const fixRoom = await ops(session, world.id, revision, [
    { op: 'entity.update', id: fang, patch: { place: { level: 'room', parentId: yuelai, geo: null, geoCertainty: 'unlocated', connects: [{ to: yuelai, passable: true }] } } },
  ]);
  revision = fixRoom.revision;
  void snapshot;

  // 门厅就是客栈：连接两边对齐，检查才认。
  const lobby = await ops(session, world.id, revision, [placeOp('楼下的门厅', null, 'room', '悦来客栈', [])]);
  revision = lobby.revision;
  snapshot = await snapshotOf(session, world.id);
  for (const entity of snapshot.entities) ids.set(entity.name, entity.id);
  const lobbyId = ids.get('楼下的门厅')!;
  const roomFix = await ops(session, world.id, revision, [
    { op: 'entity.update', id: lobbyId, patch: { place: { level: 'room', parentId: yuelai, geo: null, geoCertainty: 'unlocated', connects: [{ to: fang, passable: true }] } } },
    { op: 'entity.update', id: fang, patch: { place: { level: 'room', parentId: yuelai, geo: null, geoCertainty: 'unlocated', connects: [{ to: lobbyId, passable: true }] } } },
  ]);
  revision = roomFix.revision;

  // 交通方式：把「步行」调成实走的脚力，另加一条乘船。
  // 有 OSM 路网就用真实底图（1A 验收里前端为此绕了一道）
  const modes = await ops(session, world.id, revision, [
    { op: 'world.set', patch: { basemap: { kind: 'real', bbox: [120.55, 31.26, 120.66, 31.35] } } },
    { op: 'mode.set', mode: { id: 'walk', name: '步行', kmPerHour: 4.5, network: 'road', note: '走官道与山道' } },
    { op: 'mode.set', mode: { id: 'boat', name: '乘船', kmPerHour: 6, network: 'water' } },
    { op: 'rule.set', rule: { id: 'rule-night', text: '夜里城门落锁，任何人不得出城。', machine: null } },
  ]);
  revision = modes.revision;

  // ── 二、导入一块 OSM 区域（真 Overpass）──
  console.log('  导入 OSM 区域（城西一带）…');
  await call(session, `/v1/creative/worlds/${world.id}/network/import`, {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ source: 'osm', bbox: [120.55, 31.26, 120.66, 31.35] }),
  });
  let network = 'importing';
  for (let index = 0; index < 240 && (network === 'importing' || network === 'none'); index += 1) {
    await new Promise((done) => setTimeout(done, 500));
    const current = await snapshotOf(session, world.id);
    network = current.world.network.state;
    if (network === 'failed') throw new Error(`路网导入失败：${current.world.network.error}`);
  }
  const imported = await snapshotOf(session, world.id);
  console.log(`  路网 ${network}，${imported.world.network.sources.map((item: any) => `${item.kind} ${item.edges} 段`).join('，')}`);
  revision = imported.world.revision;

  // ── 三、事件：一段走不通的行程、一处同时异地、一段死亡后的出场 ──
  snapshot = await snapshotOf(session, world.id);
  for (const entity of snapshot.entities) ids.set(entity.name, entity.id);
  const events = await ops(
    session,
    world.id,
    revision,
    resolveNames(
      [
        eventOp('出阊门', '天没亮就动身', 'stay', '沈砚', '阊门', '1684-04-21 06:00', '1684-04-21 08:00'),
        eventOp('到山村', '黄昏才进山坳', 'stay', '沈砚', '支硎山下的小村', '1684-04-21 10:00', '1684-04-21 18:00', {
          travel: { from: '阊门', to: '支硎山下的小村', modeId: 'walk' },
        }),
        eventOp('在阊门等消息', '顾嬷嬷在南门等回信', 'stay', '顾嬷嬷', '阊门', '1684-04-21 09:00', '1684-04-21 11:00'),
        eventOp('在客栈算账', '同一时辰她其实在客栈', 'stay', '顾嬷嬷', '悦来客栈', '1684-04-21 10:00', '1684-04-21 10:30'),
        eventOp('王二出城', '赶车去山村送书', 'stay', '王二', '阊门', '1684-04-25 06:00', '1684-04-25 07:00'),
        eventOp('王二进山', '走老路，两天到', 'stay', '王二', '支硎山下的小村', '1684-04-25 08:00', '1684-04-27 18:00', {
          travel: { from: '阊门', to: '支硎山下的小村', modeId: 'walk' },
        }),
        eventOp('沈砚病故', '山屋里没熬过去', 'death', '沈砚', '支硎山下的小村', '1684-04-28 20:00', '1684-04-28 22:00'),
        eventOp('又见沈砚', '有人在阊门街口看见他', 'stay', '沈砚', '阊门', '1684-05-02 09:00', '1684-05-02 10:00'),
      ],
      ids,
    ),
  );
  revision = events.revision;
  console.log('  已记 8 条事件；等 AI 推断路线（缺路时自动发起）…');

  // ── 四、死亡标记 ──
  snapshot = await snapshotOf(session, world.id);
  for (const entity of snapshot.entities) ids.set(entity.name, entity.id);
  const death = snapshot.events.find((item: any) => item.title === '沈砚病故');
  const marked = await ops(session, world.id, revision, [
    { op: 'entity.update', id: ids.get('沈砚'), patch: { person: { died: death.id } } },
  ]);
  revision = marked.revision;

  // ── 五、改造层：一到村口就断的旧桥，加一条次日才通的古道 ──
  const edits = await ops(session, world.id, revision, [
    {
      op: 'edit.add',
      edit: {
        title: '村口旧桥被冲垮',
        effect: 'passability',
        target: { placeId: ids.get('支硎山下的小村') },
        geometry: null,
        passable: { open: true },
        valid: { from: { input: '1684-04-21 00:00' }, to: null },
      },
    },
    {
      op: 'edit.add',
      edit: {
        title: '新修的山间古道',
        effect: 'add',
        target: null,
        geometry: {
          type: 'LineString',
          coordinates: [
            [120.6005, 31.3165],
            [120.57, 31.309],
            [120.542, 31.301],
            [120.515, 31.292],
            [120.49, 31.285],
          ],
        },
        props: { name: '阊门古道', style: 'ancient_road' },
        passable: { open: true },
        valid: { from: { input: '1684-04-22 00:00' }, to: null },
      },
    },
  ]);
  revision = edits.revision;

  // ── 六、等推断路线落库（后台跑，最多等 8 分钟；失败也照实说）──
  for (let index = 0; index < 480; index += 1) {
    await new Promise((done) => setTimeout(done, 1000));
    const current = await snapshotOf(session, world.id);
    const inferred = current.legs.filter((item: any) => item.kind === 'inferred');
    if (inferred.length) {
      console.log(`  推断路线已生成：${inferred[0].path.coordinates.length} 个点，${inferred[0].distanceKm} km`);
      break;
    }
    const failures = (current as any).routeFailures ?? [];
    if (failures.length) {
      console.log(`  推断路线失败（照实记）：${failures[failures.length - 1].failure}`);
      break;
    }
    if (index === 479) console.log('  推断路线还在跑：先用当前状态，页面刷新会补上。');
  }
  console.log(`  档案 id：${world.id}`);
  return world.id;
}

/** 架空世界：导入 Azgaar 导出的 Routes GeoJSON（坐标已经是经纬度）。 */
async function seedAzgaarWorld(session: Session, user: string): Promise<string> {
  const world = await createWorld(session, '架空世界 · 两条商路', '拿 Azgaar 导出的道路试导入的架空世界。');
  console.log(`  档案 ${world.id}（user ${user}）`);
  const routes = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 1, group: 'roads', name: '北商路' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [12.4, 41.2],
            [12.7, 41.45],
            [13.0, 41.7],
            [13.4, 41.95],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { id: 2, group: 'roads', name: '南商路' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [12.4, 41.2],
            [12.55, 40.95],
            [12.85, 40.8],
            [13.2, 40.75],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { id: 3, group: 'trails', name: '山口小道' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [13.4, 41.95],
            [13.35, 41.7],
            [13.2, 41.4],
          ],
        },
      },
    ],
  };
  const asset = await call(session, `/v1/creative/worlds/${world.id}/assets`, {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ name: 'azgaar-routes.geojson', content: JSON.stringify(routes), format: 'geojson' }),
  });
  await call(session, `/v1/creative/worlds/${world.id}/network/import`, {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ source: 'azgaar', assetId: asset.assetId }),
  });
  let state = 'importing';
  for (let index = 0; index < 60 && (state === 'importing' || state === 'none'); index += 1) {
    await new Promise((done) => setTimeout(done, 300));
    state = (await snapshotOf(session, world.id)).world.network.state;
  }
  const current = await snapshotOf(session, world.id);
  await call(session, `/v1/creative/worlds/${world.id}/ops`, {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({
      baseRevision: current.world.revision,
      ops: [
        {
          op: 'world.set',
          patch: {
            basemap: { kind: 'generated', source: 'azgaar', scaleKmPerUnit: 3, assetId: asset.assetId },
          },
        },
      ],
    }),
  });
  console.log(`  Azgaar 路网 ${state}，${current.world.network.sources.map((item: any) => `${item.kind} ${item.edges} 段`).join('，')}`);
  console.log(`  档案 id：${world.id}`);
  return world.id;
}

/** 失败时把这份试跑档案删掉，别在文件列表里留垃圾。 */
async function discard(session: Session, dossierId: string) {
  await fetch(`${CONTROL}/v1/dossiers/${dossierId}/delete`, {
    method: 'POST',
    headers: headers({ Cookie: session.cookie }),
    body: JSON.stringify({}),
  }).catch(() => undefined);
}

async function main() {
  const args = process.argv.slice(2);
  const user = (args.includes('--user') ? args[args.indexOf('--user') + 1] : 'B') as 'A' | 'B';
  const osmOnly = args.includes('--osm-only');
  const session = await login(user);
  console.log(`已登录 ${user} 账户。`);
  let osm: string;
  let azgaar: string | null = null;
  try {
    osm = await seedOsmWorld(session, user);
    if (!osmOnly) azgaar = await seedAzgaarWorld(session, user);
  } catch (error) {
    if (currentDossier) await discard(session, currentDossier);
    throw error;
  }
  console.log(JSON.stringify({ user, osmDossier: osm, azgaarDossier: azgaar }, null, 2));
}

await main();
