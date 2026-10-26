import { homedir } from "node:os";
import { join } from "node:path";
import { readRuntimeConfiguration } from "../configuration";
import { reflectsCredential } from "../clarify/credential-reflection";
import type { ModelPort } from "../clarify/model";

/** The provider key never leaves host memory; accounts only send run tokens. */
export function localModelPort(enabled: boolean): ModelPort | undefined {
  if (!enabled) return;
  return {
    async prepare() {
      const key = readRuntimeConfiguration(join(homedir(), ".config/reinlab/local.env")).DEEPSEEK_API_KEY;
      if (!key || /[\r\n]/.test(key)) throw Error("LOCAL_MODEL_KEY_UNAVAILABLE");
      return async body => {
        if (reflectsCredential(body.toString(), [key])) throw Error("MODEL_CREDENTIAL_REFLECTION");
        const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST", headers: {authorization: "Bearer " + key, "Content-Type": "application/json"},
          body, redirect: "error", signal: AbortSignal.timeout(60000),
        });
        if (!response.body) throw Error("MODEL_RESPONSE_UNKNOWN");
        const reader = response.body.getReader(), parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 524288) throw Error("MODEL_RESPONSE_LIMIT"); parts.push(part.value); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = Buffer.concat(parts);
        if (reflectsCredential(bytes.toString(), [key])) throw Error("MODEL_CREDENTIAL_REFLECTION");
        return new Response(bytes, {status: response.status, headers: {"Content-Type": "text/event-stream"}});
      };
    },
  };
}
