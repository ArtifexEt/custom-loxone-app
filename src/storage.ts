import type { AppConfig, CachedRuntime, PersistedState } from './types';

const DATABASE_NAME = 'custom-loxone-app';
const STORE_NAME = 'kv';
const MEDIA_STORE_NAME = 'media-cache';
const VERSION = 2;
let database: Promise<IDBDatabase> | null = null;

function defaultConfig(): AppConfig {
  return {
    credentials: null,
    languageOverride: null,
    panelMode: false,
    keepScreenAwake: false,
    defaultViewId: null,
    lastViewId: null,
    views: [],
  };
}

function defaultCache(): CachedRuntime {
  return {
    structure: null,
    stateValues: {},
    intercomHistoryByUuidAction: {},
    intercomPreviewByUuidAction: {},
    updatedAt: null,
  };
}

export function defaultPersistedState(): PersistedState {
  return {
    config: defaultConfig(),
    cache: defaultCache(),
  };
}

export async function loadPersistedState(): Promise<PersistedState> {
  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const [config, cache] = await Promise.all([
    getValue<AppConfig>(tx, STORE_NAME, 'config'),
    getValue<CachedRuntime>(tx, STORE_NAME, 'cache'),
  ]);

  return {
    config: normalizeConfig(config),
    cache: normalizeCache(cache),
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const snapshot = snapshotConfig(config);
  const db = await openDatabase();
  await setValue(db, 'config', snapshot);
}

export async function saveCache(cache: CachedRuntime): Promise<void> {
  const db = await openDatabase();
  await setValue(db, 'cache', cache);
}

export async function saveServerState(config: AppConfig, cache: CachedRuntime): Promise<void> {
  const snapshot = snapshotConfig(config);
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    const store = tx.objectStore(STORE_NAME);
    store.put(snapshot, 'config');
    store.put(cache, 'cache');
  });
}

export async function loadMediaCacheEntry(key: string): Promise<string | null> {
  const db = await openDatabase();
  const tx = db.transaction(MEDIA_STORE_NAME, 'readonly');
  return (await getValue<string>(tx, MEDIA_STORE_NAME, key)) ?? null;
}

export async function saveMediaCacheEntry(key: string, value: string): Promise<void> {
  const db = await openDatabase();
  await setValue(db, key, value, MEDIA_STORE_NAME);
}

function normalizeConfig(value: AppConfig | undefined): AppConfig {
  if (!value) {
    return defaultConfig();
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
    panelMode: value.panelMode === true,
    keepScreenAwake: value.keepScreenAwake === true,
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
    return defaultCache();
  }

  return {
    structure: value.structure ?? null,
    stateValues: value.stateValues ?? {},
    intercomHistoryByUuidAction: value.intercomHistoryByUuidAction ?? {},
    intercomPreviewByUuidAction: value.intercomPreviewByUuidAction ?? {},
    updatedAt: value.updatedAt ?? null,
  };
}

function snapshotConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    credentials: config.credentials ? { ...config.credentials } : null,
    views: config.views.map((view) => ({
      ...view,
      quickTts: view.quickTts.map((phrase) => ({ ...phrase })),
    })),
  };
}

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      request.onsuccess = () => request.result.close();
      reject(new Error('IndexedDB is blocked'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = null;
      };
      resolve(db);
    };
  }).catch((error) => {
    database = null;
    throw error;
  });
  return database;
}

async function getValue<T>(tx: IDBTransaction, storeName: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
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
    tx.onabort = () => reject(tx.error);
  });
}
