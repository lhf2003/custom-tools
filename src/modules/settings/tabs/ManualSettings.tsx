import { Search } from 'lucide-react';
import { useToastStore } from '@/stores/toastStore';
import { useGuideStore } from '@/modules/guide';
import { SettingGroup, SettingRow } from '../components/SettingsPrimitives';

/** 新手引导区：重看欢迎页 + 重置功能提示（看完即焚的一次性气泡） */
function GuideSection() {
  const seenCount = useGuideStore((s) => Object.keys(s.seenTips).length);
  const replayWelcome = useGuideStore((s) => s.replayWelcome);
  const resetTips = useGuideStore((s) => s.resetTips);
  const addToast = useToastStore((s) => s.addToast);

  const ghostButton =
    'px-3 py-1.5 rounded-lg text-xs text-app-text-tertiary hover:text-app-text-primary hover:bg-app-bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-app-text-tertiary';

  const handleResetTips = async () => {
    const count = await resetTips();
    addToast({
      type: 'success',
      title: count > 0 ? `已重置 ${count} 条功能提示` : '没有已读的功能提示',
    });
  };

  return (
    <SettingGroup title="新手引导">
      <SettingRow title="重新查看欢迎页" description="再次展示首次启动时的引导">
        <button type="button" className={ghostButton} onClick={replayWelcome}>
          查看
        </button>
      </SettingRow>
      <SettingRow
        title="重置功能提示"
        description={
          seenCount > 0
            ? `已读 ${seenCount} 条，重置后将在对应功能中重新出现`
            : '各功能首次使用时的一次性提示'
        }
      >
        <button
          type="button"
          className={ghostButton}
          disabled={seenCount === 0}
          onClick={() => void handleResetTips()}
        >
          重置
        </button>
      </SettingRow>
    </SettingGroup>
  );
}

export function ManualSettings() {
  return (
    <>
      {/* 新手引导（重看欢迎页 / 重置气泡） */}
      <GuideSection />

      {/* 搜索框使用方法 */}
      <SettingGroup title="搜索框使用">
        {[
          {
            icon: <Search className="w-4 h-4 text-app-text-secondary" />,
            title: '搜索应用或命令/@快速调用命令',
            desc: '输入应用名称或功能关键词实时匹配，支持模糊搜索；以 @ 开头直接调用对应功能（如 @time），空格后可带参数。',
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
