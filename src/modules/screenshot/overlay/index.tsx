import React from 'react';
import ReactDOM from 'react-dom/client';
import ScreenshotOverlay from './ScreenshotOverlay';
import './overlay.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ScreenshotOverlay />
  </React.StrictMode>
);
