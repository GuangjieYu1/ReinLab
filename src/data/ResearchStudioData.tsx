import { useMemo } from "react";
import ResearchStudio from "../components/workbenches/research/ResearchStudio";
import type { BenchProps } from "../components/workbenches/WorkbenchStudio";
import { liveBackend } from "./research-live";
import { createLiveReadAdapter } from "./read-live";

/** Claude's unchanged studio forwards these data props to ReadMode via {...props}. */
export default function ResearchStudioData(props: BenchProps) {
  // 每份档案一个适配器：打开哪份就读哪份（地基第 4 项），不再自己挑「最近一份」。
  const dossierId = props.dossier?.id;
  const adapter = useMemo(
    () => (liveBackend ? createLiveReadAdapter(dossierId) : undefined),
    [dossierId]
  );
  if (!liveBackend) return <ResearchStudio {...props} />;
  const live = {
    ...props,
    adapter,
    available: ["read"] as ["read"],
  };
  return <ResearchStudio {...live} />;
}
