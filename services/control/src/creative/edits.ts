/**
 * 改造层 GeoJSON（20-creative-contract.md §2：`edits/geojson?t=`）。
 *
 * 只给「这一时刻生效的改造」（19 §3）：新增几何、藏在底图上的对象、改名、样式、
 * 通行变化。底图负责展示，这里只叠在上面；改不动底图本身。
 *
 * target.osm.id 用地图瓦片上的 feature.id（OpenMapTiles：floor(id/10) 就是 OSM id），
 * 所以「隐藏、改名」能按 id 精确对准；路网同一份 id 在边表里也能对上。
 */

import type pg from 'pg';
import type { GeoJSON } from '@reinlab/contracts';
import { boundsOf } from './story-time';
import { loadWorld } from './service';

export type EditFeature = {
  type: 'Feature';
  geometry: GeoJSON.Geometry | null;
  properties: Record<string, unknown>;
};

export type EditCollection = { type: 'FeatureCollection'; features: EditFeature[] };

const activeAt = (
  valid: { from: { t: number | null; range?: [number, number] | null } | null; to: { t: number | null; range?: [number, number] | null } | null },
  at: number,
): boolean => {
  const from = valid?.from ? (valid.from.range ? valid.from.range[0] : boundsOf(valid.from).start) : null;
  const to = valid?.to ? (valid.to.range ? valid.to.range[1] : boundsOf(valid.to).end) : null;
  if (from !== null && at < from) return false;
  if (to !== null && at > to) return false;
  return true;
};

/** 这一时刻生效的改造。t 不传就给时间轴上最早的一刻。 */
export async function editsGeoJson(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  at: number | null,
): Promise<EditCollection> {
  const state = await loadWorld(client, account, dossier);
  const document = state.document;
  const moment =
    at ??
    document.events
      .map((event) => boundsOf(event.start).start)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)[0] ??
    0;
  const features: EditFeature[] = [];
  for (const edit of document.edits) {
    if (!activeAt(edit.valid ?? { from: null, to: null }, moment)) continue;
    const properties: Record<string, unknown> = {
      editId: edit.id,
      title: edit.title,
      effect: edit.effect,
      style: edit.props?.style ?? null,
      name: edit.props?.name ?? null,
      passable: edit.passable ?? null,
      needsRemap: edit.needsRemap ?? false,
    };
    if (edit.effect === 'add' && edit.geometry) {
      features.push({ type: 'Feature', geometry: edit.geometry, properties });
      continue;
    }
    const osmId = edit.target?.osm?.id;
    if (typeof osmId === 'number') {
      // 边表里同一份 OSM id：把要藏/要改名/要封的那几段路原样给出来，前端能精确叠。
      const osmKey = String(Math.floor(osmId / 10));
      const rows = (
        await client.query<{ coordinates: [number, number][] }>(
          `select st_asgeojson(geom)::json -> 'coordinates' coordinates
             from creative_edge
            where account_id=$1 and dossier_id=$2 and osm_id=$3`,
          [account, dossier, osmKey],
        )
      ).rows;
      for (const row of rows)
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: row.coordinates },
          properties: { ...properties, osm: edit.target?.osm ?? null },
        });
      if (!rows.length) features.push({ type: 'Feature', geometry: null, properties: { ...properties, osm: edit.target?.osm ?? null } });
      continue;
    }
    if (edit.target?.area) {
      features.push({ type: 'Feature', geometry: edit.target.area, properties });
      continue;
    }
    if (edit.target?.placeId) {
      const place = document.entities.find((item) => item.id === edit.target?.placeId);
      features.push({ type: 'Feature', geometry: place?.place?.geo ?? null, properties: { ...properties, placeId: place?.id ?? null } });
      continue;
    }
    features.push({ type: 'Feature', geometry: edit.geometry ?? null, properties });
  }
  return { type: 'FeatureCollection', features };
}
