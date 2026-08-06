import { Search, Command as CommandIcon } from 'lucide-react';
import { listLauncherEntriesWithDescription } from '@/plugins/launcherEntries';
import { SettingGroup } from '../components/SettingsPrimitives';

export function ManualSettings() {
  const toolsWithDescription = listLauncherEntriesWithDescription();

  return (
    <>
      {/* 内置工具介绍 */}
      <SettingGroup title="内置工具">
        {toolsWithDescription.map((tool) => {
          const Icon = tool.icon;
          return (
            <div
              key={tool.id}
              className="flex items-start gap-3 px-3 py-3"
            >
              <div className="w-9 h-9 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
                <Icon className="text-app-text-secondary" size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-app-text-primary text-sm font-medium">{tool.name}</h4>
                <p className="text-app-text-tertiary text-xs mt-0.5 leading-relaxed">{tool.description}</p>
              </div>
            </div>
          );
        })}
      </SettingGroup>

      {/* 搜索框使用方法 */}
      <SettingGroup title="搜索框使用">
        {[
          {
            icon: <Search className="w-4 h-4 text-app-text-secondary" />,
            title: '应用搜索',
            desc: '在搜索框中输入应用名称，系统会实时显示匹配的程序。支持模糊搜索，无需输入完整名称。',
          },
          {
            icon: <CommandIcon className="w-4 h-4 text-app-text-secondary" />,
            title: '快速启动内置工具',
            desc: '输入"剪贴板"、"笔记"、"密码"等关键词可直接启动对应工具。',
          },
          {
            icon: <span className="text-app-text-secondary text-xs font-mono">Ctrl+V</span>,
            title: '粘贴 JSON 文本',
            desc: '在搜索框中粘贴 JSON 文本，系统会自动识别并跳转到 JSON 格式化工具，直接展示格式化结果。',
          },
          {
            icon: <span className="text-app-text-secondary text-xs font-mono">⇧Tab</span>,
            title: '启动 AI 聊天',
            desc: '在搜索框聚焦时按 Shift+Tab，快速跳转到 AI 聊天页面。若搜索框已有输入内容，将作为首条消息自动发送。',
          },
        ].map(({ icon, title, desc }) => (
          <div key={title} className="flex items-start gap-3 px-3 py-3">
            <div className="w-8 h-8 rounded-lg bg-app-bg-elevated flex items-center justify-center flex-shrink-0">
              {icon}
            </div>
            <div className="min-w-0">
              <h4 className="text-app-text-primary text-sm font-medium">{title}</h4>
              <p className="text-app-text-tertiary text-xs mt-0.5 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </SettingGroup>

      {/* 快捷键使用 */}
      <SettingGroup title="快捷键绑定">
        {[
          {
            key: 'Alt+Space',
            title: '显示/隐藏窗口',
            desc: '全局快捷键，在任何界面按下即可快速呼出或隐藏本工具。',
          },
          {
            key: 'Esc',
            title: '返回/关闭',
            desc: '在各功能页面按 Esc 键可返回主界面或关闭当前窗口。',
          },
          {
            key: '↑ ↓',
            title: '上下选择',
            desc: '在搜索结果或列表中使用方向键快速切换选中项，按 Enter 确认。',
          },
        ].map(({ key, title, desc }) => (
          <div key={key} className="flex items-start gap-3 px-3 py-3">
            <kbd className="px-2 py-1 rounded-md bg-app-bg-elevated border border-white/10 text-app-text-secondary text-xs font-mono flex-shrink-0">
              {key}
            </kbd>
            <div className="min-w-0">
              <h4 className="text-app-text-primary text-sm font-medium">{title}</h4>
              <p className="text-app-text-tertiary text-xs mt-0.5 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </SettingGroup>
    </>
  );
}
