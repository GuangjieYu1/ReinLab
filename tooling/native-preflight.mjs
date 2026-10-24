import { requireNativeArtifact } from '../services/account-runtime/artifact.mjs';
export default function () {
  if (process.env.REINLAB_REQUIRE_NATIVE === '1') requireNativeArtifact();
}
