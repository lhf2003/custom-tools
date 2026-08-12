import { ArrowRight, Brain, FileText, Lightbulb, Search, StickyNote, TrendingUp } from 'lucide-react';
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

interface ManualSettingsProps {
  /** 切换到设置内其他 tab（如从快捷键说明跳到「快捷键」绑定页） */
  onNavigateTab: (tabId: string) => void;
}

export function ManualSettings({ onNavigateTab }: ManualSettingsProps) {
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
      <SettingGroup
        title="快捷键绑定"
        actions={
          <button
            type="button"
            onClick={() => onNavigateTab('shortcuts')}
            className="px-2 py-1 rounded-md text-app-text-tertiary text-xs hover:bg-white/10 hover:text-app-text-primary transition-colors cursor-pointer flex items-center gap-1.5"
          >
            前往设置
            <ArrowRight size={13} />
          </button>
        }
      >
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

      {/* 陪伴功能介绍 */}
      <SettingGroup title="陪伴功能介绍">
        {[
          {
            icon: <Brain className="w-4 h-4 text-app-text-secondary" />,
            title: '长期记忆',
            desc: '贾维斯会记住你的偏好和高频习惯，跨对话持续生效；可在「陪伴 → 记忆中心」查看、编辑和删除。',
          },
          {
            icon: <Lightbulb className="w-4 h-4 text-app-text-secondary" />,
            title: '主动建议',
            desc: '基于你的电脑使用行为，在合适时机弹出建议与提醒（如休息、工作流优化）；建议历史可在「陪伴 → 建议中心」回溯与补操作。',
          },
          {
            icon: <TrendingUp className="w-4 h-4 text-app-text-secondary" />,
            title: '学习习惯',
            desc: '后台持续学习你的应用组合与使用时间窗，逐步识别工作模式，让建议和日报越来越贴合你的节奏。',
          },
          {
            icon: <FileText className="w-4 h-4 text-app-text-secondary" />,
            title: '工作日报',
            desc: '每晚 0 点自动汇总昨日工作生成日报写入笔记，也可在「陪伴」设置中随时手动生成。',
          },
          {
            icon: <StickyNote className="w-4 h-4 text-app-text-secondary" />,
            title: '快速备忘',
            desc: '在启动器输入「记 xxx」回车即记录待办备忘，内容写入笔记，随日报一起沉淀。',
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
    </>
  );
}
