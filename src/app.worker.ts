/// <reference lib="webworker" />

import { IntercomSignaling } from './intercom-signaling';
import { isLocalHost, parseConnectionAddress, parseMiniserverSerial, remoteConnectSerial, remoteConnectUrl } from './connection-address';
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
import {
  defaultPersistedState,
  loadMediaCacheEntry,
  loadPersistedState,
  saveCache,
  saveConfig,
  saveMediaCacheEntry,
  saveServerState,
} from './storage';
import { setRuntimeLanguage, t } from './translations';
import type {
  AppLanguage,
  AppNotice,
  AppViewModel,
  CachedRuntime,
  IntercomViewConfig,
  LoxoneStructure,
  MainToWorkerMessage,
  SaveServerPayload,
  StoredCredentials,
  WorkerToMainMessage,
} from './types';

declare const self: DedicatedWorkerGlobalScope;
const intercomSignaling = new IntercomSignaling(message => self.postMessage(message));

let { config, cache } = defaultPersistedState();
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
let persistCacheAt = 0;
let emitStateTimer: number | null = null;
let browserLanguage: string | null = null;
let lastEmittedStateSignature: string | null = null;
const bellSubscriptions = new WeakMap<LoxoneStructure, Map<string, string>>();
let securedDetailsRequested = new Set<string>();

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  void handleMessage(event.data);
};

async function handleMessage(message: MainToWorkerMessage): Promise<void> {
  try {
    switch (message.type) {
      case 'intercomSignal': {
        const intercom = message.operation === 'open'
          ? buildViewState().currentView?.intercom ?? null
          : null;
        const localReach = intercom?.transportMode === 'lan-direct' ||
          Boolean(intercom?.origin && isLocalHost(new URL(intercom.origin).hostname));
        await intercomSignaling.handle(message, intercom, config.credentials?.username ?? '', localReach);
        return;
      }
      case 'bootstrap':
        browserLanguage = message.browserLanguage ?? null;
        await bootstrap();
        return;
      case 'resume':
        client?.resume();
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
      case 'saveAppSettings': {
        const { languageOverride, panelMode, keepScreenAwake } = message.payload;
        config = {
          ...config,
          languageOverride: languageOverride === undefined ? config.languageOverride : languageOverride,
          panelMode: panelMode ?? config.panelMode,
          keepScreenAwake: keepScreenAwake ?? config.keepScreenAwake,
        };
        setRuntimeLanguage(resolveLanguage());
        await persistConfig();
        emitState();
        return;
      }
      case 'saveServer':
        await saveServerConfiguration(message.payload);
        return;
      case 'selectView':
        config.lastViewId = message.viewId;
        emitState();
        await persistConfig();
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
      case 'loadHistoryImageCache': {
        const entries = await Promise.all(
          message.keys.slice(0, 32).map(async (key): Promise<[string, string] | null> => {
            const value = key.length <= 4096 ? await loadMediaCacheEntry(key).catch(() => null) : null;
            return value ? [key, value] : null;
          }),
        );
        const response: WorkerToMainMessage = {
          type: 'historyImageCache',
          requestId: message.requestId,
          entries: entries.filter((entry) => entry !== null),
        };
        self.postMessage(response);
        return;
      }
      case 'saveHistoryImageCache':
        if (message.key.length <= 4096 &&
            message.dataUrl.startsWith('data:image/jpeg;base64,') &&
            message.dataUrl.length <= 4 * 1024 * 1024) {
          await saveMediaCacheEntry(message.key, message.dataUrl).catch(() => undefined);
        }
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

  const persisted = await loadPersistedState().catch(() => null);
  bootstrapped = true;
  if (!persisted) {
    setRuntimeLanguage(resolveLanguage());
    setErrorNotice(t(resolveLanguage(), 'storage_unavailable'));
    return;
  }
  config = persisted.config;
  cache = persisted.cache;
  ensureConfigConsistency();
  setRuntimeLanguage(resolveLanguage());
  emitState();

  if (config.credentials) {
    await connect();
  }
}

async function saveServerConfiguration(payload: SaveServerPayload): Promise<void> {
  const previous = config.credentials;
  const credentials = mergeCredentials(payload, previous);
  const accessChanged = previous?.origin !== credentials.origin ||
    previous?.serial !== credentials.serial ||
    previous?.username !== credentials.username;
  client?.close();
  client = null;
  if (accessChanged) {
    clearTimeout(persistCacheTimer ?? undefined);
    persistCacheTimer = null;
    cache = defaultPersistedState().cache;
    draftView = null;
  }
  config.credentials = credentials;
  connection = { status: 'connecting' };
  emitState();
  try {
    await saveServerState(config, cache);
  } catch {
    if (config.credentials !== credentials) {
      return;
    }
    setErrorNotice(t(resolveLanguage(), 'storage_unavailable'));
    await connect();
    return;
  }
  if (config.credentials !== credentials) {
    return;
  }
  await connect();
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
  void hydrateIntercomSecuredDetails();
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
  if (!client || connection.status !== 'online') {
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
  if (message.trim().length > 300) {
    setErrorNotice(t(resolveLanguage(), 'tts_too_long'));
    return;
  }
  if (!client || connection.status !== 'online') {
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
  action: 'answer' | 'mute' | 'unmute',
): Promise<void> {
  if (!client || connection.status !== 'online') {
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
    action === 'answer'
      ? 'answer'
      : action === 'mute'
        ? 'mute/1'
        : 'mute/0';
  try {
    await client.sendAction(control.uuidAction, command);
    if (action === 'mute') {
      setSuccessNotice(t(resolveLanguage(), 'intercom_muted'));
    } else if (action === 'unmute') {
      setSuccessNotice(t(resolveLanguage(), 'intercom_unmuted'));
    }
  } catch (error) {
    setErrorNotice(toErrorMessage(error));
  }
}

async function connect(): Promise<void> {
  const credentials = config.credentials;
  if (!credentials) {
    connection = { status: 'idle' };
    emitState();
    return;
  }

  const serial = credentials.serial ?? cache.structure?.serial ?? null;
  if (self.location.protocol === 'https:' && new URL(credentials.origin).protocol === 'http:' &&
      !serial && parseConnectionAddress(credentials.resolvedOrigin ?? '')?.protocol !== 'https:') {
    connection = { status: 'error' };
    setErrorNotice(t(resolveLanguage(), 'https_connection_address_required'));
    return;
  }

  let sourceStructure: LoxoneStructure | null = null;
  const nextClient = new LoxoneClient(
    credentials,
    {
      onConnecting: () => {
        connection = { status: 'connecting' };
        emitState();
      },
      onReady: (payload) => {
        nextClient.updateConnectionHints({ serial: payload.structure.serial || credentials.serial });
        // The client reuses its parsed structure across a network interruption.
        // Keep any secured details already fetched for that same structure.
        if (sourceStructure !== payload.structure) {
          securedDetailsRequested = new Set();
        }
        const structure = sourceStructure === payload.structure ? cache.structure ?? payload.structure : payload.structure;
        sourceStructure = payload.structure;
        const previousStateValues = cache.stateValues;
        cache = {
          structure,
          stateValues: payload.stateValues,
          intercomHistoryByUuidAction: cache.intercomHistoryByUuidAction,
          intercomPreviewByUuidAction: cache.intercomPreviewByUuidAction,
          updatedAt: new Date().toISOString(),
        };
        const bellRang = captureIntercomBellHistory(previousStateValues, payload.stateValues, structure);
        config.credentials = {
          ...credentials,
          serial: credentials.serial ?? parseMiniserverSerial(payload.structure.serial),
          token: payload.token,
          tokenValidUntil: payload.tokenValidUntil,
          resolvedOrigin: payload.resolvedOrigin,
        };
        ensureConfigConsistency();
        void persistConfig().catch(() => setErrorNotice(t(resolveLanguage(), 'storage_unavailable')));
        scheduleCachePersist();
        connection = { status: 'online' };
        if (bellRang) {
          setInfoNotice(t(resolveLanguage(), 'intercom_ring_prompt'));
        } else {
          emitState();
        }
        void hydrateIntercomSecuredDetails();
      },
      onStatesChanged: (changed) => {
        const bellRang = captureIntercomBellHistory(cache.stateValues, changed, cache.structure);
        Object.assign(cache.stateValues, changed);
        if (bellRang) {
          scheduleCachePersist();
          setInfoNotice(t(resolveLanguage(), 'intercom_ring_prompt'));
        } else {
          scheduleCachePersist(10_000);
          scheduleStateEmit();
        }
      },
      onAvailabilityChanged: (online, message) => {
        if (online && connection.status === 'online') {
          return;
        }
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
    },
    { serial },
  );

  client = nextClient;
  await nextClient.connect();
}

async function hydrateIntercomSecuredDetails(): Promise<void> {
  const connectedClient = client;
  const structure = cache.structure;
  if (!connectedClient || !structure || connection.status !== 'online') {
    return;
  }

  const requested = securedDetailsRequested;
  let changed = false;
  for (const { uuidAction } of listHydrationIntercoms(structure)) {
    if (requested.has(uuidAction)) continue;
    requested.add(uuidAction);
    try {
      const securedDetails = await connectedClient.fetchSecuredDetails(uuidAction);
      if (client !== connectedClient || requested !== securedDetailsRequested || !cache.structure) {
        return;
      }
      if (Object.keys(securedDetails).length === 0) {
        continue;
      }
      cache = {
        ...cache,
        structure: mergeControlSecuredDetails(cache.structure, uuidAction, securedDetails),
      };
      changed = true;
    } catch {
      // Some installations may not expose secured details for every control.
      if (client !== connectedClient || connection.status !== 'online') {
        requested.delete(uuidAction);
        break;
      }
    }
  }
  if (changed) {
    scheduleCachePersist();
    emitState();
  }
}

function listHydrationIntercoms(structure: NonNullable<CachedRuntime['structure']>) {
  const configuredIds = new Set<string>();

  for (const view of config.views) {
    if (view.type === 'intercom' && view.intercomUuidAction) {
      configuredIds.add(view.intercomUuidAction);
    }
  }

  if (draftView?.intercomUuidAction) {
    configuredIds.add(draftView.intercomUuidAction);
  }

  const currentEditorView =
    draftView && draftView.id === settingsEditorViewId
      ? draftView
      : config.views.find((item) => item.id === settingsEditorViewId) ?? null;

  if (currentEditorView?.intercomUuidAction) {
    configuredIds.add(currentEditorView.intercomUuidAction);
  }

  if (configuredIds.size === 0) {
    return [];
  }

  return listIntercoms(structure).filter((intercom) => configuredIds.has(intercom.uuidAction));
}

function emitState(): void {
  if (emitStateTimer !== null) {
    clearTimeout(emitStateTimer);
    emitStateTimer = null;
  }
  const state = buildViewState();
  intercomSignaling.keepFor(state.currentView?.intercom ?? null, state.serverForm.username);
  const signature = JSON.stringify(state);
  if (signature === lastEmittedStateSignature) {
    return;
  }
  lastEmittedStateSignature = signature;
  const message: WorkerToMainMessage = {
    type: 'state',
    state,
  };
  self.postMessage(message);
}

function scheduleStateEmit(): void {
  if (emitStateTimer === null) {
    // Group packets received during the same display frame. A bell bypasses this queue.
    emitStateTimer = self.setTimeout(emitState, 32);
  }
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
    panelMode: config.panelMode,
    keepScreenAwake: config.keepScreenAwake,
    connection,
    notice,
    serverForm: {
      origin: config.credentials?.origin ?? '',
      serial: config.credentials?.serial ?? null,
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
): boolean {
  if (!structure) {
    return false;
  }
  let subscriptions = bellSubscriptions.get(structure);
  if (!subscriptions) {
    subscriptions = new Map<string, string>();
    for (const { uuidAction } of listIntercoms(structure)) {
      const control = structure.controlsByAction[uuidAction];
      const bellState = control && resolveMatchingStateUuid(control.states, ['bell', 'ring', 'doorbell']);
      if (bellState) subscriptions.set(uuidAction, bellState);
    }
    bellSubscriptions.set(structure, subscriptions);
  }
  let changed = false;
  for (const [uuidAction, bellStateUuid] of subscriptions) {
    const previous = toBoolean(previousStateValues[bellStateUuid]);
    const next = toBoolean(nextStateValues[bellStateUuid]);
    if (previous || !next) {
      continue;
    }
    const timestamp = new Date().toISOString();
    const existing = cache.intercomHistoryByUuidAction[uuidAction] ?? [];
    cache.intercomHistoryByUuidAction = {
      ...cache.intercomHistoryByUuidAction,
      [uuidAction]: [timestamp, ...existing].slice(0, 40),
    };
    changed = true;
  }
  return changed;
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
  const explicitSerial = parseMiniserverSerial(payload.serial);
  if (payload.serial.trim() && !explicitSerial) {
    throw new Error(t(resolveLanguage(), 'invalid_miniserver_serial'));
  }
  const address = parseConnectionAddress(payload.origin || (explicitSerial ? remoteConnectUrl(explicitSerial) : ''));
  if (!address) {
    throw new Error(t(resolveLanguage(), 'enter_server_address'));
  }
  address.search = '';
  address.hash = '';
  address.pathname = address.pathname.replace(/\/{2,}/g, '/');
  const origin = address.toString().replace(/\/$/, '');
  const inferredSerial = inferSerialFromOrigin(address);
  const preserveExistingSerial = existing && existing.origin === origin ? existing.serial : null;
  const serial = explicitSerial ?? inferredSerial ?? preserveExistingSerial ?? null;
  const username = payload.username.trim();
  const sameAccess = existing?.origin === origin && existing.serial === serial && existing.username === username;
  const password = payload.password || (sameAccess ? existing.password : '');

  if (self.location.protocol === 'https:' && address.protocol === 'http:' && !serial) {
    throw new Error(t(resolveLanguage(), 'https_connection_address_required'));
  }
  if ((address.hostname === 'connect.loxonecloud.com' || address.hostname === 'dns.loxonecloud.com') && !inferredSerial) {
    throw new Error(t(resolveLanguage(), 'invalid_miniserver_serial'));
  }
  if (!username) {
    throw new Error(t(resolveLanguage(), 'enter_login'));
  }
  if (!password) {
    throw new Error(t(resolveLanguage(), 'enter_password'));
  }

  const base: StoredCredentials = {
    origin,
    serial,
    resolvedOrigin: existing?.resolvedOrigin ?? null,
    username,
    password,
    intercomUsername: sameAccess ? existing.intercomUsername : '',
    intercomPassword: sameAccess ? existing.intercomPassword : '',
    token: existing?.token ?? null,
    tokenValidUntil: existing?.tokenValidUntil ?? null,
  };

  if (
    existing &&
    (existing.origin !== base.origin ||
      existing.serial !== base.serial ||
      existing.username !== base.username ||
      existing.password !== base.password)
  ) {
    base.resolvedOrigin = null;
    base.token = null;
    base.tokenValidUntil = null;
  }

  return base;
}

function inferSerialFromOrigin(address: URL): string | null {
  const remoteSerial = remoteConnectSerial(address);
  if (remoteSerial) {
    return remoteSerial;
  }
  if (address.hostname.endsWith('.dyndns.loxonecloud.com')) {
    const labels = address.hostname.split('.');
    return parseMiniserverSerial(labels[labels.length - 4] ?? '');
  }
  return null;
}

function clampHistory(value: number): number {
  if (!Number.isFinite(value)) {
    return 8;
  }
  return Math.max(3, Math.min(20, Math.round(value)));
}

function scheduleCachePersist(delayMs = 300): void {
  const scheduledAt = Date.now() + delayMs;
  if (persistCacheTimer !== null) {
    if (persistCacheAt <= scheduledAt) return;
    clearTimeout(persistCacheTimer);
  }
  persistCacheAt = scheduledAt;
  persistCacheTimer = self.setTimeout(() => {
    persistCacheTimer = null;
    void saveCache(cache).catch(() => undefined);
  }, delayMs);
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
