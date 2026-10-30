/**
 * 地图公开配置（PRD 2.2、契约第 2 节、前端 adapter 的 MapConfig）。
 *
 * 只给浏览器「底图源 + 地图专用公开 key」，样式由前端画（莱茵语言）。
 * 矢量源默认 OpenFreeMap：免 key，符合 PRD 的选型；卫星和等高线用 MapTiler，
 * 没配置就是 null，页面把按钮置灰并写明没配置，不编造地址。
 * 其余服务凭据（高德 Web 服务、ORS、OpenTopography、DeepSeek）一律不出这个函数。
 */
export type MapConfigSource = Readonly<Record<string, string | undefined>>;

export type MapConfig = {
  /** OpenMapTiles 结构的矢量源；样式由前端画。 */
  vector: { tilejson: string; glyphs: string; attribution: string };
  satellite: { tilejson: string; attribution: string } | null;
  contours: { tilejson: string } | null;
  /** 地图专用公开 key（服务商端限制来源）；没有就是 null。 */
  publicKey: string | null;
  /** 还没配的项，页面据此说明底图为什么不可用。 */
  missing: string[];
};

const clean = (value: string | undefined): string | null => {
  const text = (value ?? "").trim();
  return text === "" ? null : text;
};

const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
const OPENFREEMAP_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const OPENFREEMAP_ATTRIBUTION = "© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap";

export function mapConfigFrom(source: MapConfigSource): MapConfig {
  const publicKey = clean(source.MAP_PUBLIC_KEY);
  const satelliteTilejson = clean(source.MAP_SATELLITE_TILEJSON);
  const contoursTilejson = clean(source.MAP_CONTOURS_TILEJSON);
  const missing: string[] = [];
  if (!satelliteTilejson) missing.push("MAP_SATELLITE_TILEJSON");
  if (!contoursTilejson) missing.push("MAP_CONTOURS_TILEJSON");
  if (!publicKey) missing.push("MAP_PUBLIC_KEY");
  return {
    vector: {
      tilejson: clean(source.MAP_VECTOR_TILEJSON) ?? OPENFREEMAP_TILEJSON,
      glyphs: clean(source.MAP_VECTOR_GLYPHS) ?? OPENFREEMAP_GLYPHS,
      attribution: clean(source.MAP_VECTOR_ATTRIBUTION) ?? OPENFREEMAP_ATTRIBUTION,
    },
    satellite: satelliteTilejson
      ? {
          tilejson: satelliteTilejson,
          // 卫星是历史影像，不称实时；署名按 MapTiler 官方要求。
          attribution: clean(source.MAP_ATTRIBUTION) ?? "© MapTiler © OpenStreetMap contributors",
        }
      : null,
    contours: contoursTilejson ? { tilejson: contoursTilejson } : null,
    publicKey,
    missing,
  };
}
