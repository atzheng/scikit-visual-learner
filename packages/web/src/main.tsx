import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WEB_PACKAGES } from './index';

function App() {
  return (
    <main>
      <h1>Machine Diagrams</h1>
      <p>Placeholder. Packages: {WEB_PACKAGES.join(', ')}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
