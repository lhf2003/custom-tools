/**
 * 设置页布局原语：PageHeader / SettingGroup / SettingRow / Toggle
 * 行式布局——层级靠排版与灰阶建立，不用卡片边框（对齐 DESIGN.md）。
 */

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

/** 设置页统一页头：16px 600 标题 + 12px 三级文字副标题，右侧可选操作区 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-app-text-primary">{title}</h2>
        {description && <p className="text-app-text-tertiary text-xs mt-1">{description}</p>}
      </div>
      {actions && <div className="flex-shrink-0">{actions}</div>}
    </div>
  );
}

interface SettingGroupProps {
  title: string;
  children: React.ReactNode;
}

/** 设置分组：小字组标题 + 行容器，组间靠间距分隔 */
export function SettingGroup({ title, children }: SettingGroupProps) {
  return (
    <section className="mb-6">
      <h3 className="text-xs font-semibold text-app-text-tertiary px-3 mb-1.5">{title}</h3>
      <div>{children}</div>
    </section>
  );
}

interface SettingRowProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
}

/** 行式设置项：hover 铺纱层底色，无卡片无边框 */
export function SettingRow({ title, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-app-text-primary text-sm font-medium">{title}</p>
        {description && (
          <p className="text-app-text-tertiary text-xs mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      {children && <div className="flex-shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );
}

interface ToggleProps {
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  /** 点击事件拦截，常用于阻止外层可折叠区域误触发 */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function Toggle({ enabled = false, onToggle, onClick }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? '关闭' : '开启'}
      onClick={(e) => {
        onClick?.(e);
        onToggle?.(!enabled);
      }}
      className={`relative w-12 h-7 rounded-full overflow-hidden transition-colors duration-200 cursor-pointer ${
        enabled ? 'bg-app-status-info hover:bg-blue-700' : 'bg-app-bg-pressed hover:bg-[#4e4e56]'
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
