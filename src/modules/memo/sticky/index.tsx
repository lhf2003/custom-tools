import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoStickyView } from './MemoStickyView';
import '@/index.css';

// 工具浮窗不弹任何右键菜单：拦截 contextmenu 屏蔽 WebView 原生菜单
window.addEventListener('contextmenu', (e) => e.preventDefault());

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <MemoStickyView />
    </React.StrictMode>,
  );
}
