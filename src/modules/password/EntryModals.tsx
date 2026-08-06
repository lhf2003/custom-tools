import { useEffect, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { CustomSelect } from '@/modules/settings/components/CustomSelect';
import { THEME } from '../../constants/theme';
import type { EntryFormData, PasswordCategory } from './types';

interface ModalProps {
  children: React.ReactNode;
  onClose: () => void;
  ariaLabel: string;
}

/**
 * Base modal: dialog semantics, Esc-to-close, minimal focus trap, focus
 * restore on unmount. `onClose` decides whether closing is allowed (dirty
 * guards live in the caller).
 */
function Modal({ children, onClose, ariaLabel }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((n) => !n.hasAttribute('disabled'));

    // Respect an element that already took focus via autoFocus
    if (!el.contains(document.activeElement)) {
      focusables()[0]?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      style={{ zIndex: THEME.Z_INDEX.MODAL }}
      onClick={() => onCloseRef.current()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="rounded-2xl p-6 w-96 relative border border-app-border max-h-[calc(100%-48px)] overflow-y-auto"
        style={{ backgroundColor: THEME.BG_SECONDARY, boxShadow: THEME.SHADOW.XL }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

const inputClass =
  'w-full bg-app-bg-tertiary border border-app-border rounded-lg px-4 py-2 text-app-text-primary placeholder:text-app-text-placeholder outline-none transition-colors duration-200 focus:border-app-border-emphasis';

interface EntryFormModalProps {
  mode: 'create' | 'edit';
  initial: EntryFormData;
  categories: PasswordCategory[];
  saving: boolean;
  error: string | null;
  onSubmit: (form: EntryFormData) => void;
  onClose: () => void;
}

export function EntryFormModal({
  mode,
  initial,
  categories,
  saving,
  error,
  onSubmit,
  onClose,
}: EntryFormModalProps) {
  const [form, setForm] = useState<EntryFormData>(initial);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isDirty = JSON.stringify(form) !== JSON.stringify(initial);

  const requestClose = () => {
    if (isDirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const update = (patch: Partial<EntryFormData>) => {
    setConfirmDiscard(false);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const canSubmit = form.title.trim() !== '' && form.password !== '' && !saving;

  return (
    <Modal onClose={requestClose} ariaLabel={mode === 'edit' ? '编辑密码' : '新增密码'}>
      <h2 className="text-app-text-primary font-medium mb-4">
        {mode === 'edit' ? '编辑密码' : '新增密码'}
      </h2>
      <button
        onClick={requestClose}
        aria-label="关闭"
        className="absolute top-4 right-4 p-1 rounded-lg text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
      >
        <X size={18} />
      </button>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-app-status-error/10 border border-app-status-error/20 text-sm text-app-status-error-text">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <input
          type="text"
          id="entry-title"
          name="title"
          aria-label="标题（必填）"
          value={form.title}
          onChange={(e) => update({ title: e.target.value })}
          placeholder="标题 *"
          autoFocus
          className={inputClass}
        />
        <input
          type="text"
          id="entry-username"
          name="username"
          aria-label="用户名"
          value={form.username}
          onChange={(e) => update({ username: e.target.value })}
          placeholder="用户名"
          className={inputClass}
        />
        <input
          type="password"
          id="entry-password"
          name="entry-password"
          aria-label="密码（必填）"
          value={form.password}
          onChange={(e) => update({ password: e.target.value })}
          placeholder="密码 *"
          autoComplete="new-password"
          className={inputClass}
        />
        <input
          type="text"
          id="entry-url"
          name="url"
          aria-label="网址"
          value={form.url}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="网址"
          className={inputClass}
        />
        <CustomSelect
          value={form.category_id ? String(form.category_id) : ''}
          onChange={(v) => update({ category_id: v ? parseInt(v) : undefined })}
          options={categories.map((cat) => ({ value: String(cat.id), label: cat.name }))}
          placeholder="选择分类"
        />
        <textarea
          id="entry-notes"
          name="notes"
          aria-label="备注"
          value={form.notes}
          onChange={(e) => update({ notes: e.target.value })}
          placeholder="备注"
          rows={3}
          className={`${inputClass} resize-none`}
        />
      </div>

      {confirmDiscard && (
        <div className="mt-4 p-3 rounded-lg bg-app-status-warning/10 border border-app-status-warning/20 flex items-center justify-between gap-2">
          <span className="text-sm text-app-status-warning-text">放弃未保存的修改？</span>
          <div className="flex gap-2">
            <button
              onClick={() => setConfirmDiscard(false)}
              className="px-3 py-1 rounded-md text-sm text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
            >
              继续编辑
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1 rounded-md text-sm text-app-status-warning-text hover:bg-app-status-warning/20 transition-colors cursor-pointer"
            >
              放弃
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={requestClose}
          className="px-4 py-2 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors duration-200 cursor-pointer"
        >
          取消
        </button>
        <button
          onClick={() => onSubmit(form)}
          disabled={!canSubmit}
          className="px-4 py-2 rounded-lg bg-app-status-info text-white transition-colors duration-200 hover:bg-app-status-info-deep disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          保存
        </button>
      </div>
    </Modal>
  );
}

interface CategoryModalProps {
  saving: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function CategoryModal({ saving, error, onSubmit, onClose }: CategoryModalProps) {
  const [name, setName] = useState('');

  return (
    <Modal onClose={onClose} ariaLabel="新建分类">
      <h2 className="text-app-text-primary font-medium mb-4">新建分类</h2>
      <button
        onClick={onClose}
        aria-label="关闭"
        className="absolute top-4 right-4 p-1 rounded-lg text-app-text-tertiary hover:text-app-text-primary transition-colors cursor-pointer"
      >
        <X size={18} />
      </button>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-app-status-error/10 border border-app-status-error/20 text-sm text-app-status-error-text">
          {error}
        </div>
      )}

      <input
        type="text"
        id="category-name"
        name="category-name"
        aria-label="分类名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSubmit(name.trim())}
        placeholder="分类名称"
        autoFocus
        className={inputClass}
      />

      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors duration-200 cursor-pointer"
        >
          取消
        </button>
        <button
          onClick={() => onSubmit(name.trim())}
          disabled={!name.trim() || saving}
          className="px-4 py-2 rounded-lg bg-app-status-info text-white transition-colors duration-200 hover:bg-app-status-info-deep disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          创建
        </button>
      </div>
    </Modal>
  );
}

interface ConfirmDeleteModalProps {
  entryTitle: string;
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDeleteModal({
  entryTitle,
  deleting,
  error,
  onConfirm,
  onClose,
}: ConfirmDeleteModalProps) {
  return (
    <Modal onClose={onClose} ariaLabel="删除确认">
      <h2 className="text-app-text-primary font-medium mb-2">删除密码</h2>
      <p className="text-sm text-app-text-tertiary mb-1">
        确定要删除「{entryTitle}」吗？
      </p>
      <p className="text-xs text-app-text-tertiary mb-4">此操作无法撤销。</p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-app-status-error/10 border border-app-status-error/20 text-sm text-app-status-error-text">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          autoFocus
          className="px-4 py-2 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors duration-200 cursor-pointer"
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={deleting}
          className="px-4 py-2 rounded-lg bg-app-status-error/90 text-white hover:bg-app-status-error transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
        >
          {deleting && <Loader2 size={14} className="animate-spin" />}
          删除
        </button>
      </div>
    </Modal>
  );
}
