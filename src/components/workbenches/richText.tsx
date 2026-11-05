import { createContext, useContext, type ReactNode } from 'react';

// 助手消息里的轻量 Markdown：只认链接 [文字](http…)、加粗 **…**、照片引用 ![说明](photo:<id>)，其余原样显示。
// 不用 innerHTML，链接只放行 http/https，新窗口打开；照片只认本档案的照片 id，由宿主给出图片地址。
const TOKEN = /!\[([^\]]*)\]\(photo:([\w-]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;

/** 照片 id → 图片地址。没有宿主时照片引用显示成文字。 */
export const PhotoRef = createContext<((id: string) => string) | null>(null);

/** 正文里出现的 id（如群研成稿引用的结论 / 证据 id）→ 可点的小标签。宿主认不出就返回 null，原样显示。 */
export type IdLookup = (id: string) => { label: string; title?: string; open: () => void } | null;
export const IdRef = createContext<IdLookup | null>(null);
// 完整 uuid，或写作 8 位前缀（成稿里常写成〔af7b43dc〕）；认不出的原样留着
const UUID = /`?\b([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)\b(?!-)`?/gi;
function linkIds(text: string, ref: IdLookup, key: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0, k = 0;
  for (const m of text.matchAll(UUID)) {
    const hit = ref(m[1].toLowerCase());
    if (!hit) continue;
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<button key={`${key}-${k++}`} type="button" className="rt-id" title={hit.title} onClick={hit.open}>{hit.label}</button>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text }: { text: string }) {
  const photo = useContext(PhotoRef), ids = useContext(IdRef);
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  const plain = (t: string) => ids ? out.push(...linkIds(t, ids, `t${k++}`)) : out.push(t);
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) plain(text.slice(last, m.index));
    if (m[2]) out.push(photo ? <figure key={k++} className="rt-photo"><img src={photo(m[2])} alt={m[1]} loading="lazy" />{m[1] && <figcaption>{m[1]}</figcaption>}</figure> : <span key={k++}>［照片：{m[1] || m[2].slice(0, 8)}］</span>);
    else if (m[3]) out.push(<a key={k++} href={m[4]} target="_blank" rel="noopener noreferrer">{m[3]}</a>);
    else out.push(<b key={k++}>{m[5]}</b>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
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
