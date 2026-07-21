import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Info, X } from 'lucide-react';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (isOpen) {
      getVersion()
        .then(setVersion)
        .catch(() => setVersion(''));
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[360px] bg-app-bg-tertiary rounded-xl shadow-2xl border border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-app-bg-elevated/50">
          <div className="flex items-center gap-2">
            <Info className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-semibold text-app-text-primary">关于</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="p-1.5 text-app-text-disabled hover:text-app-text-secondary hover:bg-white/5 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-lg font-semibold text-app-text-primary">FlowHub</h3>
            <span className="text-sm text-app-text-tertiary">v{version || '—'}</span>
          </div>
          <p className="text-sm text-app-text-secondary mt-2 leading-relaxed">
            Windows 桌面效率中枢——启动器、剪贴板、密码本、笔记与陪伴，唤起即用。
          </p>
          <p className="text-xs text-app-text-disabled mt-4">Tauri · React · Rust</p>
        </div>
      </div>
    </div>
  );
}
