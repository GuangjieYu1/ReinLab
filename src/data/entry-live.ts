import type { EntryAuth } from '../components/entry/entryAuth';
import { navigate } from '../nav';
import { lock, lockIsPending, login, loggedIn, sessionState, subscribeSession } from './research-live';

/** 被拦到登录页前想去的地址（只是页面地址，不是凭据）：登录后回到那里。 */
export const RETURN_KEY = 'reinlab-return-to';

export const liveEntryAuth: EntryAuth = {
  kind: 'live',
  identity: { label: '用户名或邮箱', placeholder: 'USERNAME / EMAIL', type: 'text' },
  keyPlaceholder: 'PASSWORD',
  get hint() {
    if (lockIsPending()) return '已在本页退出 · 服务端退出还没完成，恢复连接后会自动完成';
    if (sessionState() === 'expired') return '登录已过期，请重新登录';
    return '本地账户登录 · 登录保持 30 天，点锁定即退出';
  },
  async verify(email, password) {
    await login(email, password);
    const back = sessionStorage.getItem(RETURN_KEY);
    if (back) {
      sessionStorage.removeItem(RETURN_KEY);
      // 等核验画面走完再回去，不打断登录动效
      window.setTimeout(() => navigate(back), 1200);
    }
    return true;
  },
  active: loggedIn,
  lock,
  subscribe: subscribeSession,
};
