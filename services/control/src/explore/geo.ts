/**
 * 坐标语义（06 §4.1）。
 *
 * 业务位置统一 WGS84；高德用的是 GCJ-02，只在适配边界转换（请求前转过去、
 * 结果转回来），点、路线顶点、区域都走同一个语义，避免重复偏移。
 * 换算是近似纠偏，不宣称测绘精度。
 */
import type { LngLat } from "@reinlab/contracts";

const A = 6378245.0;
const EE = 0.00669342162296594323;

/**
 * 「大概在中国大陆」的粗判断：只用来在没指定来源时挑服务商，**不用来决定要不要纠偏**。
 * 海外（京都、首尔）也落在常见的那套 bbox 里，靠坐标猜会纠错——真正决定纠偏的是
 * 「这次是不是走高德」：只有高德的点和路线顶点才转。
 */
export function likelyMainlandChina([lng, lat]: LngLat): boolean {
  return lng >= 73 && lng <= 135.1 && lat >= 18 && lat <= 53.6;
}

/** 时区看是不是国内（比坐标更可靠：Asia/Shanghai、Asia/Urumqi…）。 */
export function chinaTimezone(timezone: string | null | undefined): boolean {
  if (!timezone) return false;
  return /^(Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Kashgar)|PRC)$/i.test(timezone);
}

const transformLat = (x: number, y: number) => {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
};

const transformLng = (x: number, y: number) => {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
};

/** WGS84 → GCJ-02（发请求给高德前用）。 */
export function wgs84ToGcj02(point: LngLat): LngLat {
  // 不做地理屏蔽：调用方只在「这次走高德」时用这两个函数（见 providers.ts）。
  const [lng, lat] = point;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ-02 → WGS84（高德的点和路线顶点转回业务坐标）：迭代逼近，误差在米级。 */
export function gcj02ToWgs84(point: LngLat): LngLat {
  let guess: LngLat = [point[0], point[1]];
  for (let i = 0; i < 8; i += 1) {
    const forward = wgs84ToGcj02(guess);
    const dLng = point[0] - forward[0];
    const dLat = point[1] - forward[1];
    if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) break;
    guess = [guess[0] + dLng, guess[1] + dLat];
  }
  return guess;
}

/** 两点直线距离（米）：只用于「路线未取得」时的显式说明，不当步行路线。 */
export function straightDistanceMeters(a: LngLat, b: LngLat): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
}
