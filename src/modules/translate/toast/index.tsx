import React from 'react';
import ReactDOM from 'react-dom/client';
import TranslateToast from './TranslateToast';
import '@/index.css';

// 瞬时浮窗不弹任何右键菜单：拦截 contextmenu 屏蔽 WebView 原生菜单
window.addEventListener('contextmenu', (e) => e.preventDefault());

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <TranslateToast />
    </React.StrictMode>,
  );
}
