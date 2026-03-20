import { useState, useCallback } from 'react';
import { X, Copy, Download, Check } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  imageDataUrl: string;
  defaultFilename: string;
  onClose: () => void;
}

export function JsonExportPreviewModal({ imageDataUrl, defaultFilename, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const handleCopy = useCallback(async () => {
    try {
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy image failed:', err);
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
      setSaveMsg(`已保存至 ${path}`);
      setTimeout(() => setSaveMsg(null), 5000);
    } catch (err) {
      console.error('Save image failed:', err);
      setSaveMsg('保存失败');
      setTimeout(() => setSaveMsg(null), 3000);
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
        className="flex flex-col bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[700px] max-h-[88vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
          <span className="text-sm font-medium text-zinc-200">导出预览</span>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Image preview */}
        <div className="flex-1 overflow-auto min-h-0 p-4 bg-zinc-950/40">
          <img
            src={imageDataUrl}
            alt="JSON 导出预览"
            className="w-full rounded border border-zinc-800"
            draggable={false}
          />
        </div>

        {/* Save result message */}
        {saveMsg && (
          <div className={`px-4 py-2 text-xs flex-shrink-0 ${
            saveMsg === '保存失败'
              ? 'bg-red-900/30 border-t border-red-800/50 text-red-300'
              : 'bg-emerald-900/30 border-t border-emerald-800/50 text-emerald-300'
          }`}>
            {saveMsg}
          </div>
        )}

        {/* Action bar */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200
                       hover:bg-zinc-800 transition-colors"
          >
            关闭
          </button>

          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
          >
            {copied
              ? <Check className="w-3.5 h-3.5 text-green-400" />
              : <Copy className="w-3.5 h-3.5" />}
            {copied ? '已复制' : '复制图片'}
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       bg-blue-600 hover:bg-blue-500 text-white transition-colors
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
