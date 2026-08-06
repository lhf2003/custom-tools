import { useEffect } from 'react';
import { X } from 'lucide-react';

/* ==================== 更新日志数据（静态历史版本记录） ==================== */

interface ChangelogEntry {
  version: string;
  date: string;
  tag: 'feat' | 'fix' | 'refactor' | 'docs' | 'chore' | 'perf' | 'test' | 'ci' | 'build';
  items: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.3.3',
    date: '2026-04-04',
    tag: 'fix',
    items: [
      '将 Vditor 静态资源打包到应用，解决生产环境 404 问题',
    ],
  },
  {
    version: '0.3.2',
    date: '2026-04-03',
    tag: 'feat',
    items: [
      '实现文件日志系统，支持 1MB 轮转、30 天过期清理及前端日志收集',
      '剪贴板历史支持分页加载，默认 100 条，滚动自动加载更多',
      'Markdown 编辑器新增全屏模式，优化代码块样式与复制按钮',
      '优化 Markdown 笔记右键菜单',
      '统一更新通知为系统通知，托盘右键"显示"改为"设置"入口',
    ],
  },
  {
    version: '0.3.1',
    date: '2026-04-02',
    tag: 'feat',
    items: [
      'Markdown 笔记记住上次打开的笔记和展开文件夹状态',
      '统一窗口尺寸配置，添加剪贴板键盘导航',
      '统一主题颜色系统，提取硬编码颜色为语义化 Token',
      '优化搜索排序，频率权重从 30% 提升到 50%',
      '修复 launcher 展开时滚动条闪现问题',
    ],
  },
  {
    version: '0.2.1',
    date: '2026-04-02',
    tag: 'fix',
    items: [
      '剪贴板交互优化：单击仅选中，双击才复制并排序',
    ],
  },
  {
    version: '0.1.11',
    date: '2026-03-27',
    tag: 'feat',
    items: [
      '剪贴板功能增强：支持复制排序、实时刷新、部分复制',
    ],
  },
  {
    version: '0.1.10',
    date: '2026-03-25',
    tag: 'fix',
    items: [
      '修复多显示器窗口位置偏移问题，支持在鼠标所在显示器显示',
      '修复拖拽功能导致滚动条无法滚动的 bug',
      '修复窗口拖拽区域无法移动的问题',
    ],
  },
  {
    version: '0.1.9',
    date: '2026-03-25',
    tag: 'fix',
    items: [
      '修复毛玻璃效果，简化实现并移除固定背景遮挡',
      '笔记页面标题支持编辑与自动重命名，隐藏 .md 后缀',
      'AI 对话页面背景优化',
      '删除剪贴板记录时同步清理图片文件',
      '修复 LRU 缓存迭代器失效导致的清理不彻底问题',
    ],
  },
  {
    version: '0.1.8',
    date: '2026-03-25',
    tag: 'feat',
    items: [
      'LLM 提供商功能开发',
      '修复 Ollama think 参数传递问题',
    ],
  },
  {
    version: '0.1.7',
    date: '2026-03-25',
    tag: 'feat',
    items: [
      '新增 AI 对话页面，支持流式 LLM 响应与聊天历史持久化',
      '应用品牌统一更名为 FlowHub，更新图标与版本号',
      '重构设置页面，拆分为独立 Tab 组件',
      '左侧笔记栏支持文件名模糊搜索',
      'Acrylic 背景模糊效果，升级 windows crate 到 0.61',
      '下拉框智能定位，底部空间不足时自动向上展开',
    ],
  },
  {
    version: '0.1.6',
    date: '2026-03-20',
    tag: 'feat',
    items: [
      '新增 JSON 格式化工具，支持树形视图与图片导出预览',
      '新增搜索设置 Tab，支持注册表/UWP/自定义目录扫描',
      '前端代码全面重构，消除重复、提升健壮性',
      '修复搜索设置添加目录按钮无效问题',
    ],
  },
  {
    version: '0.1.5',
    date: '2026-03-20',
    tag: 'fix',
    items: [
      '修复 Everything 搜索触发时命令行闪窗问题',
      '优化文件搜索性能',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-03-20',
    tag: 'feat',
    items: [
      '完善 Everything 文件搜索集成功能',
      '新增更新日志页面，优化自动更新流程',
      '将默认启动快捷键改为 Alt+Space',
    ],
  },
  {
    version: '0.1.3',
    date: '2026-03-19',
    tag: 'fix',
    items: [
      '修复自动更新无法检测新版本的问题',
      '修复应用启动时弹出 cmd 窗口的问题',
    ],
  },
  {
    version: '0.1.2',
    date: '2026-03-19',
    tag: 'feat',
    items: [
      '新增拼音首字母搜索支持',
      '修复剪贴板自动粘贴功能',
      '优化 Everything 未安装页面样式',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-03-19',
    tag: 'feat',
    items: [
      '实现系统级窗口模糊效果（Mica/Blur）与自动更新功能',
      '实现开机自启功能',
      '使用 dnd-kit 重构笔记目录拖拽',
      '优化密码管理 UI，支持系统浏览器打开 URL',
      '优化最近使用排序，点击后立即置顶',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-03-19',
    tag: 'feat',
    items: [
      '项目初始版本发布',
      '新增剪贴板图片支持（缩略图显示与粘贴功能）',
      'Markdown 编辑器集成所见即所得（WYSIWYG）功能',
      '实现搜索使用频率排序与应用索引持久化缓存',
      '集成 Everything 文件搜索（后端 + 前端）',
    ],
  },
];

const TAG_STYLE: Record<ChangelogEntry['tag'], string> = {
  feat: 'bg-blue-500/15 text-blue-400',
  fix: 'bg-amber-500/15 text-amber-400',
  refactor: 'bg-purple-500/15 text-purple-400',
  docs: 'bg-emerald-500/15 text-emerald-400',
  chore: 'bg-zinc-500/15 text-zinc-400',
  perf: 'bg-rose-500/15 text-rose-400',
  test: 'bg-cyan-500/15 text-cyan-400',
  ci: 'bg-orange-500/15 text-orange-400',
  build: 'bg-indigo-500/15 text-indigo-400',
};

const TAG_LABEL: Record<ChangelogEntry['tag'], string> = {
  feat: '新功能',
  fix: '修复',
  refactor: '重构',
  docs: '文档',
  chore: '杂项',
  perf: '性能',
  test: '测试',
  ci: 'CI',
  build: '构建',
};

/* ==================== 弹窗 ==================== */

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** 更新日志弹窗：静态历史版本记录（关于页「更新日志」行触发），Esc/遮罩点击关闭 */
export function ChangelogModal({ isOpen, onClose }: ChangelogModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[80vh] bg-app-bg-tertiary rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border-subtle flex-shrink-0">
          <h2 className="text-base font-semibold text-app-text-primary">更新日志</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-app-text-tertiary hover:text-app-text-primary hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content：版本块间 hairline 分隔 */}
        <div className="flex-1 overflow-y-auto px-5 divide-y divide-app-border-subtle">
          {CHANGELOG.map((entry, index) => (
            <div key={entry.version} className="py-4">
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-app-text-primary text-sm font-semibold font-mono">
                  v{entry.version}
                </span>
                {index === 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-app-status-success/15 text-app-status-success">
                    最新
                  </span>
                )}
                <span
                  className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${TAG_STYLE[entry.tag]}`}
                >
                  {TAG_LABEL[entry.tag]}
                </span>
                <span className="text-app-text-disabled text-xs ml-auto">{entry.date}</span>
              </div>
              <ul>
                {entry.items.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2.5 py-1 text-xs text-app-text-secondary leading-relaxed"
                  >
                    <span className="mt-[7px] w-1 h-1 rounded-full bg-app-text-disabled flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
