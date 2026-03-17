interface ToolbarButtonProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

export function ToolbarButton({ onClick, title, children }: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-all duration-200 cursor-pointer flex items-center"
    >
      {children}
    </button>
  );
}
