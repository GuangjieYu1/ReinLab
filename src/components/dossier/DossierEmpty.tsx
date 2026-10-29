import type { Dossier } from './adapter';
import { when } from './store';
import './dossier.css';

/** 真实模式下的两种「没有工作区内容」：
 *  none —— 这个台还没有档案（续上次也没有），给新建入口，不自动建档；
 *  shell —— 档案是真的，但这个台的专业能力还没接入：只展示档案本身，不拿示例对话 / 成果冒充档案内容。 */
export default function DossierEmpty({ mode, title, noun, dossier, onCreate, onOpenMenu }: {
  mode: 'none' | 'shell' | 'deleted'; title: string; noun: string; dossier?: Dossier | null;
  onCreate?: () => void; onOpenMenu?: () => void;
}) {
  return <div className="de rh">
    <div className="de-card">
      {mode === 'none' && <>
        <span className="rh-micro">FILES · {title}</span>
        <h2>还没有{noun}档案</h2>
        <p>新建一份档案，或者从顶部的档案菜单里找回已有的。</p>
        <div className="dsc-acts"><button className="rh-btn is-solid" onClick={onCreate}>＋ 新建{noun}档案</button><button className="rh-btn" onClick={onOpenMenu}>打开档案菜单</button></div>
      </>}
      {mode === 'deleted' && <>
        <span className="rh-micro">DELETED</span>
        <h2>这份档案已删除</h2>
        <p>它不会再出现在列表、搜索和续上次里。原始文件和外部课程没有被删除。</p>
        <div className="dsc-acts"><button className="rh-btn" onClick={onOpenMenu}>打开档案菜单</button></div>
      </>}
      {mode === 'shell' && dossier && <>
        <span className="rh-micro">{title} · 档案</span>
        <h2>{dossier.title}</h2>
        {dossier.intent && <p className="de-intent">{dossier.intent}</p>}
        <dl>
          <div><dt>最近活动</dt><dd>{when(dossier.lastActivityAt)}</dd></div>
          <div><dt>成果</dt><dd>{dossier.artifacts.total ? `${dossier.artifacts.total} 项` : '还没有'}</dd></div>
        </dl>
        <p className="de-note">这个工作台的专业能力还没接入真实后端。档案已经保存，可以改名、写目标、归档或删除；等能力接入后，在这里继续工作。</p>
        <div className="dsc-acts"><button className="rh-btn" onClick={onOpenMenu}>档案菜单</button></div>
      </>}
    </div>
  </div>;
}
