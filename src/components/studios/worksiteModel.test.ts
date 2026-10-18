import { describe, expect, it } from 'vitest';
import { frameSvg, reviewDrafts, sceneAtTime, splitScript, type ReviewDraft } from './worksiteModel';

describe('artifact worksite',()=>{
  it('keeps paragraph content attached to its shot and selects the next shot at a duration boundary',()=>{
    const shots=splitScript('开场\n第一行\n第二行\n\n\n展开\n说明\n\n结尾');
    expect(shots).toHaveLength(3);expect(shots[0].text).toBe('第一行\n第二行');
    expect(sceneAtTime(shots,3.99)).toBe(0);expect(sceneAtTime(shots,4)).toBe(1);expect(sceneAtTime(shots,99)).toBe(2);
  });
  it('exports edited copy as escaped SVG text rather than markup',()=>{
    const svg=frameSvg({id:'1',title:'A & <script>"',text:'<image href="x"/>',seconds:4,composition:'title'},false);
    expect(svg).toContain('A &amp; &lt;script&gt;&quot;');expect(svg).not.toContain('<image');
    expect(frameSvg({id:'1',title:'竖版',text:'内容',seconds:4,composition:'title'},true,true)).toContain('viewBox="0 0 720 1280"');
  });
  it('requires confirmation before archiving and invalidates confirmation when copy changes',()=>{
    const pending:ReviewDraft[]=[{id:'1',source:'s1',title:'摘要',text:'草案',status:'pending'}];
    expect(reviewDrafts(pending,{type:'archive',id:'1'})[0].status).toBe('pending');
    const confirmed=reviewDrafts(pending,{type:'confirm',id:'1'});
    expect(reviewDrafts(confirmed,{type:'edit',id:'1',text:'修改'})[0].status).toBe('pending');
    const archived=reviewDrafts(confirmed,{type:'archive',id:'1'});
    expect(archived[0].status).toBe('archived');expect(reviewDrafts(archived,{type:'edit',id:'1',text:'改写'})[0].text).toBe('草案');
  });
});
