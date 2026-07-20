import React from 'react';
import ReactDOM from 'react-dom/client';
import CompanionToast from './CompanionToast';
import '@/index.css';

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <CompanionToast />
    </React.StrictMode>,
  );
}
