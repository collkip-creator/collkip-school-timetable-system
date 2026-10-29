export type LocalStore = {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
  flush?: () => Promise<void>;
};

const safeParse = <T,>(raw: string | null, fallback: T): T => {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const browserStore: LocalStore = {
  get<T>(key: string, fallback: T) {
    try {
      return safeParse(localStorage.getItem(key), fallback);
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, value: T) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key: string) {
    localStorage.removeItem(key);
  },
};

let activeStore: LocalStore = browserStore;

export const localStore = {
  get<T>(key: string, fallback: T): T {
    return activeStore.get(key, fallback);
  },
  set<T>(key: string, value: T): void {
    activeStore.set(key, value);
  },
  remove(key: string): void {
    activeStore.remove(key);
  },
  async flush(): Promise<void> {
    if (activeStore.flush) await activeStore.flush();
  },
};

export const configureLocalStore = (store: LocalStore) => {
  activeStore = store;
};

export const localStoreKeys = {
  foundation: 'collkip-phase1-foundation-v2',
  schoolProfile: 'collkip-school-profile-v2',
  constraints: 'collkip-scheduling-constraints-v1',
  parallelRules: 'collkip-parallel-lesson-rules-v1',
  timetableCandidate: 'collkip-timetable-candidate-v1',
  timetableValid: 'collkip-timetable-valid-v1',
  legacyFoundation: 'collkip-phase1-state-v1',
  license: 'collkip-license-v1',
  deviceId: 'collkip-device-id-v1',
} as const;
