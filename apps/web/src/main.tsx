import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root is missing');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Production builds can reopen the public demo shell offline after one successful visit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    console.warn('Offline app cache unavailable; use the local preview server for the demo.');
  });
}
