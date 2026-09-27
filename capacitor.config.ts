import type { CapacitorConfig } from '@capacitor/cli';

/**
 * iOS / iPadOS 外壳配置。
 *
 * 目标设备为 iPad Pro 11"（M1，1194×834 pt 横屏），因此按「全出血」处理：
 * 开场演出铺满整屏，安全区交由 CSS 的 env(safe-area-inset-*) 逐处补偿。
 */
const config: CapacitorConfig = {
  appId: 'chat.reinlab.terminal',
  appName: 'REINLAB',
  webDir: 'dist',
  ios: {
    // 默认即 never；显式写出，避免日后被误改回 automatic 而破坏全出血。
    contentInset: 'never',
    backgroundColor: '#ecece5',
  },
};

export default config;
