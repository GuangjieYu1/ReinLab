import { useMemo } from "react";
import ExploreStudio from "../components/workbenches/explore/ExploreStudio";
import LiveExplore from "../components/workbenches/explore/live/LiveExplore";
import { createMemoryExploreAdapter } from "../components/workbenches/explore/live/memoryAdapter";
import type { BenchProps } from "../components/workbenches/WorkbenchStudio";
import { liveBackend } from "./research-live";
import { createLiveExploreAdapter } from "./explore-live";
import FieldPage from "../components/workbenches/explore/live/field/FieldPage";
import { currentAccountId } from "./research-live";
import { delegateToSwarm, researchHref } from "./delegation-live";

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
  // 手机：工作台三栏放不下，直接进全屏现场（09-explore-v2.md：手机 / iPad 各一套）
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches && props.dossier)
    return <FieldPage adapter={adapter} title={props.dossier.title} dossierId={props.dossier.id} accountId={currentAccountId() ?? ""} />;
  const onDelegate = liveBackend && dossierId
    ? (question: string, background: string) => delegateToSwarm({ fromBench: "exploration", fromDossierId: dossierId, question, background }).then(r => ({ researchDossierId: r.researchDossierId, href: researchHref(r.researchDossierId) }))
    : undefined;
  return <LiveExplore key={dossierId ?? "memory"} {...props} adapter={adapter} onDelegate={onDelegate} />;
}
