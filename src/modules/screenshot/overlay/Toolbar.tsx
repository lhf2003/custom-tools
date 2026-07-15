import { Tooltip } from '@/components/Tooltip';
import {
  Check,
  Copy,
  X,
  Type,
  Square,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

type EditMode = 'none' | 'rect' | 'arrow' | 'text' | 'mosaic';

interface ToolbarButton {
  id: string;
  icon: React.ElementType;
  label: string;
  shortcut: string;
  onClick: () => void;
  primary?: boolean;
  active?: boolean;
  loading?: boolean;
}

interface ToolbarProps {
  position: { left: number; top: number } | null;
  editMode: EditMode;
  isOcrProcessing: boolean;
  onSave: () => void;
  onCopy: () => void;
  onSetEditMode: (mode: EditMode) => void;
  onOcr: () => void;
  onCancel: () => void;
}

export function Toolbar({
  position,
  editMode,
  isOcrProcessing,
  onSave,
  onCopy,
  onSetEditMode,
  onOcr,
  onCancel,
}: ToolbarProps) {
  if (!position) return null;

  const toolbarButtons: (ToolbarButton | { id: string; isDivider: true })[] = [
    {
      id: 'save',
      icon: Check,
      label: '保存',
      shortcut: 'Enter',
      onClick: onSave,
      primary: true,
    },
    {
      id: 'copy',
      icon: Copy,
      label: '复制',
      shortcut: 'Ctrl+C',
      onClick: onCopy,
    },
    { id: 'divider1', isDivider: true },
    {
      id: 'rect',
      icon: Square,
      label: '矩形',
      shortcut: '',
      onClick: () => onSetEditMode(editMode === 'rect' ? 'none' : 'rect'),
      active: editMode === 'rect',
    },
    {
      id: 'arrow',
      icon: ArrowRight,
      label: '箭头',
      shortcut: '',
      onClick: () => onSetEditMode(editMode === 'arrow' ? 'none' : 'arrow'),
      active: editMode === 'arrow',
    },
    {
      id: 'text',
      icon: Type,
      label: '文字',
      shortcut: '',
      onClick: () => onSetEditMode(editMode === 'text' ? 'none' : 'text'),
      active: editMode === 'text',
    },
    { id: 'divider2', isDivider: true },
    {
      id: 'ocr',
      icon: Sparkles,
      label: 'OCR',
      shortcut: '',
      onClick: onOcr,
      loading: isOcrProcessing,
    },
    { id: 'divider3', isDivider: true },
    {
      id: 'cancel',
      icon: X,
      label: '取消',
      shortcut: 'ESC',
      onClick: onCancel,
    },
  ];

  return (
    <div
      className="fixed flex items-center gap-0.5 px-2 py-1.5 bg-[#1f1f1f]/95 backdrop-blur rounded-lg shadow-2xl border border-gray-700/50 z-50"
      style={{
        left: position.left,
        top: position.top,
        transform: 'translateX(-50%)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {toolbarButtons.map((item) => {
        if ('isDivider' in item) {
          return <div key={item.id} className="w-px h-5 bg-gray-600 mx-1" />;
        }
        const button = item;
        const btnContent = (
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              button.onClick();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            disabled={button.loading}
            className={`relative flex items-center justify-center w-9 h-9 rounded transition-colors ${
              button.primary
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : button.active
                ? 'bg-white/10 text-blue-400'
                : 'text-gray-300 hover:bg-white/5 hover:text-white'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {button.loading ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <button.icon className="w-[18px] h-[18px]" strokeWidth={1.5} />
            )}
          </button>
        );
        return (
          <Tooltip
            key={button.id}
            content={`${button.label} ${button.shortcut ? `(${button.shortcut})` : ''}`}
            placement="top"
          >
            {btnContent}
          </Tooltip>
        );
      })}
    </div>
  );
}
