/** 镜头（MVP-3）：读出来时算「依据旧了」的原因。 */

import type { Shot } from '@reinlab/contracts';
import type { CreativeDocument } from './world';
import { currentWhitebox } from './world';
import type { WorkDocument } from './work';

export type AssetSelection = { entityId: string; versionId: string | null; versionN: number | null };

/** 镜头依据是否旧了：白模出了新版、人物形象换版、正文这段改了。 */
export function staleOf(
  shot: Shot,
  document: CreativeDocument,
  work: WorkDocument | null,
  selected: Map<string, AssetSelection>,
): string[] {
  const reasons: string[] = [];
  const box = currentWhitebox(document, shot.placeId);
  if (box && box.version !== shot.whiteboxVersion) reasons.push(`白模出了第 ${box.version} 版`);
  for (const member of shot.cast) {
    const current = selected.get(member.entityId);
    if (current?.versionId && member.assetVersionId && current.versionId !== member.assetVersionId) {
      const name = document.entities.find((entity) => entity.id === member.entityId)?.name ?? '人物';
      reasons.push(`「${name}」出了第 ${current.versionN ?? '新'} 版形象`);
    }
  }
  if (work && shot.basisText) {
    const scene = work.chapters.flatMap((chapter) => chapter.scenes).find((item) => item.id === shot.sceneId);
    const paragraph = (scene?.text ?? '').split(/\n\s*\n/)[shot.para ?? 0] ?? '';
    if (paragraph.trim() && paragraph.trim() !== shot.basisText.trim()) reasons.push('正文这一段改过');
  }
  return reasons;
}

/** 读某一场的镜头，并把「依据旧了」算好。 */
export function shotsOfScene(
  document: CreativeDocument,
  work: WorkDocument | null,
  workId: string,
  sceneId: string,
  selected: Map<string, AssetSelection>,
): Shot[] {
  return ((document.shots ?? []) as Shot[])
    .filter((shot) => shot.workId === workId && shot.sceneId === sceneId)
    .sort((a, b) => a.n - b.n)
    .map((shot) => ({ ...shot, stale: staleOf(shot, document, work, selected) }));
}
