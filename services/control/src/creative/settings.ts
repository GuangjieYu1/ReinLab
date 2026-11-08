/**
 * 作品的设定组合（1C 契约 §6.1、§6.3）。
 *
 * 作品记三样：基准版本、逐条采用（picks）、本作品改写（overrides）；再加上作者对每条更新的决定，
 * 以及「待同步」的正文位置。effective = 基准版本 + picks + overrides，检查/助手都按它来。
 *
 * 纯计算：版本快照由调用方取好传进来。
 */

import type { CreativeDocument } from './world';
import type { ItemKind, WorkSetting } from '@reinlab/contracts';
import { ITEM_KINDS, itemMapOf, putItem, titleOf } from './items';

export type SyncPair = { itemId: string; sceneId: string; at: string };
export type SyncDone = { itemId: string; sceneId: string; at: string; via: 'text_edit' | 'dismiss'; reason?: string };

export type WorkSettingState = {
  picks: { itemId: string; fromVersion: number; at: string }[];
  overrides: { itemId: string; kind: ItemKind; patch: unknown; note: string; at: string }[];
  decisions: { itemId: string; toVersion: number; decision: 'follow' | 'keep'; at: string }[];
  /** 还标着「待同步」的正文位置。 */
  sync: SyncPair[];
  /** 已经处理掉的（接受改稿或「这里不用改」），用来避免同一处反复冒出来。 */
  syncDone: SyncDone[];
};

export function settingStateOf(work: { setting?: Partial<WorkSettingState> & { baseVersion?: number } }): WorkSettingState {
  const raw = (work.setting ?? {}) as Partial<WorkSettingState>;
  return {
    picks: raw.picks ?? [],
    overrides: raw.overrides ?? [],
    decisions: raw.decisions ?? [],
    sync: raw.sync ?? [],
    syncDone: raw.syncDone ?? [],
  };
}

/** 契约里的 setting 投影（pendingSync 是数出来的）。 */
export function settingOf(work: { baseVersion: number; setting?: Partial<WorkSettingState> }): WorkSetting {
  const state = settingStateOf(work);
  return {
    baseVersion: work.baseVersion,
    picks: state.picks,
    overrides: state.overrides,
    decisions: state.decisions,
    pendingSync: state.sync.length,
  };
}

const sameDecision = (decision: { itemId: string; toVersion: number }, itemId: string, toVersion: number) =>
  decision.itemId === itemId && decision.toVersion === toVersion;

/** 跟着改：picks 记一条、decision 记 follow、把确定受影响的场景标成待同步。 */
export function followItem(
  state: WorkSettingState,
  input: { itemId: string; toVersion: number; scenes: string[]; at: string },
): WorkSettingState {
  const picks = [...state.picks.filter((pick) => pick.itemId !== input.itemId), { itemId: input.itemId, fromVersion: input.toVersion, at: input.at }];
  const decisions = [
    ...state.decisions.filter((decision) => !sameDecision(decision, input.itemId, input.toVersion)),
    { itemId: input.itemId, toVersion: input.toVersion, decision: 'follow' as const, at: input.at },
  ];
  const done = new Set(state.syncDone.filter((item) => item.itemId === input.itemId).map((item) => item.sceneId));
  const sync = [...state.sync];
  for (const sceneId of input.scenes) {
    if (done.has(sceneId)) continue;
    if (sync.some((pair) => pair.itemId === input.itemId && pair.sceneId === sceneId)) continue;
    sync.push({ itemId: input.itemId, sceneId, at: input.at });
  }
  return { ...state, picks, decisions, sync };
}

/** 保留旧版：只记决定，不动 picks。 */
export function keepItem(
  state: WorkSettingState,
  input: { itemId: string; toVersion: number; at: string },
): WorkSettingState {
  const decisions = [
    ...state.decisions.filter((decision) => !sameDecision(decision, input.itemId, input.toVersion)),
    { itemId: input.itemId, toVersion: input.toVersion, decision: 'keep' as const, at: input.at },
  ];
  return {
    ...state,
    decisions,
    // 保留旧版：这条的待同步不该留着（之前若跟着改过，改回保留要把标记撤掉）
    sync: state.sync.filter((pair) => pair.itemId !== input.itemId),
  };
}

/** 整版跟进：基准版本换成 toVersion，没决定过的条目都按 follow 处理。 */
export function followVersion(
  state: WorkSettingState,
  input: { toVersion: number; scenesByItem: Map<string, string[]>; decidedItems: Set<string>; at: string },
): WorkSettingState {
  let next: WorkSettingState = { ...state };
  for (const [itemId, scenes] of input.scenesByItem) {
    if (input.decidedItems.has(itemId)) continue;
    next = followItem(next, { itemId, toVersion: input.toVersion, scenes, at: input.at });
  }
  // 已经按 keep 决定过的条目保留决定，但基准版本往前走
  return next;
}

export function setOverride(
  state: WorkSettingState,
  input: { itemId: string; kind: ItemKind; patch: unknown; note: string; at: string },
): WorkSettingState {
  return {
    ...state,
    overrides: [
      ...state.overrides.filter((override) => override.itemId !== input.itemId),
      { itemId: input.itemId, kind: input.kind, patch: input.patch, note: input.note, at: input.at },
    ],
  };
}

export const removeOverride = (state: WorkSettingState, itemId: string): WorkSettingState => ({
  ...state,
  overrides: state.overrides.filter((override) => override.itemId !== itemId),
});

/** 「这里不用改」：去掉这一处待同步，记原因。 */
export function dismissSync(
  state: WorkSettingState,
  input: { itemId: string; sceneId: string; reason: string; at: string },
): WorkSettingState {
  return resolveSync(state, { ...input, via: 'dismiss' });
}

/** 接受对应改稿之后，这一处待同步消掉。 */
export function resolveSync(
  state: WorkSettingState,
  input: { itemId: string; sceneId: string; at: string; via: 'text_edit' | 'dismiss'; reason?: string },
): WorkSettingState {
  return {
    ...state,
    sync: state.sync.filter((pair) => !(pair.itemId === input.itemId && pair.sceneId === input.sceneId)),
    syncDone: [
      ...state.syncDone.filter((item) => !(item.itemId === input.itemId && item.sceneId === input.sceneId)),
      { itemId: input.itemId, sceneId: input.sceneId, at: input.at, via: input.via, ...(input.reason ? { reason: input.reason } : {}) },
    ],
  };
}

/** 某个场景的待同步标记（给 marks 用）。 */
export function syncItemsOfScene(work: { setting?: Partial<WorkSettingState> }, sceneId: string): string[] {
  return [...new Set(settingStateOf(work).sync.filter((pair) => pair.sceneId === sceneId).map((pair) => pair.itemId))];
}

export type EffectiveSource = 'base' | 'picked' | 'override';

/**
 * 按组合还原一部作品实际用的世界：基准版本的快照 + picks + overrides。
 * 返回的文档里每条条目带 `setting`，页面据此显示「本作品」。
 */
export function effectiveDocument(input: {
  /** 基准版本的世界快照；没有版本时给草稿。 */
  base: CreativeDocument;
  /** 版本号 → 该版本的世界快照（只要 picks 用到的）。 */
  versions: Map<number, CreativeDocument>;
  setting: WorkSettingState;
}): { document: CreativeDocument; sources: Map<string, EffectiveSource> } {
  const document: CreativeDocument = JSON.parse(JSON.stringify(input.base)) as CreativeDocument;
  const sources = new Map<string, EffectiveSource>();
  for (const item of itemMapOf(document).values()) sources.set(item.value.id, 'base');

  for (const pick of input.setting.picks) {
    const version = input.versions.get(pick.fromVersion);
    if (!version) continue; // 版本没了就保留基准——不猜
    const fromVersion = itemMapOf(version).get(pick.itemId);
    const kind = fromVersion?.kind ?? itemMapOf(document).get(pick.itemId)?.kind;
    if (!kind) continue;
    putItem(document, kind, pick.itemId, fromVersion ? (fromVersion.value as never) : null);
    sources.set(pick.itemId, 'picked');
  }

  for (const override of input.setting.overrides) {
    const current = itemMapOf(document).get(override.itemId);
    const kind = override.kind ?? current?.kind;
    if (!kind) continue;
    const patch = (override.patch ?? {}) as Record<string, unknown>;
    if (!current) continue;
    putItem(document, kind, override.itemId, { ...current.value, ...patch } as never);
    sources.set(override.itemId, 'override');
  }

  // 打标：只打在还存在的条目上
  for (const item of itemMapOf(document).values()) {
    const source = sources.get(item.value.id) ?? 'base';
    (item.value as Record<string, unknown>).setting = source;
  }
  return { document, sources };
}

/** 给页面解释用：一条条目现在用的是哪一版。 */
export function explainOf(state: WorkSettingState, baseVersion: number, itemId: string): {
  uses: 'old' | 'new' | 'override';
} {
  if (state.overrides.some((override) => override.itemId === itemId)) return { uses: 'override' };
  const pick = state.picks.find((item) => item.itemId === itemId);
  if (pick) return { uses: pick.fromVersion > baseVersion ? 'new' : 'old' };
  return { uses: 'old' };
}

export { ITEM_KINDS, titleOf };
