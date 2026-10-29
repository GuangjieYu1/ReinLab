// 本地 OpenMAIC 的地址：本机设置（localStorage）优先，其次构建变量，最后默认本地 3000 端口。
// 课程播放沿用原生渲染与离线缓存（NativeCourse），进度沿用 courseProgress，不重新生成课程。
export const OPENMAIC_ORIGIN_KEY = 'reinlab-openmaic-origin-v1';
export const OPENMAIC_TOKEN_KEY = 'reinlab-openmaic-token-v1';
const read = (k: string) => { try { return (localStorage.getItem(k) ?? '').trim(); } catch { return ''; } };
export const courseOrigin = () => read(OPENMAIC_ORIGIN_KEY) || (import.meta.env.VITE_OPENMAIC_ORIGIN as string | undefined) || 'http://127.0.0.1:3000';
export const courseToken = () => read(OPENMAIC_TOKEN_KEY) || undefined;
