import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { attachConsole } from '@tauri-apps/plugin-log'
import './index.css'
import App from './App.tsx'

attachConsole()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
