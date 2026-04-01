/**
 * 扩展的应用主题设计令牌 (Design Tokens)
 *
 * 语义化颜色命名，替代硬编码的 Tailwind zinc 颜色
 * 所有颜色值对应 Dark 主题（工具类应用定位）
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
  // 品牌强调色 (Indigo-Purple 渐变)
  BRAND: {
    PRIMARY: '#6366f1', // indigo-500
    SECONDARY: '#a855f7', // purple-500
    GRADIENT_START: '#6366f1',
    GRADIENT_END: '#a855f7',
  },
  // 功能色
  FUNCTIONAL: {
    SUCCESS: '#22c55e', // green-500
    WARNING: '#f59e0b', // amber-500
    ERROR: '#ef4444', // red-500
    INFO: '#3b82f6', // blue-500
  },
} as const;

// ============================================
// 语义化令牌 (Semantic Tokens)
// ============================================
export const THEME = {
  // -----------------------------------------
  // 背景色 (Backgrounds)
  // -----------------------------------------
  /** 主背景 - 应用最底层 */
  BG_PRIMARY: PRIMITIVE.ZINC[800], // #27272a
  /** 次背景 - 侧边栏、面板 */
  BG_SECONDARY: '#2a2a2a', // 保持原有值
  /** 三级背景 - 卡片、输入框 */
  BG_TERTIARY: '#2d2d2d',
  /** 提升背景 - 悬浮、下拉菜单 */
  BG_ELEVATED: PRIMITIVE.ZINC[700], // #3f3f46
  /** 按压背景 - 选中状态 */
  BG_PRESSED: PRIMITIVE.ZINC[600], // #52525b
  /** 悬停背景 */
  BG_HOVER: 'rgba(82, 82, 91, 0.5)', // zinc-600/50
  /** 激活背景 */
  BG_ACTIVE: 'rgba(82, 82, 91, 0.5)',

  // -----------------------------------------
  // 文字色 (Text)
  // -----------------------------------------
  /** 主要文字 - 标题、重要内容 */
  TEXT_PRIMARY: PRIMITIVE.ZINC[100], // #f4f4f5
  /** 次要文字 - 正文 */
  TEXT_SECONDARY: PRIMITIVE.ZINC[300], // #d4d4d8
  /** 三级文字 - 辅助说明 */
  TEXT_TERTIARY: PRIMITIVE.ZINC[400], // #a1a1aa
  /** 禁用文字 */
  TEXT_DISABLED: PRIMITIVE.ZINC[500], // #71717a
  /** 占位符文字 */
  TEXT_PLACEHOLDER: PRIMITIVE.ZINC[500], // #71717a

  // -----------------------------------------
  // 边框色 (Borders)
  // -----------------------------------------
  /** 默认边框 */
  BORDER_DEFAULT: 'rgba(82, 82, 91, 0.3)', // zinc-600/30
  /** 强调边框 */
  BORDER_EMPHASIS: 'rgba(82, 82, 91, 0.5)', // zinc-600/50
  /** 微妙边框 - 分割线 */
  BORDER_SUBTLE: 'rgba(63, 63, 70, 0.5)', // zinc-700/50

  // -----------------------------------------
  // 按钮色 (Buttons)
  // -----------------------------------------
  /** 次要按钮背景 */
  BTN_BG: '#3a3a3a',
  /** 次要按钮悬停 */
  BTN_BG_HOVER: '#444444',
  /** 主按钮渐变开始 */
  BTN_PRIMARY_FROM: PRIMITIVE.BRAND.GRADIENT_START,
  /** 主按钮渐变结束 */
  BTN_PRIMARY_TO: PRIMITIVE.BRAND.GRADIENT_END,

  // -----------------------------------------
  // 强调色 (Accents)
  // -----------------------------------------
  /** 品牌主色 */
  BRAND_PRIMARY: PRIMITIVE.BRAND.PRIMARY,
  /** 品牌次色 */
  BRAND_SECONDARY: PRIMITIVE.BRAND.SECONDARY,
  /** 选中状态 */
  SELECTED: '#3b82f6', // blue-500

  // -----------------------------------------
  // 状态色 (States)
  // -----------------------------------------
  SUCCESS: PRIMITIVE.FUNCTIONAL.SUCCESS,
  WARNING: PRIMITIVE.FUNCTIONAL.WARNING,
  ERROR: PRIMITIVE.FUNCTIONAL.ERROR,
  INFO: PRIMITIVE.FUNCTIONAL.INFO,

  // -----------------------------------------
  // 透明度变体 (Alpha Variants)
  // -----------------------------------------
  ALPHA: {
    WHITE_5: 'rgba(255, 255, 255, 0.05)',
    WHITE_10: 'rgba(255, 255, 255, 0.10)',
    WHITE_15: 'rgba(255, 255, 255, 0.15)',
    WHITE_25: 'rgba(255, 255, 255, 0.25)',
    WHITE_50: 'rgba(255, 255, 255, 0.50)',
  },

  // -----------------------------------------
  // 阴影 (Shadows)
  // -----------------------------------------
  SHADOW: {
    SM: '0 2px 8px rgba(0, 0, 0, 0.2)',
    MD: '0 4px 24px rgba(0, 0, 0, 0.2)',
    LG: '0 8px 32px rgba(0, 0, 0, 0.3)',
    XL: '0 25px 60px rgba(0, 0, 0, 0.6)',
  },

  // -----------------------------------------
  // Z-Index 层级
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
