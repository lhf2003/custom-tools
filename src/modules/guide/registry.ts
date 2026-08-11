import type { CapabilityItem, GuideTipDef } from './types';

/**
 * 引导气泡注册表。克制原则：每视图首批至多 1 条，教一次就够。
 * 快捷键是教学重点：首行一律给该模块的全局直达键（默认键位，
 * 与 src-tauri/src/settings/shortcuts.rs 的 get_default_shortcuts 对齐）。
 * 新功能提示：追加条目并登记 minVersion（发版版本），未读用户首次进入对应视图即触发；
 * 触发只由「未读」驱动，minVersion 不参与判定——老用户升级时已读集合为空，自然只看到新条目。
 */
export const GUIDE_TIPS: GuideTipDef[] = [
  {
    id: 'launcher-search',
    view: 'launcher',
    anchor: '[data-guide="launcher-search"]',
    title: '输入即搜',
    body: '应用、插件、AI都在这一个框里。',
    keyHints: [
      { combo: 'Alt+Space', label: '任何界面随时唤起' },
      { combo: 'tab', label: '切换到AI聊天' },
      { combo: '@+插件名 {参数}', label: '快速调用插件' },
      { combo: '← → + ↵', label: '选择并启动' },
    ],
    placement: 'bottom',
  },
  {
    id: 'clipboard-paste',
    view: 'clipboard',
    anchor: '[data-guide="clipboard-list"]',
    title: '复制过的，都在这',
    body: '文本、图片、音频、视频与文件，双击条目直接贴回上一个窗口。',
    keyHints: [
      { combo: 'Ctrl+Shift+C', label: '任何界面随时打开剪贴板' },
      { combo: 'F', label: '收藏常用数据' },
      { combo: '↵', label: '粘贴选中条目' },
    ],
    placement: 'bottom',
  },
  {
    id: 'password-unlock',
    view: 'password',
    anchor: '[data-guide="password-unlock"]',
    title: '密码本',
    body: '主密码解锁一次，会话内免密；条目加密存储在本地。',
    keyHints: [{ combo: 'Ctrl+Shift+P', label: '随时打开密码本' }],
    placement: 'bottom',
  },
  {
    id: 'markdown-notes',
    view: 'markdown',
    anchor: '[data-guide="markdown-toolbar"]',
    title: 'Markdown 笔记',
    body: '支持 Markdown 全语法，内容以文件保存在本地。随时记上一笔，支持AI排版。',
    keyHints: [
      { combo: 'Ctrl+Shift+N', label: '随时打开笔记' },
      { combo: 'Ctrl+N', label: '新建笔记' },
    ],
    placement: 'bottom',
  },
  {
    id: 'chat-ask',
    view: 'chat',
    anchor: '[data-guide="chat-input"]',
    title: 'AI 对话',
    body: '在这里与 AI 对话，帮你制作插件、分析你的活动数据。',
    keyHints: [{ combo: '↵ / Shift+↵', label: '发送 / 换行' }],
    placement: 'top',
  },
];

/** 欢迎页能力地图：两列三行，启动器居首格 */
export const CAPABILITIES: CapabilityItem[] = [
  { icon: 'rocket', name: '启动器', description: '搜应用、找功能，回车直达' },
  { icon: 'clipboard', name: '剪贴板', description: '复制过的，都找得回来' },
  { icon: 'key', name: '密码本', description: '加密存储，一键填充' },
  { icon: 'note', name: '笔记', description: 'Markdown，随手记录' },
  { icon: 'sparkles', name: '陪伴', description: '工作摘要与建议，主动找你' },
  { icon: 'message', name: 'AI 对话', description: '问答与分析，直接开口' },
];
