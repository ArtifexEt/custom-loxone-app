/// <reference lib="webworker" />

import {
  LoxoneClient,
  buildIntercomViewModel,
  buildTtsCommand,
  createDefaultView,
  listIntercoms,
  listLogSources,
  mergeControlSecuredDetails,
  selectIntercomControl,
} from './loxone';
import { defaultPersistedState, loadPersistedState, saveCache, saveConfig } from './storage';
import { setRuntimeLanguage, t } from './translations';
import type {
  AppConfig,
  AppLanguage,
  AppNotice,
  AppViewModel,
  CachedRuntime,
  IntercomViewConfig,
  MainToWorkerMessage,
  SaveServerPayload,
  StoredCredentials,
  WorkerToMainMessage,
} from './types';

declare const self: DedicatedWorkerGlobalScope;

let config: AppConfig = defaultPersistedState().config;
let cache: CachedRuntime = defaultPersistedState().cache;
let client: LoxoneClient | null = null;
let bootstrapped = false;
let settingsOpen = false;
let settingsMode: AppViewModel['settingsMode'] = null;
let settingsEditorViewId: string | null = null;
let draftView: IntercomViewConfig | null = null;
let notice: AppNotice | null = null;
let noticeTimer: number | null = null;
let connection: AppViewModel['connection'] = {
  status: 'idle',
};
let persistCacheTimer: number | null = null;
let browserLanguage: string | null = null;

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  void handleMessage(event.data);
};

async function handleMessage(message: MainToWorkerMessage): Promise<void> {
  try {
    switch (message.type) {
      case 'bootstrap':
        browserLanguage = message.browserLanguage ?? null;
        await bootstrap();
        return;
      case 'showAppSettings':
        settingsOpen = true;
        settingsMode = 'app';
        settingsEditorViewId = settingsEditorViewId ?? activeViewId();
        emitState();
        return;
      case 'showViewSettings':
        settingsOpen = true;
        settingsMode = 'view';
        settingsEditorViewId = message.viewId ?? activeViewId();
        emitState();
        return;
      case 'closeSettings':
        settingsOpen = false;
        settingsMode = null;
        draftView = null;
        settingsEditorViewId = activeViewId();
        emitState();
        return;
      case 'saveAppSettings':
        config.languageOverride = message.payload.languageOverride;
        await persistConfig();
        emitState();
        return;
      case 'saveServer':
        await saveServerConfiguration(message.payload);
        return;
      case 'selectView':
        config.lastViewId = message.viewId;
        await persistConfig();
        emitState();
        return;
      case 'addIntercomView':
        await addIntercomView();
        return;
      case 'configureIntercomView':
        configureIntercomView();
        return;
      case 'editView':
        draftView = null;
        settingsEditorViewId = message.viewId;
        settingsOpen = true;
        settingsMode = 'view';
        emitState();
        return;
      case 'saveView':
        await upsertView(message.payload);
        return;
      case 'deleteView':
        await deleteView(message.viewId);
        return;
      case 'setDefaultView':
        config.defaultViewId = message.viewId;
        config.lastViewId = message.viewId;
        await persistConfig();
        emitState();
        return;
      case 'sendChildFunction':
        await runChildFunction(message.viewId, message.functionUuidAction);
        return;
      case 'sendTts':
        await runTts(message.viewId, message.message);
        return;
      case 'runBuiltInAction':
        await runBuiltInAction(message.viewId, message.action);
        return;
      case 'cacheIntercomPreview':
        cacheIntercomPreview(message.uuidAction, message.url);
        return;
      case 'dismissNotice':
        clearNotice();
        return;
      default:
        return;
    }
  } catch (error) {
    setErrorNotice(toErrorMessage(error));
  }
}

async function bootstrap(): Promise<void> {
  if (bootstrapped) {
    emitState();
    return;
  }

  const persisted = await loadPersistedState();
  config = persisted.config;
  cache = persisted.cache;
  ensureConfigConsistency();
  bootstrapped = true;
  setRuntimeLanguage(resolveLanguage());
  setInfoNotice(t(resolveLanguage(), 'startup_ready'));
  emitState();

  if (config.credentials) {
    await connect();
  }
}

async function saveServerConfiguration(payload: SaveServerPayload): Promise<void> {
  const credentials = mergeCredentials(payload, config.credentials);
  config.credentials = credentials;
  setInfoNotice(t(resolveLanguage(), 'server_saved'));
  await persistConfig();
  emitState();
  await connect(true);
}

async function addIntercomView(): Promise<void> {
  if (!cache.structure) {
    setErrorNotice(t(resolveLanguage(), 'wait_for_loxone'));
    return;
  }
  const firstIntercom = listIntercoms(cache.structure)[0];
  if (!firstIntercom) {
    setErrorNotice(t(resolveLanguage(), 'no_intercom_in_structure'));
    return;
  }

  const view = createDefaultView(firstIntercom.uuidAction, null);
  config.views = [...config.views, view];
  config.lastViewId = view.id;
  config.defaultViewId = config.defaultViewId ?? view.id;
  settingsEditorViewId = view.id;
  settingsOpen = false;
  settingsMode = null;
  draftView = null;
  await persistConfig();
  emitState();
}

function configureIntercomView(): void {
  if (!cache.structure) {
    setErrorNotice(t(resolveLanguage(), 'wait_for_loxone'));
    return;
  }
  const firstIntercom = listIntercoms(cache.structure)[0];
  draftView = createDefaultView(firstIntercom?.uuidAction ?? null, null);
  settingsEditorViewId = draftView.id;
  settingsOpen = true;
  settingsMode = 'view';
  emitState();
}

async function upsertView(view: IntercomViewConfig): Promise<void> {
  const normalized: IntercomViewConfig = {
    ...view,
    intercomUuidAction: view.intercomUuidAction ?? null,
    activityLogControlUuidAction: view.activityLogControlUuidAction ?? null,
    historyLimit: clampHistory(view.historyLimit),
    quickTts: view.quickTts.filter((item) => item.label.trim() || item.message.trim()),
  };
  const existingIndex = config.views.findIndex((item) => item.id === normalized.id);
  if (existingIndex === -1) {
    config.views = [...config.views, normalized];
  } else {
    config.views = config.views.map((item) => (item.id === normalized.id ? normalized : item));
  }
  draftView = null;
  settingsOpen = false;
  settingsMode = null;
  settingsEditorViewId = normalized.id;
  config.lastViewId = normalized.id;
  config.defaultViewId = config.defaultViewId ?? normalized.id;
  await persistConfig();
  emitState();
}

async function deleteView(viewId: string): Promise<void> {
  config.views = config.views.filter((item) => item.id !== viewId);
  if (config.defaultViewId === viewId) {
    config.defaultViewId = config.views[0]?.id ?? null;
  }
  if (config.lastViewId === viewId) {
    config.lastViewId = config.defaultViewId ?? config.views[0]?.id ?? null;
  }
  if (settingsEditorViewId === viewId) {
    settingsEditorViewId = config.views[0]?.id ?? null;
  }
  settingsOpen = settingsOpen && config.views.length > 0;
  await persistConfig();
  emitState();
}

async function runChildFunction(viewId: string, functionUuidAction: string): Promise<void> {
  if (!client) {
    setErrorNotice(t(resolveLanguage(), 'no_intercom_action_connection'));
    return;
  }
  const view = config.views.find((item) => item.id === viewId);
  if (!view || !cache.structure) {
    setErrorNotice(t(resolveLanguage(), 'no_intercom_view_definition'));
    return;
  }

  try {
    await client.sendAction(functionUuidAction, 'pulse');
    setSuccessNotice(t(resolveLanguage(), 'intercom_action_started'));
  } catch (error) {
    setErrorNotice(toErrorMessage(error));
  }
}

async function runTts(viewId: string, message: string): Promise<void> {
  if (!client) {
    setErrorNotice(t(resolveLanguage(), 'no_tts_connection'));
    return;
  }
  const view = config.views.find((item) => item.id === viewId);
  if (!view || !cache.structure) {
    setErrorNotice(t(resolveLanguage(), 'no_tts_view'));
    return;
  }
  const control = selectIntercomControl(view, cache.structure);
  const command = buildTtsCommand(message);
  if (!control || !command) {
    setErrorNotice(t(resolveLanguage(), 'tts_empty'));
    return;
  }
  try {
    await client.sendAction(control.uuidAction, command);
    setSuccessNotice(t(resolveLanguage(), 'tts_sent'));
  } catch (error) {
    setErrorNotice(toErrorMessage(error));
  }
}

async function runBuiltInAction(
  viewId: string,
  action: 'connect' | 'answer' | 'mute' | 'unmute',
): Promise<void> {
  if (!client) {
    setErrorNotice(t(resolveLanguage(), 'no_intercom_connection'));
    return;
  }
  const view = config.views.find((item) => item.id === viewId);
  if (!view || !cache.structure) {
    setErrorNotice(t(resolveLanguage(), 'no_active_intercom'));
    return;
  }
  const control = selectIntercomControl(view, cache.structure);
  if (!control) {
    setErrorNotice(t(resolveLanguage(), 'configured_intercom_missing'));
    return;
  }

  const command =
    action === 'connect' || action === 'answer'
      ? 'answer'
      : action === 'mute'
        ? 'mute/1'
        : 'mute/0';
  try {
    await client.sendAction(control.uuidAction, command);
    setSuccessNotice(
      action === 'connect' || action === 'answer'
        ? t(resolveLanguage(), 'intercom_connection_started')
        : action === 'mute'
          ? t(resolveLanguage(), 'intercom_muted')
          : t(resolveLanguage(), 'intercom_unmuted'),
    );
  } catch (error) {
    setErrorNotice(toErrorMessage(error));
  }
}

async function connect(forceReload = false): Promise<void> {
  if (!config.credentials) {
    connection = { status: 'idle' };
    emitState();
    return;
  }

  if (!client) {
    client = new LoxoneClient(config.credentials, {
      onConnecting: () => {
        connection = { status: 'connecting' };
        emitState();
      },
      onReady: (payload) => {
        client?.updateConnectionHints({ serial: payload.structure.serial });
        cache = {
          structure: payload.structure,
          stateValues: payload.stateValues,
          intercomHistoryByUuidAction: cache.intercomHistoryByUuidAction,
          intercomPreviewByUuidAction: cache.intercomPreviewByUuidAction,
          updatedAt: new Date().toISOString(),
        };
        captureIntercomBellHistory({}, payload.stateValues, payload.structure);
        config.credentials = {
          ...config.credentials!,
          token: payload.token,
          tokenValidUntil: payload.tokenValidUntil,
        };
        ensureConfigConsistency();
        void persistConfig();
        scheduleCachePersist();
        connection = { status: 'online' };
        emitState();
      },
      onStatesChanged: (changed) => {
        const nextStateValues = {
          ...cache.stateValues,
          ...changed,
        };
        captureIntercomBellHistory(cache.stateValues, nextStateValues, cache.structure);
        cache = {
          ...cache,
          stateValues: nextStateValues,
          updatedAt: new Date().toISOString(),
        };
        scheduleCachePersist();
        emitState();
      },
      onAvailabilityChanged: (online, message) => {
        connection = {
          status: online ? 'online' : 'offline',
        };
        if (!online) {
          setErrorNotice(message);
        }
        emitState();
      },
      onError: (message) => {
        connection = {
          status: 'error',
        };
        setErrorNotice(message);
      },
    }, { serial: cache.structure?.serial ?? null });
  } else {
    client.updateCredentials(config.credentials);
    client.updateConnectionHints({ serial: cache.structure?.serial ?? null });
  }

  try {
    await client.connect(forceReload);
    await hydrateIntercomSecuredDetails();
    emitState();
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : null;
    connection = {
      status: 'error',
    };
    setErrorNotice(message ?? t(resolveLanguage(), 'connection_failed'));
    emitState();
  }
}

async function hydrateIntercomSecuredDetails(): Promise<void> {
  if (!client || !cache.structure) {
    return;
  }
  let nextStructure = cache.structure;
  let changed = false;

  for (const intercom of listIntercoms(cache.structure)) {
    try {
      const securedDetails = await client.fetchSecuredDetails(intercom.uuidAction);
      if (Object.keys(securedDetails).length === 0) {
        continue;
      }
      nextStructure = mergeControlSecuredDetails(nextStructure, intercom.uuidAction, securedDetails);
      changed = true;
    } catch {
      // Some installations may not expose secured details for every control.
    }
  }

  if (!changed) {
    return;
  }

  cache = {
    ...cache,
    structure: nextStructure,
    updatedAt: new Date().toISOString(),
  };
  scheduleCachePersist();
}

function emitState(): void {
  const message: WorkerToMainMessage = {
    type: 'state',
    state: buildViewState(),
  };
  self.postMessage(message);
}

function buildViewState(): AppViewModel {
  const structure = cache.structure;
  const intercoms = structure ? listIntercoms(structure) : [];
  const logSources = structure ? listLogSources(structure) : [];
  const views = config.views;
  const activeId = activeViewId();
  const activeView = views.find((item) => item.id === activeId) ?? null;
  const currentEditorView =
    draftView && draftView.id === settingsEditorViewId
      ? draftView
      : views.find((item) => item.id === settingsEditorViewId) ?? null;

  return {
    screen: resolveScreen(),
    settingsOpen,
    settingsMode,
    language: resolveLanguage(),
    languageOverride: config.languageOverride,
    connection,
    notice,
    serverForm: {
      origin: config.credentials?.origin ?? '',
      username: config.credentials?.username ?? '',
      passwordStored: Boolean(config.credentials?.password),
    },
    miniserverName: structure?.miniserverName ?? null,
    lastSyncedAt: cache.updatedAt,
    views,
    intercoms,
    logSources,
    activeViewId: activeId,
    settingsEditorViewId,
    currentEditorView,
    currentView:
      activeView !== null
        ? {
            config: activeView,
            intercom: buildIntercomViewModel(
              activeView,
              structure,
              cache.stateValues,
              config.credentials,
              cache.intercomHistoryByUuidAction,
              cache.intercomPreviewByUuidAction,
            ),
          }
        : null,
  };
}

function cacheIntercomPreview(uuidAction: string, url: string | null): void {
  const normalized = url?.trim() ?? '';
  if (!uuidAction || !normalized) {
    return;
  }
  if (cache.intercomPreviewByUuidAction[uuidAction] === normalized) {
    return;
  }
  cache = {
    ...cache,
    intercomPreviewByUuidAction: {
      ...cache.intercomPreviewByUuidAction,
      [uuidAction]: normalized,
    },
  };
  scheduleCachePersist();
  emitState();
}

function captureIntercomBellHistory(
  previousStateValues: Record<string, unknown>,
  nextStateValues: Record<string, unknown>,
  structure: CachedRuntime['structure'],
): void {
  if (!structure) {
    return;
  }
  let changed = false;
  for (const summary of listIntercoms(structure)) {
    const control = structure.controlsByAction[summary.uuidAction];
    if (!control) {
      continue;
    }
    const bellStateUuid = resolveMatchingStateUuid(control.states, ['bell', 'ring', 'doorbell']);
    if (!bellStateUuid) {
      continue;
    }
    const previous = toBoolean(previousStateValues[bellStateUuid]);
    const next = toBoolean(nextStateValues[bellStateUuid]);
    if (previous || !next) {
      continue;
    }
    const timestamp = new Date().toISOString();
    const existing = cache.intercomHistoryByUuidAction[control.uuidAction] ?? [];
    cache.intercomHistoryByUuidAction = {
      ...cache.intercomHistoryByUuidAction,
      [control.uuidAction]: [timestamp, ...existing].slice(0, 40),
    };
    changed = true;
  }
  if (changed) {
    scheduleCachePersist();
  }
}

function resolveMatchingStateUuid(states: Record<string, string>, candidates: string[]): string | null {
  for (const [stateName, stateUuid] of Object.entries(states)) {
    const normalized = stateName.trim().toLowerCase();
    if (candidates.some((candidate) => normalized.includes(candidate))) {
      return stateUuid;
    }
  }
  return null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'on';
  }
  return false;
}

function resolveLanguage(): AppLanguage {
  if (config.languageOverride) {
    return config.languageOverride;
  }
  const normalized = browserLanguage?.toLowerCase() ?? '';
  if (normalized.startsWith('en')) {
    return 'en';
  }
  if (normalized.startsWith('de')) {
    return 'de';
  }
  return 'pl';
}

function resolveScreen(): AppViewModel['screen'] {
  if (!bootstrapped) {
    return 'loading';
  }
  if (!config.credentials) {
    return 'loading';
  }
  if (!cache.structure) {
    return 'loading';
  }
  if (config.views.length === 0) {
    return 'picker';
  }
  return 'dashboard';
}

function activeViewId(): string | null {
  const availableIds = new Set(config.views.map((item) => item.id));
  if (config.lastViewId && availableIds.has(config.lastViewId)) {
    return config.lastViewId;
  }
  if (config.defaultViewId && availableIds.has(config.defaultViewId)) {
    return config.defaultViewId;
  }
  return config.views[0]?.id ?? null;
}

function ensureConfigConsistency(): void {
  const viewIds = new Set(config.views.map((item) => item.id));
  if (config.defaultViewId && !viewIds.has(config.defaultViewId)) {
    config.defaultViewId = config.views[0]?.id ?? null;
  }
  if (config.lastViewId && !viewIds.has(config.lastViewId)) {
    config.lastViewId = config.defaultViewId ?? config.views[0]?.id ?? null;
  }
  if (settingsEditorViewId && !viewIds.has(settingsEditorViewId) && draftView?.id !== settingsEditorViewId) {
    settingsEditorViewId = config.views[0]?.id ?? null;
  }
}

function mergeCredentials(
  payload: SaveServerPayload,
  existing: StoredCredentials | null,
): StoredCredentials {
  const origin = normalizeOrigin(payload.origin);
  const username = payload.username.trim();
  const password = payload.password || existing?.password || '';

  if (!origin) {
    throw new Error(t(resolveLanguage(), 'enter_server_address'));
  }
  if (!username) {
    throw new Error(t(resolveLanguage(), 'enter_login'));
  }
  if (!password) {
    throw new Error(t(resolveLanguage(), 'enter_password'));
  }

  const base: StoredCredentials = {
    origin,
    username,
    password,
    intercomUsername: existing?.intercomUsername ?? '',
    intercomPassword: existing?.intercomPassword ?? '',
    token: existing?.token ?? null,
    tokenValidUntil: existing?.tokenValidUntil ?? null,
  };

  if (
    existing &&
    (existing.origin !== base.origin ||
      existing.username !== base.username ||
      existing.password !== base.password)
  ) {
    base.token = null;
    base.tokenValidUntil = null;
  }

  return base;
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${shouldUseHttpByDefault(trimmed) ? 'http' : 'https'}://${trimmed}`;
  const url = new URL(withScheme);
  url.search = '';
  url.hash = '';
  const normalizedPath = url.pathname.replace(/\/{2,}/g, '/');
  url.pathname = normalizedPath.endsWith('/') ? normalizedPath : `${normalizedPath}/`;
  return url.toString().replace(/\/$/, normalizedPath === '/' ? '' : '/');
}

function shouldUseHttpByDefault(value: string): boolean {
  const candidate = value.trim().toLowerCase();
  if (candidate === 'localhost' || candidate.endsWith('.local')) {
    return true;
  }
  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function clampHistory(value: number): number {
  if (!Number.isFinite(value)) {
    return 8;
  }
  return Math.max(3, Math.min(20, Math.round(value)));
}

function scheduleCachePersist(): void {
  if (persistCacheTimer !== null) {
    clearTimeout(persistCacheTimer);
  }
  persistCacheTimer = self.setTimeout(() => {
    persistCacheTimer = null;
    void saveCache(cache);
  }, 300);
}

async function persistConfig(): Promise<void> {
  await saveConfig(config);
}

function setSuccessNotice(message: string): void {
  setNotice('success', message, 3200);
}

function setErrorNotice(message: string): void {
  setNotice('error', message, 5200);
}

function setInfoNotice(message: string): void {
  setNotice('info', message, 2600);
}

function setNotice(kind: AppNotice['kind'], message: string, timeoutMs: number): void {
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  notice = {
    kind,
    message,
  };
  emitState();
  noticeTimer = self.setTimeout(() => {
    clearNotice();
  }, timeoutMs);
}

function clearNotice(): void {
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  if (notice === null) {
    return;
  }
  notice = null;
  emitState();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return t(resolveLanguage(), 'app_unknown_error');
}
