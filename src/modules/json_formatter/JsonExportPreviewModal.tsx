import { useState, useCallback, useEffect, useRef } from 'react';
import { X, Copy, Download, Check } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  imageDataUrl: string;
  defaultFilename: string;
  onClose: () => void;

}

interface SaveMsg {
  text: string;
  ok: boolean;
}

export function JsonExportPreviewModal({ imageDataUrl, defaultFilename, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<SaveMsg | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc 只关闭本模态 + Tab 焦点陷阱，统一在 capture 阶段处理：
  // - Esc：stopPropagation，避免 App 级全局 Esc（返回启动器）把整个模块一起带走
  // - Tab/Shift+Tab：焦点困在 dialog 内循环，逃出时拉回（aria-modal="true" 的承诺）
  // 不给背后内容加 inert：React 18 对 inert 属性支持不一致，焦点陷阱已覆盖键盘路径，
  // 鼠标点击背景由 backdrop onClick 拦截（等于关闭模态）。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const focusOutside = !dialog.contains(active);
      if (e.shiftKey && (focusOutside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (focusOutside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    try {
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setSaveMsg({ text: '复制图片失败，请重试', ok: false });
    }
  }, [imageDataUrl]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const path = await save({
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        defaultPath: defaultFilename,
      });
      if (!path) return; // user cancelled
      const base64Data = imageDataUrl.replace('data:image/png;base64,', '');
      await invoke('save_image_to_path', { base64Data, path });
      // 成功路径常驻显示（不自动消失）且可选中复制——保存位置是用户要带走的信息
      setSaveMsg({ text: `已保存至 ${path}`, ok: true });
    } catch {
      setSaveMsg({ text: '保存失败，请重试', ok: false });
    } finally {
      setSaving(false);
    }
  }, [imageDataUrl, defaultFilename]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="导出预览"
        className="flex flex-col bg-app-bg-primary border border-app-border rounded-xl
                   shadow-[0_25px_60px_rgba(0,0,0,0.6)] w-[700px] max-h-[88vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border flex-shrink-0">
          <span className="text-sm font-medium text-app-text-primary">导出预览</span>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-app-text-tertiary hover:text-app-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Image preview */}
        <div className="flex-1 overflow-auto min-h-0 p-4 bg-black/20">
          <img
            src={imageDataUrl}
            alt="JSON 导出预览"
            className="w-full rounded border border-app-border"
            draggable={false}
          />
        </div>

        {/* Save / copy result — stays visible until the next action, path is selectable */}
        {saveMsg && (
          <div className={`px-4 py-2 text-xs flex-shrink-0 select-text border-t ${
            saveMsg.ok
              ? 'bg-emerald-900/30 border-emerald-800/50 text-emerald-300'
              : 'bg-red-900/30 border-red-800/50 text-red-300'
          }`}>
            {saveMsg.text}
          </div>
        )}

        {/* Action bar */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary
                       hover:text-app-text-primary hover:bg-white/5 transition-colors"
          >
            关闭
          </button>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       bg-app-bg-elevated hover:bg-app-bg-pressed text-app-text-primary transition-colors"
          >
            {copied
              ? <Check className="w-3.5 h-3.5 text-app-status-success" />
              : <Copy className="w-3.5 h-3.5" />}
            {copied ? '已复制' : '复制图片'}
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            autoFocus
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       bg-app-status-info hover:bg-blue-600 text-white transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            {saving ? '保存中...' : '另存为...'}
          </button>
        </div>
      </div>
    </div>
  );
}
