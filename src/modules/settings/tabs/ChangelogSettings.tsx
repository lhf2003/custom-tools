import { History } from 'lucide-react';

interface ChangelogEntry {
  version: string;
  date: string;
  tag: 'feat' | 'fix' | 'refactor';
  items: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.3',
    date: '2026-03-23',
    tag: 'feat',
    items: [
      '快捷键页面支持文件搜索绑定，调整排序和默认键',
      '修复 app_cache 表缺少 pinyin_initials 列的迁移问题',
      '修复剪贴板复制产生重复记录',
      '优化图片缓存避免重复加载',
    ],
  },
  {
    version: '0.1.2',
    date: '2026-03-10',
    tag: 'feat',
    items: [
      '左侧笔记栏顶部替换为文件名模糊搜索框',
      '聊天历史持久化到 SQLite，支持多轮对话渲染',
      '优化导航栏返回按钮样式，修复笔记目录重复显示问题',
      '修复应用退出时导致已启动第三方应用被强制终止的问题',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-02-20',
    tag: 'feat',
    items: [
      '新增 AI 对话页面，支持流式 LLM 输出',
      'Acrylic 背景模糊效果，升级 windows 0.61',
      '新增搜索设置 Tab，支持注册表/UWP/自定义目录扫描',
      '修复 ClipboardView 首次加载窗口大小跳变问题',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-02-01',
    tag: 'feat',
    items: [
      '新增 JSON 格式化工具，支持树形视图与导出',
      '前端代码全面重构，消除重复、提升健壮性',
      '添加 dialog:allow-open 权限，修复搜索设置目录选择',
      '项目初始版本发布',
    ],
  },
];

const TAG_STYLE: Record<ChangelogEntry['tag'], string> = {
  feat: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  fix: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  refactor: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
};

const TAG_LABEL: Record<ChangelogEntry['tag'], string> = {
  feat: '新功能',
  fix: '修复',
  refactor: '重构',
};

export function ChangelogSettings() {
  return (
    <>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/30 to-sky-600/20 flex items-center justify-center">
          <History size={20} className="text-sky-400" />
        </div>
        <div>
          <h2 className="text-white text-lg font-semibold">更新日志</h2>
          <p className="text-white/40 text-xs">版本迭代记录</p>
        </div>
      </div>

      <div className="space-y-4">
        {CHANGELOG.map((entry, index) => (
          <div
            key={entry.version}
            className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
              <div className="flex items-center gap-2 flex-1">
                <span className="text-white/90 text-sm font-semibold font-mono">
                  v{entry.version}
                </span>
                {index === 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-500/15 text-green-400 border border-green-500/20">
                    最新
                  </span>
                )}
                <span className={`px-1.5 py-0.5 text-[10px] rounded border ${TAG_STYLE[entry.tag]}`}>
                  {TAG_LABEL[entry.tag]}
                </span>
              </div>
              <span className="text-white/30 text-xs">{entry.date}</span>
            </div>
            <ul className="px-4 py-3 space-y-2">
              {entry.items.map((item) => (
                <li key={item} className="flex items-start gap-2 text-xs text-white/55 leading-relaxed">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-white/25 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
