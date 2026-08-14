import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Clock, FolderOpen, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { confirmDialog } from '@/stores/confirmStore';
import { SettingGroup, Toggle } from '../components/SettingsPrimitives';

interface ManualInfo {
  name: string;
  description: string;
  trigger_description: string;
  schedule: string | null;
  enabled: boolean;
  tools: string[];
  builtin: boolean;
}

/** schedule 文本（daily 21:00 / weekly fri 17:30）→ 人话 */
function formatSchedule(schedule: string): string {
  const parts = schedule.split(/\s+/);
  if (parts[0] === 'daily') {
    return `每天 ${parts.slice(1).join('、')}`;
  }
  const DOW: Record<string, string> = {
    mon: '一', tue: '二', wed: '三', thu: '四', fri: '五', sat: '六', sun: '日',
  };
  if (parts[0] === 'weekly' && parts.length === 3) {
    return `每周${DOW[parts[1]] ?? parts[1]} ${parts[2]}`;
  }
  return schedule;
}

/** 导入预览用的轻量 frontmatter 解析（权威校验在后端 import_skill） */
interface ParsedSkill {
  name: string;
  description: string;
  trigger: string;
}

function parseSkillFrontmatter(content: string): ParsedSkill {
  const empty: ParsedSkill = { name: '', description: '', trigger: '' };
  if (!content.startsWith('---')) return empty;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return empty;
  const header = content.slice(3, end);
  const get = (key: string): string => {
    const line = header.split('\n').find((l) => l.trimStart().startsWith(`${key}:`));
    return line ? line.slice(line.indexOf(':') + 1).trim() : '';
  };
  return { name: get('name'), description: get('description'), trigger: get('trigger_description') };
}

/** 把确认步填好的 trigger_description 注入原文 frontmatter（有则替换，无则插闭合行前） */
function injectTrigger(raw: string, trigger: string): string {
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end < 0) return raw;
  const lines = raw.slice(0, end + 4).split('\n');
  const idx = lines.findIndex((l) => l.trimStart().startsWith('trigger_description:'));
  if (idx >= 0) {
    lines[idx] = `trigger_description: ${trigger}`;
  } else {
    lines.splice(lines.length - 1, 0, `trigger_description: ${trigger}`);
  }
  return lines.join('\n') + raw.slice(end + 4);
}

/** 单本手册卡片：内置只读展示；导入的附开关与删除 */
function SkillCard({
  manual,
  onToggle,
  onDelete,
}: {
  manual: ManualInfo;
  onToggle?: (enabled: boolean) => void;
  onDelete?: () => void;
}) {
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-app-text-primary text-sm font-medium">{manual.name}</span>
        {manual.builtin && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-app-text-secondary">内置</span>
        )}
        {manual.schedule && (
          <span className="flex items-center gap-1 text-app-text-disabled text-xs">
            <Clock size={11} />
            {formatSchedule(manual.schedule)}
          </span>
        )}
        {!manual.builtin && (
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onDelete}
              title="删除"
              className="p-1.5 rounded-md text-app-text-tertiary hover:text-app-status-error hover:bg-app-status-error/10 transition-colors cursor-pointer"
            >
              <Trash2 size={13} />
            </button>
            <Toggle enabled={manual.enabled} onToggle={(v) => onToggle?.(v)} />
          </span>
        )}
      </div>
      {manual.description && (
        <p className="text-app-text-tertiary text-xs mt-1 leading-relaxed">{manual.description}</p>
      )}
      {manual.trigger_description ? (
        <p className="text-app-text-secondary text-xs mt-1.5 leading-relaxed">
          <Sparkles size={11} className="inline mr-1 -mt-0.5 text-app-text-tertiary" />
          {manual.trigger_description}
        </p>
      ) : (
        <p className="text-app-text-disabled text-xs mt-1.5">不进入聊天能力目录（管道产物手册）</p>
      )}
      {manual.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {manual.tools.map((t) => (
            <code
              key={t}
              className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-app-text-tertiary"
            >
              {t}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

/** SKILL 页：贾维斯能力目录（内置手册 + 导入手册）与外部 SKILL 导入通路 */
export function SkillSettings() {
  const { addToast } = useToastStore();
  const [manuals, setManuals] = useState<ManualInfo[]>([]);

  // 导入面板状态
  const [importing, setImporting] = useState(false);
  const [raw, setRaw] = useState('');
  const [trigger, setTrigger] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickingFileRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setManuals(await invoke<ManualInfo[]>('list_manuals'));
    } catch (err) {
      console.error('[skill-settings] 加载失败:', err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const builtin = useMemo(() => manuals.filter((m) => m.builtin), [manuals]);
  const imported = useMemo(() => manuals.filter((m) => !m.builtin), [manuals]);
  const parsed = useMemo(() => parseSkillFrontmatter(raw), [raw]);
  // trigger 输入框为空时回退原文里的值（原文已有 trigger 时不强制重填）
  const effectiveTrigger = trigger.trim() || parsed.trigger;

  const resetImport = () => {
    setImporting(false);
    setRaw('');
    setTrigger('');
  };

  /** 选择 .md 文件：先挂失焦挂起（选择器抢焦点会触发 hide-on-blur），focus 回来释放 */
  const openFilePicker = async () => {
    pickingFileRef.current = true;
    await invoke('set_blur_hold', { hold: true }).catch(() => {});
    setTimeout(() => {
      if (pickingFileRef.current) {
        pickingFileRef.current = false;
        invoke('set_blur_hold', { hold: false }).catch(() => {});
      }
    }, 5 * 60 * 1000);
    fileInputRef.current?.click();
  };

  useEffect(() => {
    const onFocus = () => {
      if (!pickingFileRef.current) return;
      pickingFileRef.current = false;
      invoke('set_blur_hold', { hold: false }).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setRaw(await file.text());
  };

  const handleDraft = async () => {
    setDrafting(true);
    try {
      const draft = await invoke<string>('draft_skill_trigger', {
        name: parsed.name,
        description: parsed.description,
        body: raw,
      });
      setTrigger(draft);
    } catch (err) {
      addToast({
        type: 'error',
        title: '起草失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    } finally {
      setDrafting(false);
    }
  };

  const handleImport = async () => {
    setSubmitting(true);
    try {
      const created = await invoke<ManualInfo>('import_skill', {
        content: injectTrigger(raw, effectiveTrigger),
      });
      addToast({
        type: 'success',
        title: `已导入「${created.name}」`,
        message: '下一轮聊天即可被触发',
        duration: 4000,
      });
      resetImport();
      await load();
    } catch (err) {
      addToast({
        type: 'error',
        title: '导入失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 5000,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (manual: ManualInfo, enabled: boolean) => {
    setManuals((prev) => prev.map((m) => (m.name === manual.name ? { ...m, enabled } : m)));
    try {
      await invoke('set_skill_enabled', { name: manual.name, enabled });
    } catch (err) {
      setManuals((prev) => prev.map((m) => (m.name === manual.name ? { ...m, enabled: !enabled } : m)));
      addToast({
        type: 'error',
        title: '操作失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  const handleDelete = async (manual: ManualInfo) => {
    const ok = await confirmDialog({
      title: '删除手册',
      message: `确定删除「${manual.name}」吗？`,
      detail: '删除后聊天不再触发该能力；原文件已自动快照，可在「陪伴 → 进化治理」的备份里找回。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('delete_skill', { name: manual.name });
      setManuals((prev) => prev.filter((m) => m.name !== manual.name));
      addToast({ type: 'success', title: `已删除「${manual.name}」`, duration: 3000 });
    } catch (err) {
      addToast({
        type: 'error',
        title: '删除失败',
        message: err instanceof Error ? err.message : String(err),
        duration: 4000,
      });
    }
  };

  return (
    <>
      {/* 内置能力（不可删不可开关；内容编辑走 陪伴 → 进化治理） */}
      <SettingGroup title="内置能力">
        <div className="px-3 py-2.5 text-app-text-disabled text-xs leading-relaxed">
          贾维斯的系统能力，随应用发布，不可删除、不可关闭；内容微调请前往「陪伴 → 进化治理」。
        </div>
        {builtin.map((m) => (
          <SkillCard key={m.name} manual={m} />
        ))}
      </SettingGroup>

      {/* 导入的能力 */}
      <SettingGroup
        title="导入的能力"
        actions={
          !importing ? (
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer"
            >
              导入 SKILL
            </button>
          ) : undefined
        }
      >
        {imported.length === 0 && !importing && (
          <div className="px-3 py-3 text-app-text-disabled text-xs leading-relaxed">
            还没有导入的能力。从 SKILL 市场找到好用的手册（SKILL.md），粘贴全文或选择文件即可导入。
          </div>
        )}
        {imported.map((m) => (
          <SkillCard
            key={m.name}
            manual={m}
            onToggle={(v) => void handleToggle(m, v)}
            onDelete={() => void handleDelete(m)}
          />
        ))}

        {/* 导入面板（内联展开） */}
        {importing && (
          <div className="px-3 py-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-app-text-secondary text-xs font-medium">SKILL.md 全文</span>
              <button
                type="button"
                onClick={() => void openFilePicker()}
                className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <FolderOpen size={12} />
                选择 .md 文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,text/markdown"
                className="hidden"
                onChange={(e) => void handleFileChange(e)}
              />
            </div>
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={'粘贴 SKILL.md 全文（含 --- frontmatter 头）…'}
              rows={8}
              className="w-full bg-app-bg-tertiary border border-white/10 rounded-lg px-3 py-2 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors font-mono leading-relaxed resize-y"
            />

            {/* 解析预览 + 触发描述确认 */}
            {raw.trim() && (
              <div className="mt-2.5 rounded-lg bg-white/5 px-3 py-2.5">
                {parsed.name ? (
                  <>
                    <div className="flex items-center gap-2 text-xs">
                      <BookOpen size={12} className="text-app-text-tertiary" />
                      <span className="text-app-text-primary font-medium">{parsed.name}</span>
                      {parsed.description && (
                        <span className="text-app-text-tertiary truncate">{parsed.description}</span>
                      )}
                    </div>
                    <div className="mt-2.5">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-app-text-secondary text-xs">
                          触发场景描述<span className="text-app-status-error"> *</span>
                        </span>
                        <button
                          type="button"
                          disabled={drafting}
                          onClick={() => void handleDraft()}
                          className="px-2 py-0.5 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1"
                        >
                          <Wand2 size={11} />
                          {drafting ? '起草中…' : '让 AI 起草'}
                        </button>
                      </div>
                      <input
                        type="text"
                        value={trigger || parsed.trigger}
                        onChange={(e) => setTrigger(e.target.value)}
                        placeholder="用户什么样的意图时应激活这本手册？（没有它手册不会进入能力目录）"
                        className="w-full bg-app-bg-tertiary border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-app-text-primary placeholder:text-app-text-placeholder outline-none focus:border-white/25 transition-colors"
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-app-status-warning-text text-xs leading-relaxed">
                    没解析到 frontmatter 里的 name——手册必须以 --- 开头并声明 name 字段。
                  </p>
                )}
              </div>
            )}

            <p className="text-app-text-disabled text-xs mt-2.5 leading-relaxed">
              导入的手册会进入贾维斯的能力目录，内容将在触发时注入聊天上下文——请只导入可信来源的
              SKILL。导入手册固定立即生效、不参与定时调度。
            </p>
            <div className="flex justify-end gap-2 mt-2.5">
              <button
                type="button"
                onClick={resetImport}
                className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={submitting || !parsed.name || !effectiveTrigger}
                onClick={() => void handleImport()}
                className="px-3 py-1.5 rounded-lg text-xs bg-app-status-info/15 text-app-status-info hover:bg-app-status-info/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? '导入中…' : '确认导入'}
              </button>
            </div>
          </div>
        )}
      </SettingGroup>
    </>
  );
}
