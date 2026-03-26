import type { AppConfig, CachedRuntime, PersistedState } from './types';

const DATABASE_NAME = 'custom-loxone-app';
const STORE_NAME = 'kv';
const MEDIA_STORE_NAME = 'media-cache';
const VERSION = 2;

const DEFAULT_CONFIG: AppConfig = {
  credentials: null,
  languageOverride: null,
  defaultViewId: null,
  lastViewId: null,
  views: [],
};

const DEFAULT_CACHE: CachedRuntime = {
  structure: null,
  stateValues: {},
  intercomHistoryByUuidAction: {},
  intercomPreviewByUuidAction: {},
  updatedAt: null,
};

export function defaultPersistedState(): PersistedState {
  return {
    config: structuredClone(DEFAULT_CONFIG),
    cache: structuredClone(DEFAULT_CACHE),
  };
}

export async function loadPersistedState(): Promise<PersistedState> {
  const db = await openDatabase();
  const [config, cache] = await Promise.all([
    getValue<AppConfig>(db, 'config'),
    getValue<CachedRuntime>(db, 'cache'),
  ]);

  return {
    config: normalizeConfig(config),
    cache: normalizeCache(cache),
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const db = await openDatabase();
  await setValue(db, 'config', config);
}

export async function saveCache(cache: CachedRuntime): Promise<void> {
  const db = await openDatabase();
  await setValue(db, 'cache', cache);
}

export async function loadMediaCacheEntry(key: string): Promise<string | null> {
  const db = await openDatabase();
  return (await getValue<string>(db, key, MEDIA_STORE_NAME)) ?? null;
}

export async function saveMediaCacheEntry(key: string, value: string): Promise<void> {
  const db = await openDatabase();
  await setValue(db, key, value, MEDIA_STORE_NAME);
}

function normalizeConfig(value: AppConfig | undefined): AppConfig {
  if (!value) {
    return structuredClone(DEFAULT_CONFIG);
  }

  return {
    credentials: value.credentials
        ? {
          ...value.credentials,
          serial: value.credentials.serial ?? null,
          resolvedOrigin: value.credentials.resolvedOrigin ?? null,
          token: value.credentials.token ?? null,
          tokenValidUntil: value.credentials.tokenValidUntil ?? null,
          intercomUsername: value.credentials.intercomUsername ?? '',
          intercomPassword: value.credentials.intercomPassword ?? '',
        }
      : null,
    languageOverride:
      value.languageOverride === 'en'
        ? 'en'
        : value.languageOverride === 'de'
          ? 'de'
          : value.languageOverride === 'pl'
            ? 'pl'
            : null,
    defaultViewId: value.defaultViewId ?? null,
    lastViewId: value.lastViewId ?? null,
    views: Array.isArray(value.views)
      ? value.views.map((view) => ({
          ...view,
          intercomUuidAction: view.intercomUuidAction ?? null,
          activityLogControlUuidAction: view.activityLogControlUuidAction ?? null,
          historyLimit: Number.isFinite(view.historyLimit) ? view.historyLimit : 8,
          quickTts: Array.isArray(view.quickTts) ? view.quickTts : [],
        }))
      : [],
  };
}

function normalizeCache(value: CachedRuntime | undefined): CachedRuntime {
  if (!value) {
    return structuredClone(DEFAULT_CACHE);
  }

  return {
    structure: value.structure ?? null,
    stateValues: value.stateValues ?? {},
    intercomHistoryByUuidAction: value.intercomHistoryByUuidAction ?? {},
    intercomPreviewByUuidAction: value.intercomPreviewByUuidAction ?? {},
    updatedAt: value.updatedAt ?? null,
  };
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function getValue<T>(db: IDBDatabase, key: string, storeName = STORE_NAME): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as T | undefined);
  });
}

async function setValue(db: IDBDatabase, key: string, value: unknown, storeName = STORE_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(value, key);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
