import { useState, useRef, useEffect, useCallback } from 'react';

const KEY_NAME_MAP: Record<string, string> = {
  Control: 'Ctrl',
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

function formatKey(key: string): string {
  const mapped = KEY_NAME_MAP[key] || key;
  if (mapped.length === 1 || Object.values(KEY_NAME_MAP).includes(mapped)) {
    return mapped;
  }
  return mapped.charAt(0).toUpperCase() + mapped.slice(1);
}

export function buildCombo(e: React.KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');

  const mainKey = formatKey(e.key);
  if (!['Ctrl', 'Shift', 'Alt', 'Meta'].includes(mainKey)) {
    parts.push(mainKey);
  }
  return parts.join('+');
}

interface KeyRecorderProps {
  value: string;
  onChange: (keys: string) => void;
  onSave: (keys: string) => void;
  onCancel: () => void;
}

export function KeyRecorder({ value, onChange, onSave, onCancel }: KeyRecorderProps) {
  const [currentCombo, setCurrentCombo] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const combo = buildCombo(e);
    setCurrentCombo(combo);
  }, []);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      setCurrentCombo('');
    } else {
      setCurrentCombo(buildCombo(e));
    }
  }, []);

  const handleSave = () => {
    if (currentCombo) onSave(currentCombo);
  };

  return (
    <div className="flex items-center gap-2">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        className="px-4 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm font-mono min-w-[140px] text-center outline-none focus:ring-2 focus:ring-blue-500/50 focus:bg-blue-500/20 select-none cursor-pointer"
      >
        {currentCombo || '按快捷键...'}
      </div>
      <button
        onClick={handleSave}
        disabled={!currentCombo}
        className="px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        保存
      </button>
      <button
        onClick={onCancel}
        className="px-4 py-2 rounded-lg bg-white/5 text-white/60 text-sm hover:bg-white/10 hover:text-white transition-all duration-200 cursor-pointer border border-white/10"
      >
        取消
      </button>
    </div>
  );
}
