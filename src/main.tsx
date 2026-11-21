import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

async function boot() {
  if (typeof window !== 'undefined' && window.__RADAR_PREFETCH__?.feed) {
    const feed = await window.__RADAR_PREFETCH__.feed;
    if (feed) {
      window.__RADAR_PREFETCH_RESOLVED__ = { ...(window.__RADAR_PREFETCH_RESOLVED__ ?? {}), feed };
    }
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
