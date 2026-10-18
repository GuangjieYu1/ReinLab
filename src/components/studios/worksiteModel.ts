export type StudioId = 'research' | 'engineering' | 'creative' | 'automation' | 'exploration';
export type StudioFile = { id: string; title: string; brief: string; status: string; fresh?: boolean };
export type Shot = { id: string; title: string; text: string; seconds: number; composition: 'title' | 'sequence' | 'quote' };

export function splitScript(script: string): Shot[] {
  return script.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).slice(0, 12).map((part, index) => {
    const [title, ...body] = part.split('\n').map(line => line.trim()).filter(Boolean);
    return { id: `scene-${index+1}`, title: title.slice(0, 80), text: body.join('\n'), seconds: index===0?4:6, composition: index===0?'title':index%2?'sequence':'quote' };
  });
}
export function sceneAtTime(shots: Shot[], time: number): number {
  let end=0;
  for(let i=0;i<shots.length;i++){end+=shots[i].seconds;if(time<end)return i;}
  return Math.max(0,shots.length-1);
}
export function xmlText(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
export function frameSvg(shot: Shot, green: boolean, portrait = false): string {
  const paper=green?'#edf1e3':'#f8f4e9';
  const lines=shot.text.split('\n').filter(Boolean).slice(0,4);
  const width=portrait?720:1280,height=portrait?1280:720;
  const architecture=`<g transform="translate(${portrait?100:770} ${portrait?730:320}) scale(${portrait?2:1.6})"><path d="M12 117L125 42L246 85L133 164Z" fill="#c5bea32b"/>${[0,1,2,3].map(index=>`<g transform="translate(${index*29} ${-index*14})"><path d="M30 54L80 23V122L30 153Z" fill="#e4ddc8"/><path d="M80 23L94 32V131L80 122Z" fill="#c1b599"/><path d="M30 54L44 63L94 32L80 23Z" fill="#faf5e8"/></g>`).join('')}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${paper}"/><path d="M60 80H${width-60}M60 ${height-80}H${width-60}" stroke="#c5cfb5"/><text x="60" y="120" fill="#a1ae8b" font-size="14" font-family="sans-serif">REINLAB / FIELD NOTES</text>${architecture}<text x="70" y="${portrait?350:285}" fill="#48583b" font-size="${portrait?48:56}" font-family="sans-serif">${xmlText(shot.title)}</text>${lines.map((line,index)=>`<text x="73" y="${(portrait?430:350)+index*40}" fill="#7a8b66" font-size="22" font-family="sans-serif">${xmlText(line)}</text>`).join('')}<text x="60" y="${height-40}" fill="#99a785" font-size="14" font-family="sans-serif">${shot.seconds}s / WORKING DRAFT</text></svg>`;
}
export function downloadText(name:string, text:string, mime='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export type ReviewDraft = { id: string; source: string; title: string; text: string; status: 'pending'|'confirmed'|'rejected'|'archived' };
export type ReviewAction = { type:'edit';id:string;text:string } | { type:'confirm'|'reject'|'archive';id:string };
export function reviewDrafts(drafts:ReviewDraft[], action:ReviewAction):ReviewDraft[] {
  return drafts.map(draft=>{
    if(draft.id!==action.id||draft.status==='archived')return draft;
    if(action.type==='edit')return {...draft,text:action.text,status:'pending'};
    if(action.type==='confirm'&&draft.status==='pending')return {...draft,status:'confirmed'};
    if(action.type==='reject'&&draft.status!=='rejected')return {...draft,status:'rejected'};
    if(action.type==='archive'&&draft.status==='confirmed')return {...draft,status:'archived'};
    return draft;
  });
}
