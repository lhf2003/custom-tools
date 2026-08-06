/**
 * 应用主题设计令牌 (Design Tokens)
 *
 * 语义化颜色命名，替代硬编码的 Tailwind zinc 颜色。
 * 所有颜色值引用 index.css 的 --app-* CSS 变量：
 *   - :root（深色，默认）
 *   - [data-theme='light']（浅色覆盖）
 * 切主题只改变量值，THEME 常量与 Tailwind 类自动跟随。
 */

// ============================================
// 基础原始色 (Primitive Colors)
// ============================================
const PRIMITIVE = {
  // Zinc 色阶
  ZINC: {
    50: '#fafafa',
    100: '#f4f4f5',
    200: '#e4e4e7',
    300: '#d4d4d8',
    400: '#a1a1aa',
    500: '#71717a',
    600: '#52525b',
    700: '#3f3f46',
    800: '#27272a',
    900: '#18181b',
    950: '#09090b',
  },
  // 品牌强调色
  BRAND: {
    PRIMARY: '#6366f1', // indigo-500
    SECONDARY: '#a855f7', // purple-500
  },
  // 功能色
  FUNCTIONAL: {
    SUCCESS: '#22c55e', // green-500
    WARNING: '#f59e0b', // amber-500
    ERROR: '#ef4444', // red-500
    INFO: '#2563eb', // blue-600（白字 5.17:1，AA 达标）
  },
} as const;

// ============================================
// 语义化令牌 (Semantic Tokens)
// 颜色值 = var(--app-*)，定义于 index.css；z-index 为纯 JS 数字，无 CSS 变量
// ============================================
export const THEME = {
  // -----------------------------------------
  // 背景色 (Backgrounds)
  // -----------------------------------------
  /** 主背景 - 应用最底层 */
  BG_PRIMARY: 'var(--app-bg-primary)',
  /** 次背景 - 侧边栏、面板 */
  BG_SECONDARY: 'var(--app-bg-secondary)',
  /** 三级背景 - 卡片、输入框 */
  BG_TERTIARY: 'var(--app-bg-tertiary)',
  /** 提升背景 - 悬浮、下拉菜单 */
  BG_ELEVATED: 'var(--app-bg-elevated)',
  /** 按压背景 - 选中状态 */
  BG_PRESSED: 'var(--app-bg-pressed)',
  /** 悬停背景 */
  BG_HOVER: 'var(--app-bg-hover)',
  /** 激活背景 */
  BG_ACTIVE: 'var(--app-bg-active)',

  // -----------------------------------------
  // 文字色 (Text)
  // -----------------------------------------
  /** 主要文字 - 标题、重要内容 */
  TEXT_PRIMARY: 'var(--app-text-primary)',
  /** 次要文字 - 正文 */
  TEXT_SECONDARY: 'var(--app-text-secondary)',
  /** 三级文字 - 辅助说明 */
  TEXT_TERTIARY: 'var(--app-text-tertiary)',
  /** 禁用文字 */
  TEXT_DISABLED: 'var(--app-text-disabled)',
  /** 占位符文字 */
  TEXT_PLACEHOLDER: 'var(--app-text-placeholder)',

  // -----------------------------------------
  // 边框色 (Borders)
  // -----------------------------------------
  /** 默认边框 */
  BORDER_DEFAULT: 'var(--app-border-default)',
  /** 强调边框 */
  BORDER_EMPHASIS: 'var(--app-border-emphasis)',
  /** 微妙边框 - 分割线 */
  BORDER_SUBTLE: 'var(--app-border-subtle)',

  // -----------------------------------------
  // 按钮色 (Buttons)
  // -----------------------------------------
  /** 次要按钮背景（对齐 surface-elevated） */
  BTN_BG: 'var(--app-bg-elevated)',
  /** 次要按钮悬停（对齐 surface-pressed） */
  BTN_BG_HOVER: 'var(--app-bg-pressed)',

  // -----------------------------------------
  // 强调色 (Accents)
  // -----------------------------------------
  /** 品牌主色 */
  BRAND_PRIMARY: 'var(--app-brand-primary)',
  /** 品牌次色 */
  BRAND_SECONDARY: 'var(--app-brand-secondary)',
  /** 选中状态 */
  SELECTED: 'var(--app-brand-selected)',

  // -----------------------------------------
  // 状态色 (States)
  // -----------------------------------------
  SUCCESS: 'var(--app-status-success)',
  WARNING: 'var(--app-status-warning)',
  ERROR: 'var(--app-status-error)',
  INFO: 'var(--app-status-info)',
  /** 表面上的错误文字（深色=提亮变体 / 浅色=深档） */
  ERROR_TEXT: 'var(--app-status-error-text)',

  // -----------------------------------------
  // 透明度变体 (Alpha Variants)
  // -----------------------------------------
  ALPHA: {
    WHITE_5: 'var(--app-alpha-white-5)',
    WHITE_10: 'var(--app-alpha-white-10)',
    WHITE_15: 'var(--app-alpha-white-15)',
    WHITE_25: 'var(--app-alpha-white-25)',
    WHITE_50: 'var(--app-alpha-white-50)',
  },

  // -----------------------------------------
  // 阴影 (Shadows)
  // -----------------------------------------
  SHADOW: {
    SM: 'var(--app-shadow-sm)',
    MD: 'var(--app-shadow-md)',
    LG: 'var(--app-shadow-lg)',
    XL: 'var(--app-shadow-xl)',
  },

  // -----------------------------------------
  // Z-Index 层级（纯 JS 数字）
  // -----------------------------------------
  Z_INDEX: {
    BASE: 0,
    ABOVE: 10,
    DROPDOWN: 50,
    STICKY: 100,
    OVERLAY: 200,
    MODAL: 300,
    TOOLTIP: 400,
    TOP: 9999,
  },
} as const;

// ============================================
// 类型导出
// ============================================
export type ThemeType = typeof THEME;

// 为了向后兼容，保留旧导出名称
export const COLORS = PRIMITIVE;
