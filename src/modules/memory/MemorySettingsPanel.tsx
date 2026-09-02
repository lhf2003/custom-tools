import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Globe, Plus, X, Cpu, Package, HardDrive } from 'lucide-react';
import { confirmDialog } from '@/stores/confirmStore';
import { useToastStore } from '@/stores/toastStore';

/**
 * 知识索引插件的控制面（2026-09-02 起统一收进设置窗口「系统插件」tab 的行内展开区，
 * 插件视图内不再设设置入口）：
 * 浏览记忆与隐私（统计/黑名单/一键清除）+ 本地模型环境（WeMM sidecar 状态灯/一键安装）。
 * 记忆事实与习惯模式属于贾维斯人格，仍留在陪伴设置。
 */

/** 浏览记忆与隐私（M4）：浏览器扩展索引的页面/字幕——统计、黑名单、一键清除。
 *  Q9 二期裁决：全部数据永久保留，不再设滚动保留期。
 *  黑名单单真源在 SQLite，扩展侧只是缓存（≤30s 同步）。 */
function BrowsingPrivacySection() {
  const { addToast } = useToastStore();
  const [stats, setStats] = useState<Record<string, number>>({});
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState('');

  const load = useCallback(async () => {
    try {
      const [pairs, list] = await Promise.all([
        invoke<[string, number][]>('memory_source_stats'),
        invoke<string[]>('memory_get_blacklist'),
      ]);
      setStats(Object.fromEntries(pairs));
      setBlacklist(list);
    } catch (err) {
      console.error('Failed to load browsing privacy state:', err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddDomain = async () => {
    const domain = newDomain.trim().toLowerCase().replace(/^\*\./, '');
    if (!domain || !domain.includes('.')) {
      addToast({ type: 'error', title: '域名格式不对', message: '例如 bilibili.com' });
      return;
    }
    try {
      const list = await invoke<string[]>('memory_add_blacklist', { domain });
      setBlacklist(list);
      setNewDomain('');
      addToast({ type: 'success', title: '已拉黑', message: `${domain} 的存量索引已物理删除` });
    } catch (err) {
      addToast({
        type: 'error',
        title: '拉黑失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleRemoveDomain = async (domain: string) => {
    try {
      const list = await invoke<string[]>('memory_remove_blacklist', { domain });
      setBlacklist(list);
    } catch (err) {
      addToast({
        type: 'error',
        title: '移除失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleClearBrowsing = async () => {
    const ok = await confirmDialog({
      title: '清除浏览索引',
      message: '物理删除全部浏览页面与字幕索引，不可恢复。',
      detail: '剪贴板、笔记与记忆事实不受影响。',
      danger: true,
      confirmLabel: '全部删除',
    });
    if (!ok) return;
    try {
      const n = await invoke<number>('memory_clear_browsing');
      addToast({ type: 'success', title: '已清除', message: `物理删除 ${n} 条浏览索引` });
      await load();
    } catch (err) {
      addToast({
        type: 'error',
        title: '清除失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const browsingCount = (stats.browser ?? 0) + (stats.subtitle ?? 0);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Globe size={13} className="text-app-text-tertiary" />
        <span className="text-app-text-secondary text-xs font-medium">浏览记忆与隐私</span>
        <span className="text-app-text-disabled text-xs">
          页面 {stats.browser ?? 0} · 字幕段 {stats.subtitle ?? 0}
        </span>
      </div>

      <div className="mb-3">
        <div className="text-app-text-tertiary text-xs mb-1.5">
          索引黑名单（这些站点不再采集，浏览器扩展 ≤30 秒同步生效）
        </div>
        {blacklist.length > 0 && (
          <div className="space-y-0.5 mb-2">
            {blacklist.map((d) => (
              <div
                key={d}
                className="flex items-center gap-2 rounded-lg px-2 py-1 -mx-2 hover:bg-white/5 transition-colors"
              >
                <span className="text-app-text-primary text-xs flex-1 min-w-0 truncate">{d}</span>
                <button
                  onClick={() => handleRemoveDomain(d)}
                  className="text-app-text-tertiary hover:text-app-status-error transition-colors cursor-pointer shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddDomain()}
            placeholder="添加域名，例如 example.com"
            className="flex-1 bg-white/5 text-app-text-primary text-xs rounded-lg px-2.5 py-1.5 outline-none border border-white/10 focus:border-white/20 placeholder:text-app-text-placeholder"
          />
          <button
            onClick={handleAddDomain}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 text-app-text-primary text-xs hover:bg-white/15 transition-colors cursor-pointer shrink-0"
          >
            <Plus size={12} /> 拉黑
          </button>
        </div>
      </div>

      <button
        onClick={handleClearBrowsing}
        disabled={browsingCount === 0}
        className="w-full px-3 py-2 rounded-lg border border-app-status-error/30 bg-app-status-error/10 text-app-status-error text-xs hover:bg-app-status-error/20 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
      >
        清除全部浏览索引（{browsingCount} 条）
      </button>
    </div>
  );
}

interface EnvStatus {
  gpu: boolean;
  deps: boolean;
  model: boolean;
  installing: boolean;
  model_bytes: number;
  model_expected_bytes: number;
}

interface EnvProgress {
  stage: 'deps' | 'model' | 'done' | 'error';
  percent: number | null;
  message: string;
}

/** 本地模型环境（N1-5）：记忆检索的 WeMM sidecar 三要素状态灯 + 一键安装。
 *  GPU → Python 依赖（uv sync ~2.5GB）→ 模型（hf-mirror ~5.1GB），安装进度走 memory-env-progress 事件。 */
function LocalModelEnvSection() {
  const { addToast } = useToastStore();
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [progress, setProgress] = useState<EnvProgress | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await invoke<EnvStatus>('memory_env_status'));
    } catch (err) {
      console.error('Failed to load memory env status:', err);
    }
  }, []);

  useEffect(() => {
    load();
    const unlisten = listen<EnvProgress>('memory-env-progress', (e) => {
      setProgress(e.payload);
      if (e.payload.stage === 'done') {
        addToast({ type: 'success', title: '本地模型环境就绪', message: '记忆检索已可用' });
        load();
      } else if (e.payload.stage === 'error') {
        addToast({ type: 'error', title: '环境安装失败', message: e.payload.message });
        load();
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [load, addToast]);

  const handleInstall = async () => {
    try {
      await invoke('memory_env_install');
    } catch (err) {
      addToast({
        type: 'error',
        title: '无法启动安装',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!status) return null;
  const ready = status.gpu && status.deps && status.model;
  const installing = status.installing || (progress && progress.stage !== 'done' && progress.stage !== 'error');

  const lamp = (ok: boolean, icon: React.ReactNode, label: string, detail: string) => (
    <div className="flex items-center gap-2">
      <span className={ok ? 'text-app-status-success' : 'text-app-text-disabled'}>{icon}</span>
      <span className={`text-xs flex-1 ${ok ? 'text-app-text-primary' : 'text-app-text-tertiary'}`}>{label}</span>
      <span className={`text-xs ${ok ? 'text-app-status-success' : 'text-app-text-disabled'}`}>{detail}</span>
    </div>
  );

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Cpu size={13} className="text-app-text-tertiary" />
        <span className="text-app-text-secondary text-xs font-medium">本地模型环境</span>
        <span className={`text-xs ${ready ? 'text-app-status-success' : 'text-app-text-disabled'}`}>
          {ready ? '就绪 · WeMM 多模态检索可用' : '未就绪'}
        </span>
      </div>

      <div className="space-y-1.5 mb-3">
        {lamp(status.gpu, <Cpu size={12} />, 'NVIDIA GPU', status.gpu ? '已检测到' : '需要 ≥6GB 显存')}
        {lamp(status.deps, <Package size={12} />, 'Python 依赖', status.deps ? '已安装' : '约 2.5GB')}
        {lamp(
          status.model,
          <HardDrive size={12} />,
          'WeMM 模型',
          status.model
            ? '已就绪'
            : `${(status.model_bytes / 1e9).toFixed(1)} / ${(status.model_expected_bytes / 1e9).toFixed(1)} GB`
        )}
      </div>

      {!ready && (
        <>
          {installing && progress ? (
            <div>
              <div className="text-app-text-secondary text-xs mb-1.5">{progress.message}</div>
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                {progress.percent != null ? (
                  <div
                    className="h-full bg-app-brand-primary transition-all duration-500"
                    style={{ width: `${progress.percent}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 bg-app-brand-primary animate-pulse rounded-full" />
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={handleInstall}
              disabled={!status.gpu}
              className="w-full px-3 py-2 rounded-lg bg-app-brand-primary/20 text-app-brand-primary-light text-xs border border-app-brand-primary/30 hover:bg-app-brand-primary/30 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {status.gpu
                ? '一键安装（依赖 + 模型共约 7.6GB，可断点续传）'
                : '未检测到 NVIDIA GPU，无法启用本地检索'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** 系统插件 tab 行内展开面板：浏览记忆与隐私 + 本地模型环境 */
export function MemorySettingsPanel() {
  return (
    <div className="p-3 space-y-3">
      <BrowsingPrivacySection />
      <LocalModelEnvSection />
    </div>
  );
}
