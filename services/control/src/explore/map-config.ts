/**
 * 地图公开配置（PRD 2.2、契约第 2 节）。
 *
 * 只有地图专用公开 key 会下发到浏览器：服务商端限制 Allowed HTTP origins，
 * 其余密钥（高德 Web 服务、ORS、OpenTopography、DeepSeek）一律不出这个函数。
 * 没配置就返回 null 并列出缺项，页面显示底图不可用，不编造样式地址。
 */
export type MapConfigSource = Readonly<Record<string, string | undefined>>;

export type MapConfig = {
  vectorStyle: string | null;
  satellite: { tilejson: string; attribution: string } | null;
  contours: { tilejson: string } | null;
  publicKey: string | null;
  missing: string[];
};

const clean = (value: string | undefined): string | null => {
  const text = (value ?? "").trim();
  return text === "" ? null : text;
};

export function mapConfigFrom(source: MapConfigSource): MapConfig {
  const publicKey = clean(source.MAP_PUBLIC_KEY);
  const vectorStyle = clean(source.MAP_VECTOR_STYLE);
  const satelliteTilejson = clean(source.MAP_SATELLITE_TILEJSON);
  const contoursTilejson = clean(source.MAP_CONTOURS_TILEJSON);
  const attribution =
    clean(source.MAP_ATTRIBUTION) ??
    "© MapTiler © OpenStreetMap contributors";
  const missing: string[] = [];
  if (!publicKey) missing.push("MAP_PUBLIC_KEY");
  if (!vectorStyle) missing.push("MAP_VECTOR_STYLE");
  if (!satelliteTilejson) missing.push("MAP_SATELLITE_TILEJSON");
  if (!contoursTilejson) missing.push("MAP_CONTOURS_TILEJSON");
  return {
    // 卫星和等高线的地址里带公开 key 时，地图库会自己拼 tilejson 地址。
    vectorStyle,
    satellite: satelliteTilejson ? { tilejson: satelliteTilejson, attribution } : null,
    contours: contoursTilejson ? { tilejson: contoursTilejson } : null,
    publicKey,
    missing,
  };
}
