import type { EntryAuth } from '../components/entry/entryAuth';
import { login, loggedIn, logout } from './research-live';

export const liveEntryAuth: EntryAuth = {
  kind: 'live',
  identity: { label: '用户名或邮箱', placeholder: 'USERNAME / EMAIL', type: 'text' },
  keyPlaceholder: 'PASSWORD',
  hint: '本地账户登录 · 会话只保存在本页内存中',
  async verify(email, password) {
    await login(email, password);
    return true;
  },
  active: loggedIn,
  lock: logout,
};
