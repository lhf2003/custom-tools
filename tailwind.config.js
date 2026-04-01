/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 语义化背景色
        'app-bg': {
          primary: '#27272a',    // zinc-800
          secondary: '#2a2a2a',  // 侧边栏
          tertiary: '#2d2d2d',   // 卡片、输入框
          elevated: '#3f3f46',   // zinc-700, 悬浮、下拉
          pressed: '#52525b',    // zinc-600, 选中
        },
        // 语义化文字色
        'app-text': {
          primary: '#f4f4f5',    // zinc-100
          secondary: '#d4d4d8',  // zinc-300
          tertiary: '#a1a1aa',   // zinc-400
          disabled: '#71717a',   // zinc-500
          placeholder: '#71717a',
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
          secondary: '#a855f7',  // purple-500
        },
        // 状态色
        'app-status': {
          success: '#22c55e',
          warning: '#f59e0b',
          error: '#ef4444',
          info: '#3b82f6',
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
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
