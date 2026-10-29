import { describe, expect, it, vi } from 'vitest';

/**
 * 收件箱的 live 适配器同时列 promotion 与 approval。
 * promotion 表随旧内核退役一起删掉后，服务端不再有这个入口；此时收件箱
 * 仍要按当前内核的审批显示，不能因为一个 404 整块失败。
 */
function loadInbox(api: (path: string) => Promise<{ items: unknown[] }>) {
  const promotions = api('/v1/promotions?state=pending').catch((error: { status?: number }) => {
    if (error?.status === 404) return { items: [] as unknown[] };
    throw error;
  });
  return Promise.all([
    promotions,
    api('/v1/approvals?state=pending'),
    api('/v1/approvals?state=indeterminate'),
  ]).then(([promoted, approvals, unknown]) => ({
    promotions: promoted.items,
    approvals: [...approvals.items, ...unknown.items],
  }));
}

describe('live inbox without the retired promotions endpoint', () => {
  it('still lists current approvals when promotions answers 404', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/promotions')) throw Object.assign(Error('请求未完成，请刷新后重试。'), { status: 404 });
      return { items: path.includes('indeterminate') ? [] : [{ id: 'approval-1' }] };
    });
    await expect(loadInbox(api)).resolves.toEqual({
      promotions: [],
      approvals: [{ id: 'approval-1' }],
    });
  });

  it('does not hide a real failure', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/promotions')) throw Object.assign(Error('请求未完成，请刷新后重试。'), { status: 500 });
      return { items: [] };
    });
    await expect(loadInbox(api)).rejects.toMatchObject({ status: 500 });
  });
});
