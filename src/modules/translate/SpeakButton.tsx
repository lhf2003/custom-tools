import { Square, Volume2 } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';

interface SpeakButtonProps {
  /** 本按钮管的目标是否在播（在播显示停止方块） */
  playing: boolean;
  onToggle: () => void;
  /** 空闲态提示（「听原文」/「播报译文」）；播放态固定显示「停止播报」 */
  label: string;
  /** Tooltip 包裹层布局类（absolute 定位 / flex 收缩等由调用方给） */
  wrapperClassName?: string;
}

/** 翻译播报按钮：喇叭 ↔ 停止方块双态（ChatView 消息重播同款模式） */
export function SpeakButton({ playing, onToggle, label, wrapperClassName }: SpeakButtonProps) {
  return (
    <Tooltip content={playing ? '停止播报' : label} wrapperClassName={wrapperClassName}>
      <button
        onClick={onToggle}
        aria-label={playing ? '停止播报' : label}
        className="flex items-center justify-center w-5 h-5 rounded-md text-app-text-placeholder hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
      >
        {playing ? <Square size={10} /> : <Volume2 size={12} />}
      </button>
    </Tooltip>
  );
}
