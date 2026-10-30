import { useMemo } from "react";
import ExploreStudio from "../components/workbenches/explore/ExploreStudio";
import LiveExplore from "../components/workbenches/explore/live/LiveExplore";
import { createMemoryExploreAdapter } from "../components/workbenches/explore/live/memoryAdapter";
import type { BenchProps } from "../components/workbenches/WorkbenchStudio";
import { liveBackend } from "./research-live";
import { createLiveExploreAdapter } from "./explore-live";

/**
 * 探索台：真实模式接控制面（每份档案一个适配器）；演示模式仍是京都示例。
 * 演示模式下加 ?explore=memory 可以看真实界面的本地内存版（真实地图，不连后端、不调模型）。
 */
export default function ExploreStudioData(props: BenchProps) {
  const dossierId = props.dossier?.id;
  const memory = !liveBackend && new URLSearchParams(window.location.search).get("explore") === "memory";
  const adapter = useMemo(
    () => (liveBackend && dossierId ? createLiveExploreAdapter(dossierId) : memory ? createMemoryExploreAdapter() : undefined),
    [dossierId, memory]
  );
  if (!adapter) return <ExploreStudio {...props} />;
  return <LiveExplore key={dossierId ?? "memory"} {...props} adapter={adapter} />;
}
