import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, CloudDownload, Download, HardDrive, Loader2, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import { CourseApiError, fetchCourseList, probeExport, type RemoteCourseSummary } from './courseApi';
import { DEFAULT_QUOTA_BYTES, cachedBytes, deleteCachedCourse, isCacheAvailable, listCachedCourses, type CachedCourse } from './courseCache';
import { QuotaExceededError, describeQuota, downloadCourse, hasQuota, mergeLibrary, statusLabel, type DownloadProgress, type LibraryEntry } from './courseLibrary';
import { readCourseIndex, writeCourseIndex } from './courseIndex';
import { withoutCourse, readProgress, writeProgress } from './courseProgress';
import { formatBytes } from './mediaRewrite';
import './native-course.css';

/**
 * 原生课程库：学习档案的入口页。
 *
 * 这一页要同时回答三个问题——「线上有什么」「本机已经有什么」「现在能不能拿到」。
 * 因此它把在线列表和本地缓存合成一份视图（mergeLibrary），而不是维护两个列表
 * 让用户自己去对照。
 */

export default function NativeCourseLibrary({ origin, token, onOpen, onOpenOnline, onOpenSettings, notify }: {
  origin: string;
  token?: string;
  onOpen: (courseId: string) => void;
  /** 打开应用内浏览器里的在线课程库（浏览未下载的课程、生成新课程）。 */
  onOpenOnline: () => void;
  onOpenSettings: () => void;
  notify: (message: string) => void;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  /** 服务可达但没有配置课程库（服务端没有 DATABASE_URL）。 */
  const [noLibrary, setNoLibrary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [usedBytes, setUsedBytes] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [notice, setNotice] = useState('');
  const cacheAvailable = isCacheAvailable();

  /**
   * 刷新：先并行探测连通性与读本地缓存，再决定要不要拉线上列表。
   *
   * 顺序是有意的——离线时绝不能因为一次 fetch 失败就把本地列表也清空。
   * 探测失败仍然把已下载的课程显示出来，这正是「飞机上能看课」的实现方式。
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setNotice('');
    const local = cacheAvailable ? await listCachedCourses().catch(() => [] as CachedCourse[]) : [];
    const bytes = cacheAvailable ? await cachedBytes().catch(() => 0) : 0;
    setUsedBytes(bytes);
    const status = await probeExport(origin, { token });
    const reachable = status.reachable;
    setOnline(reachable);
    setNoLibrary(reachable && !status.persistence);
    let remote: RemoteCourseSummary[] | null = null;
    if (reachable && status.persistence) {
      try {
        remote = await fetchCourseList(origin, { token });
        // 记下这次看到的课程，离线时才能把未下载的课标成「需要连接」而不是让
        // 它们从列表里凭空消失。
        writeCourseIndex(remote);
      } catch (error) {
        // 探测过了但列表失败：退回上次的索引，但把原因说出来。
        setNotice(error instanceof CourseApiError ? error.message : '无法读取课程列表');
        remote = readCourseIndex()?.courses ?? null;
      }
    } else {
      remote = readCourseIndex()?.courses ?? null;
    }
    setEntries(mergeLibrary(remote, local, reachable && status.persistence));
    setLoading(false);
  }, [cacheAvailable, origin, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function download(entry: LibraryEntry) {
    if (!entry.remote) return;
    if (!cacheAvailable) { notify('这台设备的浏览器存储不可用，无法离线保存课程。'); return; }
    if (!hasQuota(usedBytes)) {
      notify(`缓存空间不足：${describeQuota(usedBytes)}。请先删除一些已下载的课程。`);
      return;
    }
    setBusyId(entry.id);
    setProgress({ phase: 'course', done: 0, total: 1, bytes: 0, failed: 0 });
    try {
      const saved = await downloadCourse(entry.remote, origin, {
        token,
        quotaBytes: DEFAULT_QUOTA_BYTES,
        onProgress: setProgress,
      });
      notify(saved.failedMedia > 0
        ? `「${saved.name}」已保存到本机，但有 ${saved.failedMedia} 个资源未能下载。`
        : `「${saved.name}」已保存到本机，可以离线查看。`);
      await refresh();
    } catch (error) {
      if (error instanceof QuotaExceededError) notify(error.message);
      else if (error instanceof CourseApiError) notify(error.message);
      else notify('课程下载失败，请稍后重试。');
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  }

  async function remove(entry: LibraryEntry) {
    if (!cacheAvailable) return;
    setBusyId(entry.id);
    try {
      await deleteCachedCourse(entry.id);
      // 书签一并清掉，否则本地记录会随着「下载—删除」循环无限增长。
      const progress = readProgress();
      writeProgress(withoutCourse(progress, entry.id));
      notify(`已从本机删除「${entry.name}」`);
      await refresh();
    } catch {
      notify('删除失败，请稍后重试。');
    } finally {
      setBusyId(null);
    }
  }

  const configured = origin.trim().length > 0;
  const downloaded = entries.filter(entry => entry.cached).length;

  return <div className="nc-view">
    <div className="nc-head">
      <div>
        <div className="eyebrow">LEARNING / NATIVE COURSE LIBRARY</div>
        <h1>课程档案<span>原生渲染 · 可离线</span></h1>
        <p>已下载的课程保存在这台设备上，离开局域网或 Mac 关机后依然可以打开、切换场景并从上次的位置继续。</p>
      </div>
      <div className="nc-head-actions">
        <button className="secondary-button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} />{loading ? '正在读取' : '刷新'}
        </button>
        <button className="secondary-button" onClick={onOpenOnline} disabled={!configured}>
          <ArrowUpRight size={14} />在线课程库
        </button>
      </div>
    </div>

    <div className="nc-status">
      <span className={`nc-status-dot ${online === null ? '' : online ? 'online' : 'offline'}`} />
      <span>{online === null ? '正在探测 OpenMAIC…' : online ? '已连接 OpenMAIC' : '未连接 OpenMAIC'}</span>
      <span className="nc-status-spacer" />
      <span className="nc-status-note">{downloaded} 门已下载</span>
      <span className="nc-status-note">{cacheAvailable ? describeQuota(usedBytes, DEFAULT_QUOTA_BYTES) : '本机存储不可用'}</span>
    </div>

    {!configured && <div className="nc-empty">
      <b>还没有填写 OpenMAIC 地址</b>
      原生课程层需要知道课程库所在的服务地址。<br />
      <button className="text-link" onClick={onOpenSettings}>前往终端设置填写 <ArrowUpRight size={13} /></button>
    </div>}

    {configured && online === false && entries.length === 0 && <div className="nc-empty">
      <b>当前无法连接 OpenMAIC</b>
      这台设备上没有已下载的课程，也还没有本机记录。<br />请连接到课程库所在的网络后刷新，或先下载课程再离线使用。
    </div>}

    {noLibrary && <div className="nc-empty">
      <b>OpenMAIC 已连接，但没有课程库</b>
      服务端的持久化没有配置（缺少 DATABASE_URL），因此它无法列出任何课程。<br />
      已下载到本机的课程不受影响，仍然可以离线打开。
    </div>}

    {notice && <p className="nc-media-warning">{notice}</p>}

    {configured && entries.length > 0 && <div className="nc-list">
      {entries.map(entry => <div className="nc-row" key={entry.id}>
        <div className="nc-row-main">
          <div className="nc-row-title">
            <h3>{entry.name}</h3>
            <span className={`nc-badge ${entry.status}`}>{statusLabel[entry.status]}</span>
          </div>
          {entry.description && <p className="nc-row-desc">{entry.description}</p>}
          <div className="nc-row-meta">
            <span><BookOpen size={12} />{entry.sceneCount} 个场景</span>
            {entry.cached && <span><HardDrive size={12} />{formatBytes(entry.cached.mediaBytes)}</span>}
            {entry.cached && entry.cached.failedMedia > 0 && <span className="nc-media-warning">{entry.cached.failedMedia} 个资源缺失</span>}
            {entry.status === 'unavailable' && <span>需要连接后才能下载</span>}
          </div>
          {busyId === entry.id && progress && <div className="nc-progress">
            <div className="nc-progress-bar"><i style={{ width: `${progressWidth(progress)}%` }} /></div>
            <span className="nc-progress-text">{progressText(progress)}</span>
          </div>}
        </div>
        <div className="nc-row-actions">
          {entry.cached && <button className="nc-icon-button" aria-label={`打开 ${entry.name}`} onClick={() => onOpen(entry.id)}>
            <ArrowUpRight size={16} />
          </button>}
          {entry.remote && entry.status !== 'downloaded' && <button
            className="nc-icon-button"
            aria-label={`下载 ${entry.name}`}
            disabled={busyId !== null}
            onClick={() => void download(entry)}
          >
            {busyId === entry.id ? <Loader2 size={16} className="nc-spin" /> : entry.cached ? <CloudDownload size={16} /> : <Download size={16} />}
          </button>}
          {!entry.cached && entry.status === 'unavailable' && <button className="nc-icon-button" aria-label={`${entry.name} 需要连接`} disabled>
            <WifiOff size={16} />
          </button>}
          {entry.cached && <button
            className="nc-icon-button danger"
            aria-label={`删除 ${entry.name} 的本地副本`}
            disabled={busyId !== null}
            onClick={() => void remove(entry)}
          >
            <Trash2 size={15} />
          </button>}
        </div>
      </div>)}
    </div>}

    {configured && !loading && entries.length === 0 && online !== false && <div className="nc-empty">
      <b>课程库里还没有课程</b>
      在 OpenMAIC 里生成一门课程后，回到这里刷新即可看到它。<br />
      <button className="text-link" onClick={onOpenOnline}><Wifi size={13} />前往在线课程库 <ArrowUpRight size={13} /></button>
    </div>}

    <div className="nc-reader-footer">
      <span>DOWNLOADED COURSES STAY ON THIS DEVICE.</span>
      <span>本地缓存上限 {formatBytes(DEFAULT_QUOTA_BYTES)}</span>
    </div>
  </div>;
}

/** 进度条宽度：课程 JSON 阶段占前 8%，其余留给媒体。 */
export function progressWidth(progress: DownloadProgress): number {
  if (progress.phase === 'course') return progress.done >= progress.total ? 8 : 2;
  if (progress.phase === 'saving') return 100;
  if (progress.total === 0) return 8;
  return Math.min(99, 8 + Math.round((progress.done / progress.total) * 91));
}

export function progressText(progress: DownloadProgress): string {
  if (progress.phase === 'course') return '正在读取课程数据…';
  if (progress.phase === 'saving') {
    const suffix = progress.failed > 0 ? ` · ${progress.failed} 个资源缺失` : '';
    return `正在写入本机（${formatBytes(progress.bytes)}）${suffix}`;
  }
  const suffix = progress.failed > 0 ? ` · ${progress.failed} 个失败` : '';
  return `正在下载资源 ${progress.done} / ${progress.total}（${formatBytes(progress.bytes)}）${suffix}`;
}
