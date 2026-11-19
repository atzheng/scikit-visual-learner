import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';
import { DEFAULT_RUN_CONFIG } from './course';
import { UpdateNotice } from './offline/UpdateNotice';
import { startFileReplay } from './files/filesStore';
import { initPersistence } from './storage/persist';
import { startRuntime, useStore } from './store';

initPersistence();
startFileReplay();
startRuntime();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Own root so the notice does not touch App.tsx.
  const notice = document.createElement('div');
  document.body.appendChild(notice);
  createRoot(notice).render(<UpdateNotice />);
}

// ?debug exposes the store for browser checks (svl-bwv.2); remove with the real diagram pane if unwanted.
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { __machines: useStore, __runConfig: DEFAULT_RUN_CONFIG });
}
