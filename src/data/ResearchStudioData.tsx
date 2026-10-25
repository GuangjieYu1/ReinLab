import { useMemo } from "react";
import ResearchStudio from "../components/workbenches/research/ResearchStudio";
import InboxHost from "../components/inbox/InboxHost";
import type { BenchProps } from "../components/workbenches/WorkbenchStudio";
import { liveBackend } from "./research-live";
import { liveReadAdapter } from "./read-live";
import { liveInboxAdapter } from "./inbox-live";

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
    chrome: {
      ...props.chrome,
      file: (
        <>
          {props.chrome.file}
          <InboxHost autoOpen adapter={liveInboxAdapter} />
        </>
      ),
    },
  };
  return <ResearchStudio {...live} />;
}
