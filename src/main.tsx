import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { readPrefetched } from './lib/api';
import './styles.css';

async function boot() {
  await readPrefetched('feed');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
