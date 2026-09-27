import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENMAIC_ORIGIN_KEY, hasBuildOrigin, isOpenMAICConfigured, readStoredOrigin, resolveOrigin, writeStoredOrigin } from './openMaicPortal';

/**
 * node 测试环境没有 localStorage，而这段逻辑必须可测，所以装一个最小替身。
 * 只实现代码实际用到的四个方法。
 */
function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  };
  return map;
}

describe('OpenMAIC 地址解析', () => {
  beforeEach(() => {
    installStorage();
    // 让结果不受本机 .env.local 影响：显式声明「构建期未注入」。
    vi.stubEnv('VITE_OPENMAIC_ORIGIN', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('未填写时读取为空串', () => {
    expect(readStoredOrigin()).toBe('');
  });

  it('保存后可读回，且清除后回到空串', () => {
    writeStoredOrigin('http://10.0.0.5:3000');
    expect(readStoredOrigin()).toBe('http://10.0.0.5:3000');
    writeStoredOrigin('');
    expect(readStoredOrigin()).toBe('');
    writeStoredOrigin('   ');
    expect(readStoredOrigin()).toBe('');
  });

  it('保存的地址优先于开发默认值', () => {
    writeStoredOrigin('https://courses.example.com');
    expect(resolveOrigin()).toBe('https://courses.example.com');
    expect(isOpenMAICConfigured()).toBe(true);
  });

  it('去掉结尾斜杠，避免拼出双斜杠路径', () => {
    writeStoredOrigin('http://10.0.0.5:3000///');
    expect(resolveOrigin()).toBe('http://10.0.0.5:3000');
  });

  it('首尾空白被裁剪', () => {
    writeStoredOrigin('  http://10.0.0.5:3000  ');
    expect(resolveOrigin()).toBe('http://10.0.0.5:3000');
  });

  it('存储不可用时退化为空串，不抛错', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
      removeItem() { throw new Error('storage disabled'); },
    };
    expect(() => writeStoredOrigin('http://10.0.0.5:3000')).not.toThrow();
    expect(readStoredOrigin()).toBe('');
  });

  it('使用独立的存储键，不与既有数据混用', () => {
    const map = installStorage();
    writeStoredOrigin('http://10.0.0.5:3000');
    expect(map.get(OPENMAIC_ORIGIN_KEY)).toBe('http://10.0.0.5:3000');
  });

  it('未注入构建期地址时如实报告', () => {
    expect(hasBuildOrigin()).toBe(false);
  });
});
