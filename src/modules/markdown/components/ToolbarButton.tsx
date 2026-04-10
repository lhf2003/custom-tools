import { Tooltip } from '@/components/Tooltip';

interface ToolbarButtonProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  active?: boolean;
}

export function ToolbarButton({ onClick, title, children, active }: ToolbarButtonProps) {
  return (
    <Tooltip content={title} placement="bottom">
      <button
        onClick={onClick}
        aria-label={title}
        className={`p-1.5 rounded-lg transition-all duration-200 cursor-pointer flex items-center ${
          active
            ? 'text-zinc-200 bg-zinc-600/50'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
