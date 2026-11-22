import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { readPrefetched } from './lib/api';
import './styles.css';

async function boot() {
  const feed = await readPrefetched('feed');
  if (feed) {
    window.__RADAR_PREFETCH_RESOLVED__ = { ...window.__RADAR_PREFETCH_RESOLVED__, feed };
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
