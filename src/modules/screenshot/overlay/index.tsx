import React from 'react';
import ReactDOM from 'react-dom/client';
import ScreenshotOverlay from './ScreenshotOverlay';
import { ToastContainer } from '@/components/Toast';
import '@/index.css';
import './overlay.css';

// 调试日志
console.log('[ScreenshotOverlay] index.tsx loaded');

const rootElement = document.getElementById('root');
console.log('[ScreenshotOverlay] root element:', rootElement);

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ScreenshotOverlay />
      <ToastContainer />
    </React.StrictMode>,
  );
  console.log('[ScreenshotOverlay] React app mounted');
} else {
  console.error('[ScreenshotOverlay] root element not found!');
}
