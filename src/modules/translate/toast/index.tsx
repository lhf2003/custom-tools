import React from 'react';
import ReactDOM from 'react-dom/client';
import TranslateToast from './TranslateToast';
import '@/index.css';

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <TranslateToast />
    </React.StrictMode>,
  );
}
