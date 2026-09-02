import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * 可展开设置行：系统插件 / 插件市场共用的插件行形态（2026-09-02 起外部插件
 * 不再开独立设置 tab，与系统插件统一为行内展开）。
 * 整行点击展开/收起行内设置区（grid-rows 0fr↔1fr 过渡），右侧控制区点击不触发展开；
 * 展开内容缺省时显示占位文案，保持每个插件交互一致。
 */
interface ExpandableSettingRowProps {
  title: string;
  /** 支持富文本（如状态色警告文案） */
  description?: React.ReactNode;
  /** 右侧控制区（状态徽标/开关/更多菜单），内部点击不触发展开 */
  controls?: React.ReactNode;
  /** 展开区内容；缺省显示「暂无可配置项」占位 */
  children?: React.ReactNode;
}

export function ExpandableSettingRow({
  title,
  description,
  controls,
  children,
}: ExpandableSettingRowProps) {
  const [open, setOpen] = useState(false);
  // 懒挂载标记：首次展开才渲染 children（折叠态不拉起面板的数据加载）；
  // 收起后不卸载，保留面板状态且收起动画有内容可裁剪
  const [hasOpened, setHasOpened] = useState(false);

  const toggleOpen = () => {
    setOpen((v) => !v);
    setHasOpened(true);
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleOpen();
          }
        }}
        className="flex items-center gap-4 px-3 py-3 cursor-pointer hover:bg-white/5 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <p className="text-app-text-primary text-sm font-medium">{title}</p>
          {description && (
            <p className="text-app-text-tertiary text-xs mt-0.5 leading-relaxed">{description}</p>
          )}
        </div>
        {controls && (
          // 点击/按键都拦截冒泡：控制区内的开关、菜单不触发展开
          <div
            className="flex-shrink-0 flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {controls}
          </div>
        )}
        <ChevronDown
          size={16}
          className={`flex-shrink-0 text-app-text-tertiary transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </div>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          {hasOpened && (
            <div className="border-t border-app-border-subtle">
              {children ?? (
                <div className="px-3 py-3 text-xs text-app-text-tertiary">
                  该插件暂无可配置项
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
