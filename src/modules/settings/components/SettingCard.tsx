interface SettingCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function SettingCard({ title, description, children }: SettingCardProps) {
  return (
    <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02] hover:border-white/15 transition-colors">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-white/90 text-sm font-medium">{title}</p>
          {description && (
            <p className="text-white/40 text-xs mt-0.5">{description}</p>
          )}
        </div>
        <div className="flex-shrink-0">{children}</div>
      </div>
    </div>
  );
}

interface ToggleProps {
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}

export function Toggle({ enabled = false, onToggle }: ToggleProps) {
  return (
    <button
      onClick={() => onToggle?.(!enabled)}
      className={`relative w-12 h-7 rounded-full overflow-hidden transition-colors duration-200 cursor-pointer ${
        enabled ? 'bg-blue-500' : 'bg-zinc-600 hover:bg-zinc-500'
      }`}
    >
      <span
        className={`absolute top-1 left-0 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
