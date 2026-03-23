import { History } from 'lucide-react';

interface ChangelogEntry {
  version: string;
  date: string;
  tag: 'feat' | 'fix' | 'refactor';
  items: string[];
}

const CHANGELOG: ChangelogEntry[] = [
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
