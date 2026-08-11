/** 气泡内的一行快捷键提示：整串键帽 + 动作说明 */
export interface GuideKeyHint {
  /** 键位整串，如 'Ctrl+Shift+C'、'↑↓ + ↵' */
  combo: string;
  label: string;
}

/** 引导气泡定义：进入指定视图时锚定目标元素展示一次，看完即焚 */
export interface GuideTipDef {
  /** 全局唯一 id，即已读集合内的标记键 */
  id: string;
  /** 触发视图（壳视图或插件视图 id） */
  view: string;
  /** 锚点选择器（data-guide 属性）；查不到时静默标记已读，防御视图改版失配 */
  anchor: string;
  title: string;
  body: string;
  /** 快捷键教学行：首行惯例给该模块的全局直达键 */
  keyHints?: GuideKeyHint[];
  /** 相对锚点方位，默认 bottom */
  placement?: 'top' | 'bottom';
  /** 引入该提示的版本号（登记用；触发只由「未读」驱动） */
  minVersion?: string;
}

/** 欢迎页能力地图条目 */
export interface CapabilityItem {
  icon: 'rocket' | 'clipboard' | 'key' | 'note' | 'sparkles' | 'message';
  name: string;
  description: string;
}
