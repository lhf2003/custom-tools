/**
 * 设置页布局原语：SettingGroup / SettingRow / Toggle
 * Win11/Raycast 式分组卡片——SettingGroup 用 Sidebar 色圆角容器包裹行列表
 * （窗口左右统一 Base 基座，容器是页面唯一浮起层），行间 hairline 分隔；
 * 设置行无 hover 铺底（整行不可点，交互在右侧控件）。
 * 页面无顶部大标题：组标题承担说明职责。
 */

interface SettingGroupProps {
  title: string;
  /** 组标题行右侧操作区（ghost 小按钮，如「恢复默认」「AI 生成」） */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** 设置分组：组标题（可带右侧操作）+ Sidebar 色圆角容器，行间 hairline 分隔，组间靠大间距分隔 */
export function SettingGroup({ title, actions, children }: SettingGroupProps) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between gap-2 px-3 mb-1.5">
        <h3 className="text-xs font-semibold text-app-text-tertiary">{title}</h3>
        {actions}
      </div>
      <div className="rounded-xl bg-app-bg-secondary overflow-hidden divide-y divide-app-border-subtle">
        {children}
      </div>
    </section>
  );
}

interface SettingRowProps {
  title: string;
  /** 支持富文本（如状态色警告文案） */
  description?: React.ReactNode;
  children?: React.ReactNode;
}

/** 行式设置项：行间由 SettingGroup 的 hairline 分隔，行本身无 hover 底色 */
export function SettingRow({ title, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center gap-4 px-3 py-3">
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
  /** 禁用态：不响应点击，视觉降低存在感（如未选模型时的思考开关） */
  disabled?: boolean;
}

export function Toggle({ enabled = false, onToggle, onClick, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? '关闭' : '开启'}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        onToggle?.(!enabled);
      }}
      className={`relative w-12 h-7 rounded-full overflow-hidden transition-colors duration-200 ${
        disabled ? 'cursor-not-allowed opacity-30' : 'cursor-pointer'
      } ${
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
