/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 语义化颜色全部走 var(--app-*) CSS 变量：
        // 值定义在 index.css :root（深色）与 [data-theme='light']（浅色），
        // 切主题只改变量，Tailwind 类自动跟随，无需改组件。
        'app-bg': {
          primary: 'var(--app-bg-primary)',    // 主背景基座
          secondary: 'var(--app-bg-secondary)',  // 侧边栏
          tertiary: 'var(--app-bg-tertiary)',   // 卡片、输入框
          elevated: 'var(--app-bg-elevated)',   // 悬浮、下拉
          pressed: 'var(--app-bg-pressed)',    // 按压、选中
          hover: 'var(--app-bg-hover)',        // 悬停（菜单/下拉/列表项底色块）
        },
        // 语义化文字色
        'app-text': {
          primary: 'var(--app-text-primary)',
          secondary: 'var(--app-text-secondary)',
          tertiary: 'var(--app-text-tertiary)',
          disabled: 'var(--app-text-disabled)',
          placeholder: 'var(--app-text-placeholder)',
        },
        // 语义化边框色
        'app-border': {
          DEFAULT: 'var(--app-border-default)',
          emphasis: 'var(--app-border-emphasis)',
          subtle: 'var(--app-border-subtle)',
        },
        // 品牌色
        'app-brand': {
          primary: 'var(--app-brand-primary)',
          'primary-light': 'var(--app-brand-primary-light)', // 深色表面选中文字；浅色下自动换深档
          secondary: 'var(--app-brand-secondary)',
          selected: 'var(--app-brand-selected)',
        },
        // 灰阶重映射：zinc 各档按存量用途映射到语义变量，浅色主题下自动跟随。
        // zinc-500 保持 Tailwind 默认（浅色下 #71717a 4.8:1 可读，无需映射）；
        // 新增代码请用 app-bg / app-text 语义 token。
        zinc: {
          100: 'var(--app-text-primary)',     // 存量 text-zinc-100（主要文字）
          200: 'var(--app-text-secondary)',   // 存量 text-zinc-200（次要文字）
          300: 'var(--app-text-secondary)',   // 存量 text-zinc-300（次要文字）
          400: 'var(--app-text-tertiary)',    // 存量 text-zinc-400（三级文字）
          600: 'var(--app-bg-pressed)',       // 存量 border/bg-zinc-600
          700: 'var(--app-bg-elevated)',      // 存量 border/bg-zinc-700
          800: 'var(--app-bg-primary)',       // 存量 bg-zinc-800
          900: 'var(--app-bg-secondary)',     // 存量 bg-zinc-900
        },
        // 状态色：函数形式支持透明度修饰符（bg-app-status-info/20 等）。
        // 无修饰符直接用 var(--app-status-*)，带修饰符合成 rgb(var(--app-status-*-rgb) / alpha)，
        // RGB 三通道变量定义在 index.css 各主题块（与 --app-panel-rgb 同模式）。
        // 注意：纯 var() 形式 + /alpha 会被 Tailwind 静默丢弃（parseColor 无法解析 var()），
        // 故必须走函数形式，否则所有 status 透明度类都不生成。
        'app-status': {
          success: ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-success)'
              : `rgb(var(--app-status-success-rgb) / ${opacityValue})`,
          warning: ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-warning)'
              : `rgb(var(--app-status-warning-rgb) / ${opacityValue})`,
          'warning-text': ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-warning-text)'
              : `rgb(var(--app-status-warning-text-rgb) / ${opacityValue})`,
          error: ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-error)'
              : `rgb(var(--app-status-error-rgb) / ${opacityValue})`,
          'error-text': ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-error-text)'
              : `rgb(var(--app-status-error-text-rgb) / ${opacityValue})`,
          info: ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-info)'
              : `rgb(var(--app-status-info-rgb) / ${opacityValue})`,
          'info-deep': ({ opacityValue }) =>
            opacityValue === undefined
              ? 'var(--app-status-info-deep)'
              : `rgb(var(--app-status-info-deep-rgb) / ${opacityValue})`,   // Action Blue Deep（主按钮 hover）
        },
        // 保留原有的 glass 颜色
        glass: {
          50: 'rgba(255, 255, 255, 0.05)',
          100: 'rgba(255, 255, 255, 0.1)',
          200: 'rgba(255, 255, 255, 0.2)',
          300: 'rgba(255, 255, 255, 0.3)',
          400: 'rgba(255, 255, 255, 0.4)',
          500: 'rgba(255, 255, 255, 0.5)',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      // 阴影统一映射 DESIGN.md 四档词表（--app-shadow-* 随主题切换：
      // 深色 0.2/0.2/0.3/0.6，浅色自动降档 0.08/0.10/0.12/0.20）。
      // 存量 shadow-lg/xl/2xl 全部跟随，无需改组件。
      boxShadow: {
        lg: 'var(--app-shadow-lg)',
        xl: 'var(--app-shadow-lg)',
        '2xl': 'var(--app-shadow-xl)',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        // 下拉选项入场：配合 --option-enter-offset 感知菜单展开方向，both 让 delay 期间保持初始帧
        'option-in': 'optionIn 150ms ease-out both',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        optionIn: {
          '0%': { transform: 'translateY(var(--option-enter-offset, 4px))', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
