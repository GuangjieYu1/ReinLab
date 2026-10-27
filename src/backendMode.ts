// 数据来源：mock = 本地示例（设计预览）；live = 真实后端（VITE_BACKEND=live）。
// 真实模式下，没接真实数据的工作台必须明确标出「演示数据」，不能把模拟结果当成真的成功。
export const backendMode: 'mock' | 'live' = import.meta.env.VITE_BACKEND === 'live' ? 'live' : 'mock';

/** 已接真实数据的工作台（按工作台代号）。接通一个就在这里加一个，live 适配器那边同步。 */
export const LIVE_BENCHES: ReadonlySet<string> = new Set(['RSCH']);

/** 真实模式下这个工作台是不是还在用演示数据。mock 模式整站都是示例，不逐台标记。 */
export const isDemoBench = (code: string) => backendMode === 'live' && !LIVE_BENCHES.has(code);
