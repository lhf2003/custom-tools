/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 语义化背景色（2026-08-05 新灰阶：五档明度均匀拉开，相邻档 OKLCH L 差 ≥0.03，见 DESIGN.md）
        'app-bg': {
          primary: '#1e1e21',    // 主背景基座
          secondary: '#26262a',  // 侧边栏
          tertiary: '#2e2e33',   // 卡片、输入框
          elevated: '#38383e',   // 悬浮、下拉
          pressed: '#45454c',    // 按压、选中
        },
        // 语义化文字色
        'app-text': {
          primary: '#f4f4f5',    // zinc-100
          secondary: '#d4d4d8',  // zinc-300
          tertiary: '#a1a1aa',   // zinc-400
          disabled: '#71717a',   // zinc-500
          placeholder: '#9a9aa2', // 实测 5.95:1 on base / 4.84:1 on tertiary
        },
        // 语义化边框色
        'app-border': {
          DEFAULT: 'rgba(82, 82, 91, 0.3)',
          emphasis: 'rgba(82, 82, 91, 0.5)',
          subtle: 'rgba(63, 63, 70, 0.5)',
        },
        // 品牌色
        'app-brand': {
          primary: '#6366f1',    // indigo-500
          'primary-light': '#818cf8', // indigo-400，深色表面选中文字
          secondary: '#a855f7',  // purple-500
        },
        // 2026-08-05 灰阶重映射：zinc-600/700/800 对齐新表面色阶，存量 bg-zinc-* 自动跟随
        //（其余档保持 Tailwind 默认；新增代码请用 app-bg / app-text 语义 token）
        zinc: {
          600: '#45454c',        // = app-bg-pressed
          700: '#38383e',        // = app-bg-elevated
          800: '#1e1e21',        // = app-bg-primary
        },
        // 状态色
        'app-status': {
          success: '#22c55e',
          warning: '#f59e0b',
          'warning-text': '#fcd34d', // 深色表面上的警告文字（amber-300，对齐 error-text 提亮变体）
          error: '#ef4444',
          'error-text': '#f87171',  // 深色表面上的错误文字（实测 ≥5.9:1）
          info: '#2563eb',
          'info-deep': '#1d4ed8',   // Action Blue Deep（主按钮 hover）
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
