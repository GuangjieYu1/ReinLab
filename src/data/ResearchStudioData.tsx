import { useMemo } from "react";
import ResearchStudio from "../components/workbenches/research/ResearchStudio";
import type { BenchProps } from "../components/workbenches/WorkbenchStudio";
import { liveBackend } from "./research-live";
import { liveReadAdapter } from "./read-live";

/** Claude's unchanged studio forwards these data props to ReadMode via {...props}. */
export default function ResearchStudioData(props: BenchProps) {
  const adapter = useMemo(
    () => (liveBackend ? liveReadAdapter() : undefined),
    []
  );
  if (!liveBackend) return <ResearchStudio {...props} />;
  const live = {
    ...props,
    adapter,
    available: ["read"] as ["read"],
  };
  return <ResearchStudio {...live} />;
}
