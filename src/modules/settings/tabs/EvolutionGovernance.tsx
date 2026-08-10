import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  History,
  ScrollText,
  Sparkles,
} from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';

interface ManualInfo {
  name: string;
  description: string;
  trigger_description: string;
  schedule: string | null;
  enabled: boolean;
}

interface BackupEntry {
  file: string;
  stamp: string;
}

/** 经验本硬上限（与后端 tools.rs 的 16KB 写保护一致） */
const EVOLUTION_MAX_BYTES = 16 * 1024;

function formatStamp(stamp: string): string {
  // yyyymmdd_HHMMSS（可能带 _N 同秒后缀）→ MM-DD HH:mm:ss
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return stamp;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

interface EvolutionGovernanceProps {
  onBack: () => void;
}

/** 进化治理：手册在线编辑（保存即快照）、经验本容量与一键整理、版本备份回滚 */
export function EvolutionGovernance({ onBack }: EvolutionGovernanceProps) {
  const { addToast } = useToastStore();
  const [manuals, setManuals] = useState<ManualInfo[]>([]);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [evolutionSize, setEvolutionSize] = useState(0);
  const [openManual, setOpenManual] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compacting, setCompacting] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [manualList, backupList, size] = await Promise.all([
        invoke<ManualInfo[]>('list_manuals'),
        invoke<BackupEntry[]>('list_evolution_backups'),
        invoke<number>('get_evolution_size'),
      ]);
      setManuals(manualList);
      setBackups(backupList);
      setEvolutionSize(size);
    } catch (err) {
      console.error('Failed to load governance data:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleToggleManual = async (name: string) => {
    if (openManual === name) {
      setOpenManual(null);
      setDraftDirty(false);
      return;
    }
    try {
      const content = await invoke<string>('get_manual', { name });
      setOpenManual(name);
      setDraft(content);
      setDraftDirty(false);
    } catch (err) {
      addToast({
        type: 'error',
        title: '读取手册失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSaveManual = async () => {
    if (!openManual) return;
    setSaving(true);
    try {
      await invoke('save_manual', { name: openManual, content: draft });
      addToast({ type: 'success', title: '手册已保存', message: '旧版已自动备份，下一轮生效' });
      setDraftDirty(false);
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '保存失败',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCompact = async () => {
    setCompacting(true);
    try {
      const result = await invoke<string>('compact_evolution');
      addToast({ type: 'success', title: '整理完成', message: result, duration: 6000 });
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '整理失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 6000,
      });
    } finally {
      setCompacting(false);
    }
  };

  const handleRollback = async (entry: BackupEntry) => {
    if (!confirm(`把 ${entry.file} 回滚到 ${formatStamp(entry.stamp)} 的版本？\n当前版本会先自动备份。`)) {
      return;
    }
    try {
      await invoke('rollback_evolution_backup', { file: entry.file, stamp: entry.stamp });
      addToast({ type: 'success', title: '已回滚', message: entry.file });
      setOpenManual(null);
      await loadData();
    } catch (err) {
      addToast({
        type: 'error',
        title: '回滚失败',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** 备份按文件分组（文件名即标题，组内时间倒序——后端已排好） */
  const backupGroups = useMemo(() => {
    const groups = new Map<string, BackupEntry[]>();
    for (const b of backups) {
      const list = groups.get(b.file) ?? [];
      list.push(b);
      groups.set(b.file, list);
    }
    return [...groups.entries()];
  }, [backups]);

  const sizeRatio = Math.min(1, evolutionSize / EVOLUTION_MAX_BYTES);
  const sizeColor =
    sizeRatio > 0.875 ? 'bg-amber-400' : sizeRatio > 0.7 ? 'bg-yellow-500' : 'bg-app-brand-primary/70';

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h2 className="text-white text-lg font-semibold">进化治理</h2>
          <p className="text-white/40 text-xs">手册与经验本的版本管理——改坏能回滚，满了能整理</p>
        </div>
      </div>

      <div className="space-y-5">
        {/* 手册列表 + 内嵌编辑器 */}
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen size={13} className="text-white/40" />
            <span className="text-white/50 text-xs font-medium">能力手册</span>
          </div>
          <div className="space-y-1">
            {manuals.map((m) => (
              <div key={m.name} className="rounded-lg">
                <button
                  onClick={() => handleToggleManual(m.name)}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors cursor-pointer text-left"
                >
                  {openManual === m.name ? (
                    <ChevronDown size={13} className="text-white/30 shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="text-white/30 shrink-0" />
                  )}
                  <span className="text-white/80 text-xs font-medium w-28 shrink-0">{m.name}</span>
                  <span className="text-white/40 text-xs truncate flex-1">{m.description}</span>
                  {m.schedule && (
                    <span className="text-app-brand-primary-light/70 text-xs shrink-0">
                      {m.schedule}
                    </span>
                  )}
                  {!m.enabled && (
                    <span className="text-white/30 text-xs shrink-0">已停用</span>
                  )}
                </button>
                {openManual === m.name && (
                  <div className="px-2 pb-2">
                    {m.trigger_description && (
                      <p className="text-white/30 text-xs mb-1.5 px-1">
                        聊天可激活：{m.trigger_description}
                      </p>
                    )}
                    <textarea
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setDraftDirty(true);
                      }}
                      spellCheck={false}
                      className="w-full h-64 bg-black/30 border border-white/10 rounded-lg p-3 text-white/80 text-xs font-mono leading-relaxed outline-none focus:border-app-brand-primary/40 resize-y"
                    />
                    <div className="flex items-center justify-end gap-2 mt-2">
                      <span className="text-white/25 text-xs mr-auto">
                        保存前会自动备份当前版本
                      </span>
                      <button
                        onClick={handleSaveManual}
                        disabled={!draftDirty || saving}
                        className="px-3 py-1.5 rounded-lg bg-app-brand-primary/20 text-app-brand-primary-light text-xs border border-app-brand-primary/30 hover:bg-app-brand-primary/30 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* 经验本容量 + 一键整理 */}
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <ScrollText size={13} className="text-white/40" />
              <span className="text-white/50 text-xs font-medium">经验本容量</span>
            </div>
            <button
              onClick={handleCompact}
              disabled={compacting}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/20 text-blue-300 text-xs border border-blue-500/30 hover:bg-blue-500/30 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Sparkles size={12} className={compacting ? 'animate-pulse' : ''} />
              {compacting ? '整理中…' : '一键整理'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${sizeColor}`}
                style={{ width: `${Math.max(1, sizeRatio * 100)}%` }}
              />
            </div>
            <span className="text-white/40 text-xs tabular-nums">
              {formatSize(evolutionSize)} / 16KB
            </span>
          </div>
          <p className="text-white/25 text-xs mt-2">
            超过 14KB 会收到整理提醒；整理前自动备份，写坏了可在下方回滚
          </p>
        </section>

        {/* 备份列表 */}
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="flex items-center gap-2 mb-3">
            <History size={13} className="text-white/40" />
            <span className="text-white/50 text-xs font-medium">版本备份</span>
            <span className="text-white/25 text-xs">每文件保留最近 20 份</span>
          </div>
          {backupGroups.length === 0 ? (
            <p className="text-white/30 text-xs">还没有备份——首次保存/整理/接受提案时自动创建</p>
          ) : (
            <div className="space-y-3">
              {backupGroups.map(([file, entries]) => (
                <div key={file}>
                  <div className="text-white/60 text-xs font-medium mb-1">{file}</div>
                  <div className="space-y-0.5">
                    {entries.map((b) => (
                      <div
                        key={`${b.file}@${b.stamp}`}
                        className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/5 transition-colors"
                      >
                        <span className="text-white/40 text-xs tabular-nums flex-1">
                          {formatStamp(b.stamp)}
                        </span>
                        <button
                          onClick={() => handleRollback(b)}
                          className="text-white/30 hover:text-amber-300 text-xs transition-colors cursor-pointer"
                        >
                          回滚到此版
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
