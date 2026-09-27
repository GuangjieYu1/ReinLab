import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SlideCanvas } from '@openmaic/renderer';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, CircleAlert, Layers } from 'lucide-react';
import { CourseApiError, fetchCourse, quizOf, slideOf, type RemoteCourse, type RemoteMediaRef, type RemoteScene } from './courseApi';
import { readCachedCourse } from './courseCache';
import { buildLocalMediaMap } from './courseLibrary';
import { collectRemoteMediaUrls, rewriteMediaUrls } from './mediaRewrite';
import { bookmarkFor, readProgress, resolveStartIndex, seenCount, withBookmark, writeProgress } from './courseProgress';
import './native-course.css';

/**
 * 原生场景编排器。
 *
 * 取代不可移植的 OpenMAIC ClassroomSurface（531 行，深度耦合 zustand store 与
 * document-store）。这里只做四件事：把课程数据变成可渲染的场景、切换场景、
 * 记住位置、把媒体地址换成离线可用的本地地址。
 *
 * 关于「为什么优先读缓存」：在线时也可以直接拉最新数据，但那样每次打开课程都会
 * 重新下载几十 MB 的课程 JSON，而且飞机上就打不开了。缓存优先 + 列表页上的
 * 「有更新」标记，把「要最新的」还是「要能用的」这个选择交回给用户。
 */

/**
 * 单张幻灯片渲染失败的兜底。
 *
 * 课程里可能含图表（需要 echarts）或代码块（需要 shiki），这两个是可选的
 * peer 依赖，本仓库没有装。渲染器对它们各自有降级，但那是包内实现细节；
 * 万一还有别的元素抛错，边界能保证「这一页不好看」而不是「整门课白屏」。
 */
class SlideBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface ReadyState {
  status: 'ready';
  course: RemoteCourse;
  scenes: RemoteScene[];
  media: RemoteMediaRef[];
  /** 是否来自本地缓存（离线可用）。 */
  local: boolean;
  /** 本地缓存里下载失败的资源数。 */
  failedMedia: number;
  /** 替换成本地地址之后，课程里仍然指向远端的资源数。 */
  uncached: number;
}

type LoadState = { status: 'loading' } | ReadyState | { status: 'error'; message: string };

export default function NativeCourse({ courseId, origin, token, reduced, onBack, onOpenOnline, notify }: {
  courseId: string;
  origin: string;
  token?: string;
  reduced: boolean;
  onBack: () => void;
  onOpenOnline: () => void;
  notify: (message: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [index, setIndex] = useState(0);
  const [seen, setSeen] = useState(0);
  const [mediaMap, setMediaMap] = useState<Map<string, string>>(new Map());
  const revokeRef = useRef<(() => void) | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // 存储不可用只提示一次：每翻一页都弹一遍会把课程页面变成告警墙。
  const warned = useRef(false);

  /**
   * 把加载好的课程落到状态里，并**在同一次更新中**决定从哪个场景开始。
   *
   * 这两件事必须一起做：如果先 setState 再由另一个 effect 去 setIndex，那次
   * effect 会在同一个提交里先按旧的下标（0）写一次书签，把用户上次的位置冲掉——
   * 「打开课程就回到第一页」正是这么来的。解析出来的下标与写回的书签必须是同一个值。
   */
  const applyReady = useCallback((next: ReadyState) => {
    const ids = next.scenes.map(scene => scene.id);
    const start = resolveStartIndex(bookmarkFor(readProgress(), courseId), ids);
    setState(next);
    setIndex(start);
    const scene = next.scenes[start];
    if (scene) {
      const saved = writeProgress(withBookmark(readProgress(), courseId, scene.id, start));
      if (!saved && !warned.current) {
        warned.current = true;
        notify('浏览器存储不可用，续读位置只在本次会话中保留。');
      }
    }
    setSeen(seenCount(readProgress(), courseId, ids));
  }, [courseId, notify]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const cached = await readCachedCourse(courseId).catch(() => null);
      if (cancelled) return;
      if (cached) {
        // 先建本地地址表：离线时它决定课程能不能显示图像。
        const local = await buildLocalMediaMap(courseId).catch(() => ({ map: new Map<string, string>(), revoke: () => {} }));
        if (cancelled) { local.revoke(); return; }
        revokeRef.current?.();
        revokeRef.current = local.revoke;
        setMediaMap(local.map);
        applyReady(describe(cached.course, cached.media, true, cached.failedMedia, local.map));
        return;
      }
      // 没有缓存时才去取：在线读也走这条路，因此不必额外探测一次连通性，
      // 失败原因（断网 / 404 / 形状不对）由 CourseApiError.kind 区分。
      try {
        const payload = await fetchCourse(origin, courseId, { token });
        if (cancelled) return;
        applyReady(describe(payload.course, payload.media, false, 0, new Map()));
      } catch (error) {
        if (cancelled) return;
        const offline = error instanceof CourseApiError && error.kind === 'offline';
        setState({
          status: 'error',
          message: offline
            ? '这门课程还没有下载到本机，且当前无法连接 OpenMAIC。'
            : error instanceof CourseApiError ? error.message : '课程读取失败。',
        });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [applyReady, courseId, origin, token]);

  // 离开课程时释放 Blob URL：它们会把整份媒体数据钉在内存里，反复开关同一门课
  // 而不释放，是 iPad 上最容易被忽略的内存泄漏。
  useEffect(() => () => { revokeRef.current?.(); revokeRef.current = null; }, []);

  const scenes = state.status === 'ready' ? state.scenes : [];
  const sceneIds = useMemo(() => scenes.map(scene => scene.id), [scenes]);

  const remember = useCallback((next: number) => {
    if (state.status !== 'ready') return;
    const scene = state.scenes[next];
    if (!scene) return;
    const saved = writeProgress(withBookmark(readProgress(), courseId, scene.id, next));
    if (!saved && !warned.current) {
      warned.current = true;
      notify('浏览器存储不可用，续读位置只在本次会话中保留。');
    }
    setSeen(seenCount(readProgress(), courseId, sceneIds));
  }, [courseId, notify, sceneIds, state.status]);

  const go = useCallback((delta: number) => {
    setIndex(current => {
      const next = Math.min(Math.max(0, current + delta), Math.max(0, sceneIds.length - 1));
      if (next !== current) remember(next);
      return next;
    });
  }, [remember, sceneIds.length]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); go(1); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [go]);

  const scene = scenes[index] ?? null;

  if (state.status === 'loading') {
    return <div className="nc-view"><div className="nc-empty"><b>正在打开课程…</b>读取本机缓存与课程数据。</div></div>;
  }

  if (state.status === 'error') {
    return <div className="nc-view">
      <button className="text-link" onClick={onBack}><ArrowLeft size={14} />返回课程档案</button>
      <div className="nc-empty">
        <b>无法打开这门课程</b>
        {state.message}<br />
        <button className="text-link" onClick={onOpenOnline}>前往在线课程库 <ArrowRight size={13} /></button>
      </div>
    </div>;
  }

  const total = scenes.length;

  return <div className={`nc-reader ${reduced ? 'nc-reduced' : ''}`}>
    <div className="nc-reader-bar">
      <button className="text-link" onClick={onBack}><ArrowLeft size={14} />课程档案</button>
      <h1>{state.course.name}</h1>
      <span className="nc-reader-code">{state.local ? 'LOCAL / OFFLINE-READY' : 'ONLINE'}</span>
      <span className="nc-reader-spacer" />
      <span className="nc-reader-code">{total > 0 ? `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}` : '00 / 00'}</span>
    </div>

    {state.failedMedia > 0 && <p className="nc-media-warning">
      <CircleAlert size={12} /> 本课有 {state.failedMedia} 个资源在下载时失败，离线查看时这些位置会是空的。联网后重新下载可以补齐。
    </p>}
    {state.uncached > 0 && <p className="nc-media-warning">
      <CircleAlert size={12} /> 课程里仍有 {state.uncached} 个资源指向远端地址（服务端的媒体清单未涵盖它们），离线时可能无法显示。
    </p>}

    {scene ? <>
      <div
        className="nc-stage"
        onTouchStart={event => {
          const touch = event.touches[0];
          touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={event => {
          const start = touchStart.current;
          touchStart.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          // 只在横向位移明显大于纵向时翻页：课程里的幻灯片可能自己带横向滚动或
          // 拖拽，手势判定太宽松会让它们无法使用。
          if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
          go(dx < 0 ? 1 : -1);
        }}
      >
        <div className="nc-slide-host">
          <SceneSurface scene={scene} mediaMap={mediaMap} onOpenOnline={onOpenOnline} />
        </div>
      </div>

      <div className="nc-pager">
        <button className="nc-pager-button" onClick={() => go(-1)} disabled={index === 0} aria-label="上一个场景">
          <ChevronLeft size={15} />上一个
        </button>
        <span className="nc-pager-index">{total > 0 ? `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}` : '00 / 00'}</span>
        <span className="nc-pager-title">{scene.title || `场景 ${index + 1}`}</span>
        <button className="nc-pager-button" onClick={() => go(1)} disabled={index >= total - 1} aria-label="下一个场景">
          下一个<ChevronRight size={15} />
        </button>
      </div>

      {total > 1 && <div className="nc-strip" role="tablist" aria-label="场景列表">
        {scenes.map((item, i) => <button
          key={item.id}
          role="tab"
          aria-current={i === index}
          aria-label={`场景 ${i + 1}：${item.title || '未命名'}`}
          className={i < index ? 'seen' : ''}
          onClick={() => { setIndex(i); remember(i); }}
        >{String(i + 1).padStart(2, '0')}</button>)}
      </div>}
    </> : <div className="nc-empty"><b>这门课程还没有场景</b>课程数据是空的，可能生成过程没有完成。</div>}

    <div className="nc-reader-footer">
      <span>看过 {seen} / {total} 个场景 · 位置已保存在本机</span>
      <span>{state.local ? 'LOCAL COPY' : 'STREAMED FROM OPENMAIC'}</span>
    </div>
  </div>;
}

/**
 * 一个场景的画面。
 *
 * 单独抽出来是为了能被直接测试：{@link SceneSurface} 是「课程数据 → 屏幕上的
 * 东西」这条链路上唯一有分支的一段（幻灯片 / 测验 / 不支持的场景），把它做成
 * 纯组件就能用一份课程形状的样例把它整条跑通，而不必去驱动整个异步加载流程。
 */
export function SceneSurface({ scene, mediaMap, onOpenOnline }: {
  scene: RemoteScene;
  mediaMap: ReadonlyMap<string, string>;
  onOpenOnline: () => void;
}) {
  const slide = useMemo(() => {
    const raw = slideOf(scene);
    return raw ? rewriteMediaUrls(raw, mediaMap) : null;
  }, [scene, mediaMap]);

  if (!slide) return <SceneFallback scene={scene} onOpenOnline={onOpenOnline} />;
  return <SlideBoundary fallback={<div className="nc-scene-note">
    <span>RENDER FALLBACK</span>
    <h3>这一页含有本机暂不支持的图表或代码元素。</h3>
    <p>幻灯片本身已加载，但其中一部分内容需要 OpenMAIC 在线页面才能完整显示。其余场景不受影响。</p>
  </div>}>
    <SlideCanvas slide={slide} />
  </SlideBoundary>;
}

/**
 * 非幻灯片场景的说明面板。
 *
 * quiz 直接以只读形式展示题目——它是纯数据，离线也能完整呈现，没必要让用户
 * 为了看两道题去联网。interactive / pbl 依赖在线运行时，只能如实说明并提供
 * 入口，不伪造一个假的交互界面。
 */
function SceneFallback({ scene, onOpenOnline }: { scene: RemoteScene; onOpenOnline: () => void }) {
  const questions = quizOf(scene);
  if (questions.length > 0) {
    return <div className="nc-scene-note">
      <span>QUIZ / {questions.length} 题</span>
      <h3>{scene.title || '本场景的测验'}</h3>
      <ol>{questions.map(question => <li key={question.id}>
        {question.question}
        {question.options && question.options.length > 0 && <ul>{question.options.map(option => <li key={option.value}>{option.label}</li>)}</ul>}
        {question.analysis && <p>{question.analysis}</p>}
      </li>)}</ol>
      <p>原生层只展示题目内容，不记录作答。答题与评分仍在 OpenMAIC 的在线课堂里完成。</p>
    </div>;
  }
  const label = scene.type === 'interactive' ? '交互页面' : scene.type === 'pbl' ? '项目式学习' : '未知类型';
  return <div className="nc-scene-note">
    <span>UNSUPPORTED NATIVELY / {scene.type.toUpperCase()}</span>
    <h3>{scene.title || '本场景'} 是一个{label}场景。</h3>
    <p>这类场景由 OpenMAIC 的在线运行时驱动（内嵌页面、项目任务与实时反馈），无法在离线状态下原生渲染。</p>
    <p>其余幻灯片场景不受影响，可以继续用上一页 / 下一页浏览。</p>
    <button className="nc-pager-button" onClick={onOpenOnline}><Layers size={14} />在在线课堂中打开</button>
  </div>;
}

/** 把取到的课程整理成渲染需要的形状，并算出「还有多少资源没被本地化」。 */
function describe(course: RemoteCourse, media: RemoteMediaRef[], local: boolean, failedMedia: number, map: ReadonlyMap<string, string>): ReadyState {
  const rewritten = map.size > 0 ? rewriteMediaUrls(course.scenes, map) : course.scenes;
  return {
    status: 'ready',
    course,
    scenes: rewritten,
    media,
    local,
    failedMedia,
    uncached: collectRemoteMediaUrls(rewritten).length,
  };
}
