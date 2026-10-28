import Database from '@tauri-apps/plugin-sql';
import type { LocalStore } from './localStore';
import { localStoreKeys } from './localStore';

const DATABASE_URL = 'sqlite:collkip.db';
const MIGRATION_KEYS = [
  localStoreKeys.foundation,
  localStoreKeys.schoolProfile,
  localStoreKeys.constraints,
  localStoreKeys.parallelRules,
  localStoreKeys.timetableCandidate,
  localStoreKeys.timetableValid,
  localStoreKeys.legacyFoundation,
];

type StoredRow = { key: string; value: string };
type PersistenceFailureDetail = { operation: 'save' | 'delete'; key: string; message: string };

export const isTauriDesktop = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

const reportPersistenceFailure = (detail: PersistenceFailureDetail) => {
  console.error('Collkip local database persistence failed.', detail);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<PersistenceFailureDetail>('collkip:persistence-error', { detail }));
  }
};

/**
 * Opens SQLite, imports existing browser workspace keys only where the database
 * has no copy, then hydrates a synchronous cache for the current React API.
 * All durable writes are serialized; flush() lets tests or shutdown workflows
 * wait for the pending write queue to settle.
 */
export async function createSqliteStore(): Promise<LocalStore> {
  const database = await Database.load(DATABASE_URL);
  await database.execute(
    'CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  );

  let rows = await database.select<StoredRow[]>('SELECT key, value FROM app_kv');
  const existingKeys = new Set(rows.map(row => row.key));
  const browserStorage = (() => {
    try { return typeof localStorage === 'undefined' ? null : localStorage; }
    catch { return null; }
  })();

  // First-launch migration: preserve every recognized workspace key, but never
  // overwrite a value already present in SQLite with browser storage.
  if (browserStorage) {
    for (const key of MIGRATION_KEYS) {
      if (existingKeys.has(key)) continue;
      try {
        const raw = browserStorage.getItem(key);
        if (raw === null) continue;
        await database.execute(
          'INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT(key) DO NOTHING',
          [key, raw]
        );
      } catch (error) {
        reportPersistenceFailure({ operation: 'save', key, message: error instanceof Error ? error.message : String(error) });
        throw new Error('Could not migrate existing school data into the local database. No browser data was deleted.');
      }
    }
  }

  rows = await database.select<StoredRow[]>('SELECT key, value FROM app_kv');
  const cache = new Map<string, string>();
  for (const row of rows) cache.set(row.key, row.value);
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<unknown>, key: string, kind: 'save' | 'delete') => {
    writeQueue = writeQueue.then(async () => {
      try {
        await operation();
      } catch (error) {
        reportPersistenceFailure({ operation: kind, key, message: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  const store: LocalStore = {
    get<T>(key: string, fallback: T): T {
      const raw = cache.get(key);
      if (raw === undefined) return fallback;
      try { return JSON.parse(raw) as T; }
      catch { return fallback; }
    },
    set<T>(key: string, value: T): void {
      let raw: string;
      try { raw = JSON.stringify(value); }
      catch (error) {
        reportPersistenceFailure({ operation: 'save', key, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      cache.set(key, raw);
      enqueue(
        () => database.execute(
          'INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
          [key, raw]
        ),
        key,
        'save'
      );
    },
    remove(key: string): void {
      cache.delete(key);
      enqueue(() => database.execute('DELETE FROM app_kv WHERE key = $1', [key]), key, 'delete');
    },
    async flush(): Promise<void> {
      await writeQueue;
    },
  };

  return store;
}
