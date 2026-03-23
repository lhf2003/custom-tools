import { BookOpen, Search, Command as CommandIcon } from 'lucide-react';
import { BUILT_IN_TOOLS } from '@/constants/tools';

export function ManualSettings() {
  const toolsWithDescription = BUILT_IN_TOOLS.filter(
    (tool): tool is typeof tool & { description: string } => tool.description !== undefined,
  );

  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500/30 to-orange-600/20 flex items-center justify-center">
          <BookOpen size={20} className="text-orange-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">操作手册</h2>
          <p className="text-white/40 text-xs">快速上手本系统的使用方法</p>
        </div>
      </div>

      {/* 内置工具介绍 */}
      <div className="mb-8">
        <h3 className="text-white/80 text-sm font-medium mb-4 flex items-center gap-2">
          <span className="w-1 h-4 bg-blue-500 rounded-full" />
          内置工具
        </h3>
        <div className="space-y-3">
          {toolsWithDescription.map((tool) => {
            const Icon = tool.icon;
            return (
              <div
                key={tool.id}
                className="rounded-xl p-4 border border-white/10 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04] transition-all"
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-lg ${tool.color} flex items-center justify-center flex-shrink-0`}>
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-white/90 text-sm font-medium">{tool.name}</h4>
                    <p className="text-white/50 text-xs mt-1 leading-relaxed">{tool.description}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 搜索框使用方法 */}
      <div className="mb-8">
        <h3 className="text-white/80 text-sm font-medium mb-4 flex items-center gap-2">
          <span className="w-1 h-4 bg-green-500 rounded-full" />
          搜索框使用
        </h3>
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <Search className="w-4 h-4 text-white/60" />
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">应用搜索</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在搜索框中输入应用名称，系统会实时显示匹配的程序。支持模糊搜索，无需输入完整名称。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <CommandIcon className="w-4 h-4 text-white/60" />
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">快速启动内置工具</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  输入"剪贴板"、"笔记"、"密码"等关键词可直接启动对应工具。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <span className="text-white/60 text-xs font-mono">Ctrl+V</span>
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">粘贴 JSON 文本</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在搜索框中粘贴 JSON 文本，系统会自动识别并跳转到 JSON 格式化工具，直接展示格式化结果。
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                <span className="text-white/60 text-xs font-mono">⇧Tab</span>
              </div>
              <div>
                <h4 className="text-white/80 text-sm font-medium">启动 AI 聊天</h4>
                <p className="text-white/50 text-xs mt-1 leading-relaxed">
                  在搜索框聚焦时按 Shift+Tab，快速跳转到 AI 聊天页面。若搜索框已有输入内容，将作为首条消息自动发送。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 快捷键使用 */}
      <div className="mb-6">
        <h3 className="text-white/80 text-sm font-medium mb-4 flex items-center gap-2">
          <span className="w-1 h-4 bg-purple-500 rounded-full" />
          快捷键绑定
        </h3>
        <div className="rounded-xl p-4 border border-white/10 bg-white/[0.02]">
          <div className="space-y-4">
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
              <div key={key} className="flex items-start gap-3">
                <div className="flex-shrink-0">
                  <kbd className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70 text-xs font-mono">
                    {key}
                  </kbd>
                </div>
                <div>
                  <h4 className="text-white/80 text-sm font-medium">{title}</h4>
                  <p className="text-white/50 text-xs mt-1 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
