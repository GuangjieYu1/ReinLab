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

/**
 * 段落级的轻量 Markdown：标题（#）、无序 / 有序列表、表格（| a | b |）、分隔线、段落。
 * 行内仍交给 RichText（链接、加粗）。助手回答常带表格和列表，原样显示太难读。
 */
export function RichBlocks({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0, k = 0;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(l); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(<table key={k++} className="rt-table"><thead><tr>{head.map((h, j) => <th key={j}><RichText text={h} /></th>)}</tr></thead>
        <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, n) => <td key={n}><RichText text={c} /></td>)}</tr>)}</tbody></table>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push(<p key={k++} className="rt-h"><b><RichText text={h[2]} /></b></p>); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { out.push(<hr key={k++} className="rt-hr" />); i++; continue; }
    if (/^\s*([-*]|\d+[.)、])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l), items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)、])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+[.)、])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={k++} className="rt-list">{items.map((t, j) => <li key={j}><RichText text={t} /></li>)}</List>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*]|\d+[.)、])\s+/.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={k++}><RichText text={para.join('\n')} /></p>);
  }
  return <>{out}</>;
}
