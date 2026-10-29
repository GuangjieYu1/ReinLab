import type { ReactNode } from 'react';

// 助手消息里的轻量 Markdown：只认链接 [文字](http…) 和加粗 **…**，其余原样显示。
// 不用 innerHTML，链接只放行 http/https，新窗口打开。
const TOKEN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;

export function RichText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<a key={k++} href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>);
    else out.push(<b key={k++}>{m[3]}</b>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
