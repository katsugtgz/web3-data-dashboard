import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { takePrefetched } from './lib/api';
import './styles.css';

async function boot() {
  const feed = await takePrefetched('feed');
  if (feed) {
    window.__RADAR_PREFETCH_RESOLVED__ = { ...window.__RADAR_PREFETCH_RESOLVED__, feed };
    // The initial poll consumes the same snapshot instead of fetching it again.
    window.__RADAR_PREFETCH__!.feed = Promise.resolve(feed);
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
