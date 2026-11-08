import { useMemo } from 'react';
import CreativeStudio from '../components/workbenches/creative/CreativeStudio';
import LiveWorld from '../components/workbenches/creative/live/LiveWorld';
import type { BenchProps } from '../components/workbenches/WorkbenchStudio';
import { liveBackend } from './research-live';
import { createLiveCreativeAdapter } from './creative-live';

/**
 * 创作台：真实模式接控制面（每份档案一个世界观，20-creative-contract.md）；演示模式仍是魔戒示例。
 * 1A 世界观与 1B 小说已接真实数据，视频留到 MVP-3。
 */
export default function CreativeStudioData(props: BenchProps) {
  const dossierId = props.dossier?.id;
  const adapter = useMemo(() => (liveBackend && dossierId ? createLiveCreativeAdapter(dossierId) : undefined), [dossierId]);
  if (!adapter) return <CreativeStudio {...props} />;
  return <LiveWorld key={dossierId} {...props} adapter={adapter} />;
}
