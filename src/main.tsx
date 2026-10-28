import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { configureLocalStore } from './localStore';
import { createSqliteStore, isTauriDesktop } from './sqliteStore';
import './index.css';

const mountApp = () => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
};

const start = async () => {
  if (isTauriDesktop()) {
    try {
      configureLocalStore(await createSqliteStore());
    } catch (error) {
      console.error('Could not initialize Collkip desktop SQLite storage.', error);
      const root = document.getElementById('root');
      if (root) root.innerHTML = '<main style="font-family:system-ui;padding:2rem;max-width:42rem;margin:auto"><h1>Collkip could not open its local database</h1><p>Your school data has not been reset. Close and reopen the application. If the problem continues, contact support before reinstalling.</p></main>';
      return;
    }
  }
  mountApp();
};

void start();
