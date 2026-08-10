/**
 * 剪贴板媒体播放器（自定义玻璃风控件，不用原生 controls）
 *
 * - audio / video 双模式，媒体源 = convertFileSrc(本地路径)（依赖 tauri.conf.json
 *   security.assetProtocol，scope "**" 覆盖任意盘符的剪贴板文件）
 * - 控件：播放/暂停、可拖拽进度条（asset 协议支持 HTTP Range）、时间、静音、音量、全屏（仅视频）
 * - 解码失败（坏文件/编解码缺失）→ 失败态提示，保留「打开所在文件夹」
 */
import { useCallback, useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Loader2,
  FolderOpen,
  AlertTriangle,
} from 'lucide-react';

interface MediaPlayerProps {
  path: string;
  mode: 'audio' | 'video';
}

function formatMediaTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

/** 进度/音量共用滑条：内部持轨（pointer capture 拖拽），拖拽中 onPreview、松手 onCommit */
function DragBar({
  ratio,
  onPreview,
  onCommit,
  thumb = false,
  fillClass = 'bg-app-brand-primary',
  className = 'flex-1',
}: {
  ratio: number;
  onPreview: (r: number) => void;
  onCommit: (r: number) => void;
  thumb?: boolean;
  fillClass?: string;
  className?: string;
}) {
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const ratioFromEvent = (clientX: number) => {
    const rect = trackEl?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    trackEl?.setPointerCapture(e.pointerId);
    const r = ratioFromEvent(e.clientX);
    setDragRatio(r);
    onPreview(r);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRatio === null) return;
    const r = ratioFromEvent(e.clientX);
    setDragRatio(r);
    onPreview(r);
  };

  const handlePointerUp = () => {
    if (dragRatio === null) return;
    onCommit(dragRatio);
    setDragRatio(null);
  };

  const displayed = dragRatio ?? ratio;

  return (
    <div
      ref={setTrackEl}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={`h-4 flex items-center cursor-pointer group min-w-0 ${className}`}
    >
      <div className="relative w-full h-1.5 rounded-full bg-white/10">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${fillClass}`}
          style={{ width: `${displayed * 100}%` }}
        />
        {thumb && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md transition-transform group-hover:scale-110"
            style={{ left: `calc(${displayed * 100}% - 6px)` }}
          />
        )}
      </div>
    </div>
  );
}

export function MediaPlayer({ path, mode }: MediaPlayerProps) {
  const [mediaEl, setMediaEl] = useState<HTMLMediaElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  // asset 协议按需放行（scope 只静态允许插件目录，媒体文件在任意路径）：
  // 先调 allow_asset_file 授权该文件，再转 asset URL；授权失败仍转（静态
  // scope 命中时可用），真正被拒由媒体 onError 的 failed 态兜底。
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    invoke('allow_asset_file', { path })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSrc(convertFileSrc(path));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [volumePreview, setVolumePreview] = useState<number | null>(null);

  const fileName = path.split(/[\\/]/).pop() || path;

  // 媒体源变化时重置（外层切换条目用 key={id} 强制重挂载，此处兜底）
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setReady(false);
    setFailed(false);
    setSeekPreview(null);
  }, [src]);

  // 全屏状态同步（退出全屏后图标复原）
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerEl);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [containerEl]);

  const commitSeek = useCallback(
    (ratio: number) => {
      if (!mediaEl || duration <= 0) return;
      const target = ratio * duration;
      // 立即同步显示目标时间：媒体 seek 异步（等 timeupdate 回写），若只清预览
      // 等待回写，中间帧显示旧进度 → thumb 弹回原位置再跳目标（抽帧）
      setCurrent(target);
      mediaEl.currentTime = target;
      setSeekPreview(null);
    },
    [mediaEl, duration]
  );

  const commitVolume = useCallback(
    (ratio: number) => {
      if (!mediaEl) return;
      mediaEl.muted = false;
      mediaEl.volume = ratio;
      setVolume(ratio);
      setMuted(false);
      setVolumePreview(null);
    },
    [mediaEl]
  );

  const togglePlay = () => {
    if (!mediaEl || failed) return;
    if (mediaEl.paused) {
      void mediaEl.play().catch(() => setFailed(true));
    } else {
      mediaEl.pause();
    }
  };

  const toggleMute = () => {
    if (!mediaEl) return;
    mediaEl.muted = !mediaEl.muted;
    setMuted(mediaEl.muted);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerEl?.requestFullscreen().catch(() => {});
    }
  };

  const openFolder = () => {
    void revealItemInDir(path).catch(() => {});
  };

  const shownProgress = seekPreview ?? (duration > 0 ? current / duration : 0);
  const shownVolume = volumePreview ?? (muted ? 0 : volume);

  const mediaProps = {
    ref: setMediaEl,
    src: src ?? undefined,
    preload: 'metadata',
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      setDuration(e.currentTarget.duration);
      setReady(true);
    },
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => setCurrent(e.currentTarget.currentTime),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onError: () => setFailed(true),
  };

  const volumeControls = (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        onClick={toggleMute}
        className="w-6 h-6 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer"
        title={muted ? '取消静音' : '静音'}
      >
        {muted || shownVolume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
      <div className="w-12">
        <DragBar
          ratio={shownVolume}
          onPreview={setVolumePreview}
          onCommit={commitVolume}
          fillClass="bg-white/30"
        />
      </div>
    </div>
  );

  const openFolderButton = (
    <button
      onClick={openFolder}
      className="self-start flex items-center gap-1.5 text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 rounded-md px-2 py-1.5 transition-colors cursor-pointer"
    >
      <FolderOpen size={13} />
      打开所在文件夹
    </button>
  );

  if (mode === 'audio') {
    return (
      <div className="flex flex-col gap-4 bg-app-bg-tertiary rounded-xl px-4 py-5">
        {/* 媒体元素（无 controls 不可见，驱动播放/进度/事件；display:none 会阻止加载，不用 hidden） */}
        <audio {...mediaProps} />
        <div className="flex items-center gap-4">
          <button
            onClick={togglePlay}
            className="w-11 h-11 rounded-full bg-app-brand-primary/20 hover:bg-app-brand-primary/30 text-app-brand-primary-light flex items-center justify-center transition-colors cursor-pointer shrink-0"
            title={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-app-text-primary truncate">{fileName}</div>
            <div className="text-xs text-app-text-disabled mt-0.5 flex items-center gap-1.5">
              {!ready && !failed && <Loader2 size={11} className="animate-spin" />}
              {failed ? '无法播放' : ready ? formatMediaTime(current) : '加载中…'}
            </div>
          </div>
          {volumeControls}
        </div>
        <div className="flex items-center gap-3">
          <DragBar
            ratio={shownProgress}
            onPreview={setSeekPreview}
            onCommit={commitSeek}
            thumb
          />
          <span className="text-xs text-app-text-disabled shrink-0 tabular-nums w-24 text-right">
            {formatMediaTime(shownProgress * duration)} / {formatMediaTime(duration)}
          </span>
        </div>
        {failed && <p className="text-xs text-app-text-disabled">文件可能已损坏或编码不受支持</p>}
        {openFolderButton}
      </div>
    );
  }

  return (
    <div
      ref={setContainerEl}
      className={`rounded-xl overflow-hidden flex flex-col ${fullscreen ? 'bg-black' : 'bg-app-bg-tertiary'}`}
    >
      {/* 全屏态：画面容器 flex-1 撑满（视频自身 h-full object-contain 自适应），控制条贴底 */}
      <div className={`relative bg-black/40 ${fullscreen ? 'flex-1 min-h-0' : ''}`}>
        <video
          {...mediaProps}
          className={`w-full object-contain ${fullscreen ? 'h-full' : 'max-h-[280px]'}`}
        />
        {!ready && !failed && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-app-text-disabled text-sm">
            <Loader2 size={16} className="animate-spin" />
            加载中…
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <AlertTriangle size={20} className="text-app-text-disabled" />
            <p className="text-sm text-app-text-secondary">无法播放该文件</p>
            <p className="text-xs text-app-text-disabled break-all max-w-full">{path}</p>
          </div>
        )}
      </div>
      <div className="px-3 py-2 flex items-center gap-2">
        <button
          onClick={togglePlay}
          className="w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 text-app-text-secondary hover:text-app-text-primary flex items-center justify-center transition-colors cursor-pointer shrink-0"
          title={playing ? '暂停' : '播放'}
        >
          {playing ? <Pause size={14} /> : <Play size={14} className="ml-px" />}
        </button>
        <DragBar
          ratio={shownProgress}
          onPreview={setSeekPreview}
          onCommit={commitSeek}
          thumb
        />
        <span className="text-xs text-app-text-disabled shrink-0 tabular-nums">
          {formatMediaTime(shownProgress * duration)} / {formatMediaTime(duration)}
        </span>
        {volumeControls}
        <button
          onClick={toggleFullscreen}
          className="w-6 h-6 rounded-md text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer shrink-0"
          title={fullscreen ? '退出全屏' : '全屏'}
        >
          {fullscreen ? <Minimize size={13} /> : <Maximize size={13} />}
        </button>
      </div>
      {!failed && !fullscreen && openFolderButton}
    </div>
  );
}
