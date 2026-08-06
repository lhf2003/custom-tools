import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { MenuItem } from '@/types';

/**
 * 启动器前缀路由（uTools features.cmds 形态）：
 * 查询行首命中 keyword 时结果区独占该插件，回车以剩余文本为载荷打开。
 * 行首匹配、大小写敏感（'@JSON' 不命中 '@json'，避免与普通搜索词撞车）。
 */
export interface PluginTrigger {
  keyword: string;
  /** 独占态结果行的占位提示，如 'JSON 文本' */
  argHint?: string;
}

/**
 * 视图插件 manifest。每个插件目录下的 plugin.ts 导出一份，
 * 由 src/plugins/registry.ts 经 import.meta.glob 自动发现（eager）。
 * manifest 本身必须轻量：视图组件走 load() 动态 import，不在此静态引用。
 *
 * kind 当前唯一值 'view'；后台服务类能力将来以 'background' 增量加入。
 */
export interface ViewPlugin {
  kind: 'view';
  /** 插件 id，同时作为 ViewMode 与 builtin:// 路径段，如 'clipboard' */
  id: string;
  name: string;
  /**
   * 图标组件：内置为 Lucide 组件，外部为图片包装组件（兼容 className/size）。
   * 联合类型：LucideIcon 与 ComponentType 在 TS 严格模式不直接兼容。
   */
  icon: LucideIcon | ComponentType<{ className?: string; size?: number }>;
  /** 启动器搜索别名（小写） */
  aliases: string[];
  /** 操作手册文案；缺省的条目不进手册 */
  description?: string;
  /** 启动器网格/手册排序，缺的排最后 */
  order?: number;
  /**
   * 后端 shortcut:open_module 事件 moduleId → 本插件的映射（仅映射，非声明）。
   * 吸收前后端历史 id 不一致（notes→markdown、passwords→password）。
   */
  shortcutModuleId?: string;
  triggers?: PluginTrigger[];
  /** 懒加载视图组件，顺带获得按插件代码分割 */
  load: () => Promise<{ default: ComponentType }>;
  nav: {
    /** 导航栏标题 */
    title: string;
    /** 动作菜单入口文字标签（不传为三点图标） */
    menuLabel?: string;
    /**
     * 插件自己的菜单项（不含公共项；公共项由壳统一追加）。
     * 必须是 hook：菜单可能依赖运行时状态（禁用态/文案切换）。
     * 壳在当前插件激活时于固定位置无条件调用，插件切换以 key 重挂载。
     */
    useMenuItems?: () => MenuItem[];
    /** true 时壳在内容区接管右键，在光标处浮出菜单 */
    contextMenu?: boolean;
    /**
     * 右键浮层的菜单项；缺省回退 useMenuItems 的输出。
     * 与顶部动作菜单分离的场景：右键只给条目级动作（如剪贴板），
     * 列表级/批量操作只留在顶部下拉。
     */
    useContextMenuItems?: () => MenuItem[];
  };
}
