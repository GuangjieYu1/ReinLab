// 正式入口的身份核验接口：界面只认这个接口，mock 与 live 各自实现。
// mock：任意 4 位以上口令即可通过；live（Codex 接入）：邮箱 + 密码登录本地账户。

export type EntryAuth = {
  kind: 'mock' | 'live';
  /** 要不要单独填身份（live 填邮箱）。不填则只有口令一栏。 */
  identity?: { label: string; placeholder: string; type: 'email' | 'text' };
  /** 口令栏的占位文字与下方说明。 */
  keyPlaceholder: string;
  hint: string;
  /** 核验；通过返回 true。网络或账户错误返回 false 或抛错，界面都按「拒绝」处理，并显示 message（如有）。 */
  verify(identity: string, key: string): Promise<boolean>;
  /** 当前是否已在会话中（从工作台返回时用来决定要不要重新登录）。 */
  active(): boolean;
  /** 锁定：退出会话。 */
  lock?(): void;
  /** 会话在别处变化（别的标签锁定、过期）时通知入口；返回取消订阅。 */
  subscribe?(on: () => void): () => void;
};

export const MIN_KEY = 4;

export const mockEntryAuth: EntryAuth = {
  kind: 'mock',
  keyPlaceholder: 'ENTER AUTHORIZATION KEY',
  hint: '演示环境：任意 4 位以上口令即可通过',
  verify: async (_identity, key) => key.trim().length >= MIN_KEY,
  active: () => true,
};

/** 预览 live 的登录样子（?preview=entry&auth=live）：邮箱 + 密码两栏，任意邮箱配 4 位以上密码即可，不连后端。 */
export const previewLiveAuth: EntryAuth = {
  kind: 'mock',
  identity: { label: '邮箱', placeholder: 'EMAIL', type: 'email' },
  keyPlaceholder: 'PASSWORD',
  hint: '本地账户登录 · 会话只保存在本页内存中',
  verify: async (identity, key) => identity.includes('@') && key.trim().length >= MIN_KEY,
  active: () => true,
};
