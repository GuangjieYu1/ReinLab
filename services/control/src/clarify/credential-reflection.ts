/** Buffer first; never release even a partial credential to the native process.
 * SSE choices and tool calls merge by declared index, including sparse/reordered arrays.
 */
export function reflectsCredential(text: string, secrets: string[]): boolean {
  const inspect = (value: unknown): boolean => {
    const pending: unknown[] = [value];
    let nodes = 0;
    while (pending.length) {
      if (++nodes > 20000) return true;
      const v = pending.pop();
      if (typeof v === "string") {
        if (secrets.some((s) => s && v.includes(s))) return true;
        if (/^[\s]*[\[{"]/.test(v))
          try {
            pending.push(JSON.parse(v));
          } catch {}
      } else if (v && typeof v === "object")
        pending.push(...Object.keys(v), ...Object.values(v));
    }
    return false;
  };
  if (inspect(text)) return true;
  const streams = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    let value: any;
    try {
      value = JSON.parse(raw);
    } catch {
      return true;
    }
    if (inspect(value)) return true;
    const pending = [{ path: "", value }];
    while (pending.length) {
      const { path, value: v } = pending.pop()!;
      if (typeof v === "string") {
        const combined = (streams.get(path) ?? "") + v;
        streams.set(path, combined);
        if (inspect(combined)) return true;
      } else if (Array.isArray(v)) {
        for (let pos = v.length - 1; pos >= 0; pos--) {
          const child = v[pos];
          pending.push({
            path:
              path +
              "/[" +
              (Number.isSafeInteger(child?.index) && child.index >= 0
                ? child.index
                : pos) +
              "]",
            value: child,
          });
        }
      } else if (v && typeof v === "object")
        Object.entries(v).forEach(([key, child]) =>
          pending.push({ path: path + "/" + JSON.stringify(key), value: child })
        );
    }
  }
  return false;
}
