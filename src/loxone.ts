import { throwIfAborted } from './abort';
import { isLocalHost, remoteConnectUrl } from './connection-address';
import { CryptoJS, forge } from './loxone-crypto';
import type {
  ActivityLogSourceSummary,
  IntercomFunction,
  IntercomMediaAuthMode,
  IntercomSummary,
  IntercomTransportMode,
  IntercomViewConfig,
  IntercomViewModel,
  LoxoneControl,
  LoxoneStateValue,
  LoxoneStructure,
  StoredCredentials,
} from './types';
import { localeForLanguage, rt } from './translations';

const WS_PATH = 'ws/rfc6455';
const TOKEN_PERMISSION_APP = '4';
const AUTH_BOOTSTRAP_RETRIES = 3;
const AUTH_BOOTSTRAP_RETRY_DELAY_MS = 350;
const AUTH_TOKEN_STEP_DELAY_MS = 150;
const CONNECT_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const RESUME_PROBE_TIMEOUT_MS = 4_000;
const RESUME_IDLE_MS = 8_000;
const LOXONE_EPOCH_MS = Date.UTC(2009, 0, 1);
const KEEPALIVE_RESPONSE = 6;
const OUT_OF_SERVICE = 5;
const TEXT_MESSAGE = 0;
const VALUE_STATE_TABLE = 2;
const TEXT_STATE_TABLE = 3;
const INTERCOM_TYPE_HINTS = [
  'intercom',
  'intercomv2',
  'doorcontroller',
  'doorstation',
  'doorbell',
  'wideodomofon',
  'dzwonek',
  'bramofon',
];
const STREAM_DETAIL_PATHS = [
  'videoInfo.streamUrl',
  'videoInfo.streamUrlExtern',
  'videoInfo.streamUrlIntern',
  'videoInfo.url',
  'streamUrl',
];
const SNAPSHOT_DETAIL_PATHS = [
  'videoInfo.alertImage',
  'videoInfo.liveImageUrl',
  'videoInfo.liveImage',
  'videoInfo.imageUrl',
  'alertImage',
  'liveImageUrl',
  'liveImage',
  'imageUrl',
];
const HISTORY_DETAIL_PATHS = ['lastBellEvents', 'videoInfo.lastBellEvents'];
const DIRECT_INTERCOM_STREAM_PATHS = ['mjpg/video.mjpg', 'video.mjpg'];
const DIRECT_INTERCOM_SNAPSHOT_PATHS = ['jpg/image.jpg', 'image.jpg'];
const INTERCOM_USERNAME_DETAIL_PATHS = [
  'videoInfo.user',
  'videoInfo.username',
  'videoInfo.authUser',
  'videoInfo.login',
  'user',
  'username',
  'authUser',
  'login',
];
const INTERCOM_PASSWORD_DETAIL_PATHS = [
  'videoInfo.pass',
  'videoInfo.password',
  'videoInfo.authPassword',
  'videoInfo.pwd',
  'pass',
  'password',
  'authPassword',
  'pwd',
];
const ADDRESS_STATE_CANDIDATES = ['trustAddress', 'address', 'ipAddress', 'deviceAddress', 'host'];
const ADDRESS_DETAIL_PATHS = [
  'address',
  'trustAddress',
  'ipAddress',
  'deviceAddress',
  'host',
  'videoInfo.address',
  'videoInfo.host',
  'videoInfo.ipAddress',
  'videoInfo.deviceAddress',
  'videoInfo.trustAddress',
  'device.address',
  'device.host',
  'device.ipAddress',
];
const DOORBELL_STATE_CANDIDATES = ['bell', 'ring', 'doorbell'];
const MUTE_STATE_CANDIDATES = ['mute', 'isMuted', 'muted', 'microphoneMute'];

interface LoxoneClientHandlers {
  onConnecting: () => void;
  onReady: (payload: {
    structure: LoxoneStructure;
    stateValues: Record<string, LoxoneStateValue>;
    token: string | null;
    tokenValidUntil: string | null;
    resolvedOrigin: string | null;
  }) => void;
  onStatesChanged: (changed: Record<string, LoxoneStateValue>) => void;
  onAvailabilityChanged: (online: boolean, message: string) => void;
  onError: (message: string) => void;
}

interface LoxoneConnectionHints {
  serial: string | null;
}

interface IntercomTransportProfile {
  deviceUuid: string | null;
  mode: IntercomTransportMode;
  mediaAuthMode: IntercomMediaAuthMode;
  signalingUrl: string | null;
  mediaBaseUrl: string | null;
  historyBaseUrl: string | null;
  mediaRootPath: string | null;
  snapshotUrl: string | null;
  streamUrl: string | null;
  runtimeOrigin: string | null;
  addressHost: string | null;
}

interface PendingHeader {
  identifier: number;
}

class LoxoneResponseError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

class InsecureConnectionError extends Error {}

export class LoxoneClient {
  private credentials: StoredCredentials;
  private hints: LoxoneConnectionHints;
  private lifetime = new AbortController();
  private connecting = false;
  private ready = false;
  private ws: WebSocket | null = null;
  private pendingResponse:
    | {
        resolve: (value: string) => void;
        reject: (reason?: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;
  private pendingHeader: PendingHeader | null = null;
  private keepaliveInterval: number | null = null;
  private keepaliveDeadline: number | null = null;
  private lastSocketActivityAt = 0;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private commandLock = Promise.resolve();
  private stateValues: Record<string, LoxoneStateValue> = {};
  private structure: LoxoneStructure | null = null;

  constructor(
    credentials: StoredCredentials,
    private readonly handlers: LoxoneClientHandlers,
    hints: LoxoneConnectionHints,
  ) {
    this.credentials = { ...credentials };
    this.hints = hints;
  }

  updateConnectionHints(hints: Partial<LoxoneConnectionHints>): void {
    this.hints = {
      ...this.hints,
      ...hints,
    };
  }

  resume(): void {
    if (this.connecting || this.lifetime.signal.aborted) {
      return;
    }
    if (this.ready) {
      if (this.ws?.readyState !== WebSocket.OPEN || Date.now() - this.lastSocketActivityAt >= RESUME_IDLE_MS) {
        this.probeKeepalive(true);
      }
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    // A missing timer means the client is not retrying, usually after an auth failure.
    if (this.reconnectTimer === null) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect();
  }

  async connect(): Promise<void> {
    if (this.connecting || this.ready || this.lifetime.signal.aborted) {
      return;
    }
    this.connecting = true;
    this.handlers.onConnecting();

    try {
      await this.connectSocket();
      this.structure ??= await this.loadStructure();
      await this.sendCommand('jdev/sps/enablebinstatusupdate');
      throwIfAborted(this.lifetime.signal);
      this.ready = true;
      this.lastSocketActivityAt = Date.now();
      this.reconnectAttempts = 0;
      this.startKeepalive();
      this.handlers.onReady({
        structure: this.structure,
        stateValues: { ...this.stateValues },
        token: this.credentials.token,
        tokenValidUntil: this.credentials.tokenValidUntil,
        resolvedOrigin: this.credentials.resolvedOrigin ?? effectiveOrigin(this.credentials),
      });
      this.handlers.onAvailabilityChanged(true, rt('miniserver_connected'));
    } catch (error) {
      this.disconnectSocket();
      if (!this.lifetime.signal.aborted) {
        this.handlers.onError(toErrorMessage(error));
        if (!isAuthorizationError(error) && !(error instanceof InsecureConnectionError)) {
          this.scheduleReconnect();
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  close(): void {
    this.lifetime.abort();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disconnectSocket();
  }

  private disconnectSocket(error = new Error(rt('miniserver_connection_closed'))): void {
    this.stopKeepalive();
    this.ready = false;
    this.pendingHeader = null;
    this.stateValues = {};
    const pending = this.takePendingResponse();
    pending?.reject(error);
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }

  private handleConnectionLoss(error: Error): void {
    const wasReady = this.ready;
    this.disconnectSocket(error);
    if (wasReady) {
      this.handlers.onAvailabilityChanged(false, error.message);
      if (!isAuthorizationError(error)) this.scheduleReconnect();
    }
  }

  async sendAction(uuidAction: string, command: string): Promise<void> {
    const encodedUuid = encodeURIComponent(uuidAction);
    const encodedCommand = encodeURIComponent(command).replace(/%2F/g, '/');
    await this.sendCommand(`jdev/sps/io/${encodedUuid}/${encodedCommand}`);
  }

  async fetchSecuredDetails(uuidAction: string): Promise<Record<string, unknown>> {
    const encodedUuid = encodeURIComponent(uuidAction);
    const response = await this.sendCommand(`jdev/sps/io/${encodedUuid}/securedDetails`);
    return coerceMaybeJsonRecord(response.value);
  }

  private async connectSocket(): Promise<void> {
    if (this.credentials.token && !isExpired(this.credentials.tokenValidUntil)) {
      try {
        await this.openAuthenticatedSocket('reuse');
        return;
      } catch (error) {
        if (!(error instanceof LoxoneResponseError) || error.code !== 401) throw error;
        this.disconnectSocket();
      }
    }

    this.credentials.token = null;
    this.credentials.tokenValidUntil = null;
    try {
      // Miniserver v11.2+ permits token acquisition on an authenticated TLS
      // transport without a separate public-key fetch or application envelope.
      await this.openAuthenticatedSocket('acquire');
      return;
    } catch (error) {
      throwIfAborted(this.lifetime.signal);
      if (isAuthorizationError(error) || error instanceof InsecureConnectionError) throw error;
    }

    await this.requestEncryptedHttpToken();
    await this.openAuthenticatedSocket('reuse');
  }

  private async openAuthenticatedSocket(authentication: 'reuse' | 'acquire'): Promise<void> {
    const { origin, resolvedOrigin } = this.credentials;
    const lookup = remoteConnectLookup(origin, this.hints.serial);
    if (
      !lookup &&
      !isAllowedTransport(new URL(origin)) &&
      !(resolvedOrigin && isAllowedTransport(new URL(resolvedOrigin)))
    ) {
      throw new InsecureConnectionError(describeSocketFailure(origin, this.hints.serial));
    }
    const attempted = new Set<string>();
    let lastError: Error | null = null;

    const tryOrigin = async (target: string): Promise<boolean> => {
      for (const candidate of socketCandidates(target, this.hints.serial)) {
        if (authentication === 'acquire' && !candidate.wsUrl.startsWith('wss:')) continue;
        if (attempted.has(candidate.wsUrl)) continue;
        attempted.add(candidate.wsUrl);
        try {
          const socket = await this.openSocketCandidate(candidate);
          throwIfAborted(this.lifetime.signal);
          this.ws = socket;
          if (authentication === 'acquire') {
            await this.acquireSocketToken();
          } else {
            await this.authenticateSocket();
          }
          this.credentials.resolvedOrigin = candidate.origin;
          return true;
        } catch (error) {
          this.disconnectSocket();
          throwIfAborted(this.lifetime.signal);
          if (isAuthorizationError(error)) throw error;
          lastError = error instanceof Error ? error : new Error(rt('websocket_open_failed'));
        }
      }
      return false;
    };

    if (resolvedOrigin && await tryOrigin(resolvedOrigin)) return;
    if (await tryOrigin(origin)) return;
    if (lookup) {
      const resolved = await resolveRemoteConnect(lookup.serial, this.lifetime.signal);
      if (resolved && await tryOrigin(resolved)) return;
      // The public-key request also reveals the legacy relay origin when the
      // discovery JSON isn't available. No credentials are sent on this hop.
      const result = await fetchPublicKey(lookup.redirectOrigin, this.lifetime.signal).catch(() => null);
      throwIfAborted(this.lifetime.signal);
      if (result && await tryOrigin(result.resolvedOrigin)) return;
    }

    throw lastError ?? new Error(describeSocketFailure(origin, this.hints.serial));
  }

  private async openSocketCandidate(candidate: { origin: string; wsUrl: string }): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const signal = this.lifetime.signal;
      throwIfAborted(signal);
      const socket = new WebSocket(candidate.wsUrl, 'remotecontrol');
      const openError = new Error(describeSocketFailure(candidate.origin, this.hints.serial));
      const timer = setTimeout(() => fail(openError), CONNECT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const fail = (error: unknown) => {
        cleanup();
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        reject(error);
      };
      const abort = () => fail(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        cleanup();
        socket.onmessage = (event) => {
          if (this.ws === socket) this.handleMessage(event.data);
        };
        socket.onclose = (event) => {
          if (this.ws === socket) {
            this.handleConnectionLoss(socketCloseError(event.code));
          }
        };
        socket.onerror = null;
        resolve(socket);
      };
      socket.onclose = (event) => {
        const error = socketCloseError(event.code);
        fail(isAuthorizationError(error) ? error : openError);
      };
      socket.onerror = () => fail(openError);
    });
  }

  private async acquireSocketToken(): Promise<void> {
    const username = sanitizeAuthSegment(this.credentials.username);
    const salts = coerceMaybeJsonRecord((await this.sendCommand(authKeyCommand(username))).value);
    const request = authTokenCommand(username, this.credentials.password, salts, newClientUuid(), 'CustomLoxoneApp');
    const token = coerceMaybeJsonRecord((await this.sendCommand(request)).value);
    this.storeToken(token);
  }

  private async requestEncryptedHttpToken(): Promise<void> {
    const tokenResult = await requestJwtToken(
      this.credentials.origin,
      this.hints.serial,
      sanitizeAuthSegment(this.credentials.username),
      this.credentials.password,
      newClientUuid(),
      'CustomLoxoneApp',
      this.lifetime.signal,
    );
    this.storeToken(tokenResult.payload);
    this.credentials.resolvedOrigin = tokenResult.resolvedOrigin;
  }

  private storeToken(payload: Record<string, unknown>): void {
    if (!hasAuthTokenPayload(payload)) throw new Error(rt('loxone_missing_value'));
    this.credentials.token = asString(payload.token);
    this.credentials.tokenValidUntil = payload.validUntil ? String(payload.validUntil) : null;
  }

  private async authenticateSocket(): Promise<void> {
    const username = sanitizeAuthSegment(this.credentials.username);
    if (!this.credentials.token) {
      throw new Error(rt('loxone_missing_value'));
    }
    await this.sendCommand(
      `authwithtoken/${encodeURIComponent(this.credentials.token)}/${encodeURIComponent(username)}`,
    );
  }

  private async loadStructure(): Promise<LoxoneStructure> {
    const raw = await this.sendTextCommand('data/LoxAPP3.json');
    const payload = JSON.parse(raw) as unknown;
    const record = ensureRecord(payload);
    return parseStructure(record);
  }

  private async sendCommand(command: string): Promise<{ code: number; control: string; value: unknown }> {
    const raw = await this.sendTextCommand(command);
    return parseCommandPayload(raw, command);
  }

  private async sendTextCommand(command: string): Promise<string> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(rt('websocket_not_connected'));
    }

    const operation = this.commandLock.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error(rt('websocket_not_connected')));
            return;
          }

          const timer = setTimeout(() => {
            // Commands share one response slot. A delayed reply must stay on the old socket.
            this.handleConnectionLoss(new Error(rt('websocket_no_response', { command: commandName(command) })));
          }, COMMAND_TIMEOUT_MS);
          this.pendingResponse = { resolve, reject, timer };
          try {
            socket.send(command);
          } catch (error) {
            this.takePendingResponse()?.reject(error);
          }
        }),
    );

    this.commandLock = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private takePendingResponse() {
    const pending = this.pendingResponse;
    this.pendingResponse = null;
    if (pending) {
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private handleMessage(data: ArrayBuffer | string): void {
    this.lastSocketActivityAt = Date.now();
    if (typeof data === 'string') {
      this.pendingHeader = null;
      this.deliverText(data);
      return;
    }

    const bytes = new Uint8Array(data);
    if (bytes.length === 8 && bytes[0] === 0x03) {
      const header = parseHeader(bytes);
      if (header.identifier === KEEPALIVE_RESPONSE) {
        this.clearKeepaliveDeadline();
        return;
      }
      if (header.identifier === OUT_OF_SERVICE) {
        this.structure = null;
        this.handleConnectionLoss(new Error(rt('miniserver_out_of_service')));
        return;
      }
      this.pendingHeader = header;
      return;
    }

    const header = this.pendingHeader;
    this.pendingHeader = null;
    if (!header) {
      return;
    }

    if (header.identifier === VALUE_STATE_TABLE) {
      this.mergeChangedStates(parseValueStateTable(bytes));
      return;
    }

    if (header.identifier === TEXT_STATE_TABLE) {
      this.mergeChangedStates(parseTextStateTable(bytes));
      return;
    }

    if (header.identifier === TEXT_MESSAGE) {
      this.deliverText(new TextDecoder().decode(bytes));
    }
  }

  private deliverText(payload: string): void {
    const result = applyStateUpdateFromText(payload);
    if (result.isStateUpdate && !result.hasResponseCode) {
      this.mergeChangedStates(result.changed);
    } else {
      this.takePendingResponse()?.resolve(payload);
    }
  }

  private mergeChangedStates(changed: Record<string, LoxoneStateValue>): void {
    const updated: Record<string, LoxoneStateValue> = {};
    for (const [uuid, value] of Object.entries(changed)) {
      if (this.stateValues[uuid] !== value) {
        this.stateValues[uuid] = value;
        updated[uuid] = value;
      }
    }
    if (this.ready && Object.keys(updated).length) {
      this.handlers.onStatesChanged(updated);
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = self.setInterval(() => this.probeKeepalive(), KEEPALIVE_INTERVAL_MS);
  }

  private probeKeepalive(onResume = false): void {
    const recover = () => {
      this.handleConnectionLoss(new Error(rt('miniserver_connection_interrupted')));
      if (onResume) this.reconnectNow();
    };
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      recover();
      return;
    }
    if (this.keepaliveDeadline === null) {
      try {
        socket.send('keepalive');
      } catch {
        recover();
        return;
      }
    } else if (!onResume) {
      return;
    }
    this.clearKeepaliveDeadline();
    this.keepaliveDeadline = self.setTimeout(recover, onResume ? RESUME_PROBE_TIMEOUT_MS : KEEPALIVE_INTERVAL_MS);
  }

  private clearKeepaliveDeadline(): void {
    if (this.keepaliveDeadline !== null) {
      clearTimeout(this.keepaliveDeadline);
      this.keepaliveDeadline = null;
    }
  }

  private stopKeepalive(): void {
    this.clearKeepaliveDeadline();
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.lifetime.signal.aborted) {
      return;
    }
    const delayMs = Math.min(60_000, 5_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = self.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }
}

export function createDefaultView(
  intercomUuidAction: string | null = null,
  activityLogControlUuidAction: string | null = null,
): IntercomViewConfig {
  return {
    id: randomUuid(),
    type: 'intercom',
    title: rt('intercom_label'),
    intercomUuidAction,
    activityLogControlUuidAction,
    historyLimit: 8,
    quickTts: [
      { id: randomUuid(), label: rt('quick_tts_wait_label'), message: rt('quick_tts_wait_message') },
      { id: randomUuid(), label: rt('quick_tts_parcel_label'), message: rt('quick_tts_parcel_message') },
    ],
  };
}

const intercomCatalogs = new WeakMap<LoxoneStructure, IntercomSummary[]>();
const logCatalogs = new WeakMap<LoxoneStructure, ActivityLogSourceSummary[]>();

export function listIntercoms(structure: LoxoneStructure): IntercomSummary[] {
  const existing = intercomCatalogs.get(structure);
  if (existing) return existing;
  const catalog = structure.controls
    .filter(isIntercomControl)
    .map((control) => ({
      uuidAction: control.uuidAction,
      name: control.name,
      roomName: control.roomName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, localeForLanguage('pl')));
  intercomCatalogs.set(structure, catalog);
  return catalog;
}

export function listLogSources(structure: LoxoneStructure): ActivityLogSourceSummary[] {
  const existing = logCatalogs.get(structure);
  if (existing) return existing;
  const catalog = structure.controls
    .filter(isLogSourceControl)
    .map((control) => ({
      uuidAction: control.uuidAction,
      name: control.name,
      type: control.type,
      roomName: control.roomName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, localeForLanguage('pl')));
  logCatalogs.set(structure, catalog);
  return catalog;
}

export function buildIntercomViewModel(
  config: IntercomViewConfig,
  structure: LoxoneStructure | null,
  stateValues: Record<string, LoxoneStateValue>,
  credentials: StoredCredentials | null,
  _cachedHistoryByUuidAction: Record<string, string[]> = {},
  cachedPreviewByUuidAction: Record<string, string> = {},
): IntercomViewModel | null {
  if (!structure) {
    return null;
  }
  const summary = selectIntercomControl(config, structure);
  if (!summary) {
    return null;
  }
  const mediaControl = resolveIntercomMediaControl(summary, structure);

  const doorbellActive = lookupBooleanState(summary, stateValues, DOORBELL_STATE_CANDIDATES);
  const doorbellMuted = lookupBooleanState(summary, stateValues, MUTE_STATE_CANDIDATES);
  const deviceState = lookupNumericState(summary, stateValues, ['deviceState']);
  const supportsAnswer = supportsIntercomAnswer(summary);
  const supportsMute = supportsIntercomMute(summary);
  const transport = credentials
    ? resolveIntercomTransportProfile(summary, mediaControl, stateValues, credentials)
    : {
        deviceUuid: null,
        mode: 'none',
        mediaAuthMode: 'none',
        signalingUrl: null,
        mediaBaseUrl: null,
        historyBaseUrl: null,
        mediaRootPath: null,
        snapshotUrl: null,
        streamUrl: null,
        runtimeOrigin: null,
        addressHost: null,
      } satisfies IntercomTransportProfile;

  const streamUrl = transport.streamUrl;
  const snapshotUrl = transport.snapshotUrl;
  const history: IntercomViewModel['history'] = [];

  const activityLogControl = config.activityLogControlUuidAction
    ? structure.controlsByAction[config.activityLogControlUuidAction] ?? null
    : null;
  const activityLogEntries = activityLogControl
    ? extractActivityLogEntries(activityLogControl, stateValues)
    : [];
  const activityLogWarning = activityLogControl
    ? resolveActivityLogWarning(activityLogControl, stateValues)
    : null;

  return {
    uuidAction: summary.uuidAction,
    name: summary.name,
    roomName: summary.roomName,
    deviceUuid: transport.deviceUuid,
    address: transport.addressHost,
    origin: transport.runtimeOrigin,
    authToken: transport.mode === 'none' ? null : (credentials?.token ?? null),
    transportMode: transport.mode,
    mediaAuthMode: transport.mediaAuthMode,
    signalingUrl: transport.signalingUrl,
    mediaBaseUrl: transport.mediaBaseUrl,
    historyBaseUrl: transport.historyBaseUrl,
    mediaRootPath: transport.mediaRootPath,
    doorbellActive,
    doorbellMuted,
    deviceState,
    supportsAnswer,
    supportsMute,
    snapshotUrl,
    streamUrl,
    cachedPreviewUrl: cachedPreviewByUuidAction[summary.uuidAction] ?? null,
    history,
    functions: resolveChildFunctions(summary, structure),
    activityLogSourceName: activityLogControl?.name ?? null,
    activityLogWarning,
    activityLog: activityLogEntries.slice(-20).map((label, index) => ({
      id: `${activityLogControl?.uuidAction ?? 'log'}:${index}`,
      label,
    })),
  };
}

export function selectIntercomControl(
  config: IntercomViewConfig,
  structure: LoxoneStructure,
): LoxoneControl | null {
  if (config.intercomUuidAction) {
    return structure.controlsByAction[config.intercomUuidAction] ?? null;
  }
  return structure.controls.find(isIntercomControl) ?? null;
}

export function mergeControlSecuredDetails(
  structure: LoxoneStructure,
  uuidAction: string,
  securedDetails: Record<string, unknown>,
): LoxoneStructure {
  if (Object.keys(securedDetails).length === 0) {
    return structure;
  }
  const current = structure.controlsByAction[uuidAction];
  if (!current) {
    return structure;
  }
  const mergedControl: LoxoneControl = {
    ...current,
    details: mergeDetailRecords(current.details, securedDetails),
  };
  return {
    ...structure,
    controls: structure.controls.map((control) => (control.uuidAction === uuidAction ? mergedControl : control)),
    controlsByAction: {
      ...structure.controlsByAction,
      [uuidAction]: mergedControl,
    },
  };
}

export function buildTtsCommand(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }
  return `tts/${encodeURIComponent(trimmed)}`;
}

function resolveChildFunctions(control: LoxoneControl, structure: LoxoneStructure): IntercomFunction[] {
  return structure.controls
    .filter((item) => item.parentUuidAction === control.uuidAction && item.type !== 'Webpage')
    .map((item) => ({
      uuidAction: item.uuidAction,
      name: item.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, localeForLanguage('pl')));
}

function isLogSourceControl(control: LoxoneControl): boolean {
  if (isIntercomControl(control)) {
    return false;
  }
  return normalizeText(control.type) === 'tracker';
}

function lookupBooleanState(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
  candidates: string[],
): boolean {
  for (const stateName of Object.keys(control.states)) {
    const normalized = normalizeText(stateName);
    if (!candidates.some((candidate) => normalized.includes(normalizeText(candidate)))) {
      continue;
    }
    const stateValue = stateValues[control.states[stateName]];
    return toBoolean(stateValue);
  }
  return false;
}

function lookupNumericState(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
  candidates: string[],
): number | null {
  for (const stateName of Object.keys(control.states)) {
    const normalized = normalizeText(stateName);
    if (!candidates.some((candidate) => normalized.includes(normalizeText(candidate)))) {
      continue;
    }
    const stateValue = stateValues[control.states[stateName]];
    const resolved = toNumberLike(stateValue);
    if (resolved !== null) {
      return resolved;
    }
  }
  return null;
}

function supportsIntercomAnswer(control: LoxoneControl): boolean {
  return isIntercomControl(control) && hasAnyState(control, ['bell', 'ring', 'doorbell']);
}

function supportsIntercomMute(control: LoxoneControl): boolean {
  return isIntercomControl(control) && hasAnyState(control, MUTE_STATE_CANDIDATES.concat(['bell']));
}

function resolveIntercomMediaControl(
  control: LoxoneControl,
  structure: LoxoneStructure,
): LoxoneControl {
  const directChildren = structure.controls.filter((item) => item.parentUuidAction === control.uuidAction);
  const parent = control.parentUuidAction ? structure.controlsByAction[control.parentUuidAction] ?? null : null;
  const siblings = parent
    ? structure.controls.filter((item) => item.parentUuidAction === parent.uuidAction && item.uuidAction !== control.uuidAction)
    : [];
  const sameRoom = structure.controls.filter(
    (item) => item.roomName === control.roomName && item.uuidAction !== control.uuidAction,
  );
  const candidates = [control, ...directChildren, ...siblings, ...sameRoom];
  return (
    candidates
      .filter((candidate, index) => candidates.findIndex((item) => item.uuidAction === candidate.uuidAction) === index)
      .find(hasIntercomMediaSignals) ?? control
  );
}

function hasAnyState(control: LoxoneControl, candidates: string[]): boolean {
  return Object.keys(control.states).some((stateName) => {
    const normalized = normalizeText(stateName);
    return candidates.some((candidate) => normalized.includes(normalizeText(candidate)));
  });
}

function hasIntercomMediaSignals(control: LoxoneControl): boolean {
  if (hasAnyState(control, ['lastBellEvents', ...ADDRESS_STATE_CANDIDATES])) {
    return true;
  }
  const detailPaths = STREAM_DETAIL_PATHS.concat(SNAPSHOT_DETAIL_PATHS, HISTORY_DETAIL_PATHS);
  return detailPaths.some((path) => getNestedValue(control.details, path) != null);
}

function resolveIntercomTransportProfile(
  control: LoxoneControl,
  mediaControl: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
  credentials: StoredCredentials,
): IntercomTransportProfile {
  const selectedOrigin = effectiveOrigin(credentials);
  const runtime = new URL(selectedOrigin);
  const runtimeOrigin = isAllowedTransport(runtime) && !isRemoteConnectHost(runtime.hostname) ? selectedOrigin : null;
  const deviceUuid = resolveIntercomDeviceUuid(control) ?? resolveIntercomDeviceUuid(mediaControl);
  // The Structure File routes Trust devices through their member Miniserver.
  // This app has credentials for the connected Miniserver only.
  const foreignTrust = [control, mediaControl].some(({ details }) =>
    Boolean(details?.trustMember || details?.trustAddress));
  const addressBase = foreignTrust
    ? null
    : resolveAddressBase(mediaControl, stateValues) ?? resolveAddressBase(control, stateValues);
  const addressHost = addressBase ? new URL(addressBase).host : null;

  if (addressBase && self.location.protocol !== 'https:') {
    const intercomAuth = resolveIntercomAuth(mediaControl, credentials);
    const signalingUrl = toWebSocketUrl(addressBase);
    const mediaBaseUrl = signAbsoluteUrl(ensureTrailingSlash(addressBase), credentials, 'intercom', intercomAuth);
    return {
      deviceUuid,
      mode: 'lan-direct',
      mediaAuthMode: 'basic',
      signalingUrl,
      mediaBaseUrl,
      historyBaseUrl: mediaBaseUrl,
      mediaRootPath: null,
      snapshotUrl: signUrl(addressBase, DIRECT_INTERCOM_SNAPSHOT_PATHS[0], credentials, 'intercom', intercomAuth),
      streamUrl: signUrl(addressBase, DIRECT_INTERCOM_STREAM_PATHS[0], credentials, 'intercom', intercomAuth),
      runtimeOrigin,
      addressHost,
    };
  }

  if (!foreignTrust && runtimeOrigin && deviceUuid) {
    const rootPath = `/proxy/${encodeURIComponent(deviceUuid)}`;
    const mediaBaseUrl = `${runtimeOrigin.replace(/\/$/, '')}${rootPath}/`;
    const signalingUrl = toWebSocketUrl(mediaBaseUrl);
    return {
      deviceUuid,
      mode: 'secure-proxy',
      mediaAuthMode: 'token',
      signalingUrl,
      mediaBaseUrl,
      historyBaseUrl: mediaBaseUrl,
      mediaRootPath: rootPath,
      snapshotUrl: new URL('jpg/image.jpg', mediaBaseUrl).toString(),
      streamUrl: new URL('mjpg/video.mjpg', mediaBaseUrl).toString(),
      runtimeOrigin,
      addressHost,
    };
  }

  return {
    deviceUuid,
    mode: 'none',
    mediaAuthMode: 'none',
    signalingUrl: null,
    mediaBaseUrl: null,
    historyBaseUrl: null,
    mediaRootPath: null,
    snapshotUrl: null,
    streamUrl: null,
    runtimeOrigin,
    addressHost,
  };
}

function extractActivityLogEntries(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
): string[] {
  const entriesStateUuid = resolveTrackerEntriesStateUuid(control);
  if (!entriesStateUuid) {
    return [];
  }
  return collectEventLogEntries(stateValues[entriesStateUuid]);
}

function resolveActivityLogWarning(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
): string | null {
  const entriesStateUuid = resolveTrackerEntriesStateUuid(control);
  if (!entriesStateUuid) {
    return rt('tracker_entries_missing');
  }
  if (!(entriesStateUuid in stateValues)) {
    return rt('tracker_entries_not_published');
  }
  return null;
}

function resolveTrackerEntriesStateUuid(control: LoxoneControl): string | null {
  for (const [stateName, stateUuid] of Object.entries(control.states)) {
    if (normalizeText(stateName) === 'entries') {
      return stateUuid;
    }
  }
  return null;
}

function collectEventLogEntries(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) {
      return [];
    }
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        return collectEventLogEntries(JSON.parse(raw));
      } catch {
        return splitEventLogText(raw);
      }
    }
    return splitEventLogText(raw);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEventLogEntries(item));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['entries', 'events', 'items', 'history', 'records', 'log', 'result', 'value']) {
      if (!(key in record)) {
        continue;
      }
      const parsed = collectEventLogEntries(record[key]);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    try {
      return [JSON.stringify(record)];
    } catch {
      return [];
    }
  }

  const text = String(value).trim();
  return text ? [text] : [];
}

function splitEventLogText(value: string): string[] {
  return value
    .replace(/[\x14;]/g, '\n')
    .split(/[\r\n|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAddressBase(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
): string | null {
  for (const stateName of Object.keys(control.states)) {
    if (
      !ADDRESS_STATE_CANDIDATES.some((candidate) => {
        const normalizedState = normalizeText(stateName);
        const normalizedCandidate = normalizeText(candidate);
        return normalizedState === normalizedCandidate || normalizedState.includes(normalizedCandidate);
      })
    ) {
      continue;
    }
    const value = stateValues[control.states[stateName]];
    const resolved = resolveAddressBaseValue(value);
    if (resolved) {
      return resolved;
    }
  }
  for (const detailPath of ADDRESS_DETAIL_PATHS) {
    const resolved = resolveAddressBaseValue(getNestedValue(control.details, detailPath));
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function resolveAddressBaseValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return resolveAddressBaseValue(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return normalizeBaseUrl(trimmed);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveAddressBaseValue(item);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['address', 'host', 'ipAddress', 'deviceAddress', 'trustAddress', 'url', 'href', 'value']) {
      const resolved = resolveAddressBaseValue(record[key]);
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

function resolveIntercomDeviceUuid(control: LoxoneControl): string | null {
  for (const path of ['deviceUuid', 'videoInfo.deviceUuid']) {
    const value = getNestedValue(control.details, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const proxyPathCandidate = extractProxyDeviceUuidFromValue(control.details);
  return proxyPathCandidate;
}

function extractProxyDeviceUuidFromValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = value.match(/\/proxy\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = extractProxyDeviceUuidFromValue(item);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const resolved = extractProxyDeviceUuidFromValue(nested);
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

function normalizeBaseUrl(value: string): string | null {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  if (value.includes('/')) {
    const host = value.split('/', 1)[0];
    return `${isLocalHost(host) ? 'http' : 'https'}://${host}`;
  }
  return `${isLocalHost(value) ? 'http' : 'https'}://${value}`;
}

function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function signAbsoluteUrl(
  rawUrl: string,
  credentials: StoredCredentials,
  mode: 'server' | 'intercom',
  authOverride?: { username: string; password: string },
): string {
  const url = new URL(rawUrl);
  const auth =
    authOverride ??
    (mode === 'server'
      ? { username: credentials.username, password: credentials.password }
      : {
          username: credentials.intercomUsername || credentials.username,
          password: credentials.intercomPassword || credentials.password,
        });
  url.username = auth.username;
  url.password = auth.password;
  return url.toString();
}

function signUrl(
  base: string,
  pathOrUrl: string,
  credentials: StoredCredentials,
  mode: 'server' | 'intercom',
  authOverride?: { username: string; password: string },
): string {
  const url = new URL(pathOrUrl, ensureTrailingSlash(base));
  return signAbsoluteUrl(url.toString(), credentials, mode, authOverride);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function effectiveOrigin(credentials: StoredCredentials): string {
  return credentials.resolvedOrigin ?? credentials.origin;
}

function resolveAuthResponseOrigin(origin: string, responseUrl: string, commandPath: string): string {
  const fallback = new URL(origin);
  const response = new URL(responseUrl, fallback);
  const commandSuffix = `/${commandPath.replace(/^\/+/, '')}`;
  if (response.pathname.endsWith(commandSuffix)) {
    const trimmedPath = response.pathname.slice(0, -commandSuffix.length);
    response.pathname = trimmedPath || '/';
  }
  response.search = '';
  response.hash = '';
  return response.toString().replace(/\/$/, '');
}

function resolveAuthBootstrapOrigin(responseUrl: string): string {
  const url = new URL('.', responseUrl);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isIntercomControl(control: LoxoneControl): boolean {
  const type = normalizeText(control.type);
  if (INTERCOM_TYPE_HINTS.some((hint) => type.includes(normalizeText(hint)))) {
    return true;
  }
  const name = normalizeText(control.name);
  if (INTERCOM_TYPE_HINTS.some((hint) => name.includes(normalizeText(hint)))) {
    return true;
  }
  return Object.keys(control.states).some((stateName) => normalizeText(stateName) === 'lastbellevents');
}

function parseStructure(payload: Record<string, unknown>): LoxoneStructure {
  const roomsRaw = ensureRecord(payload.rooms ?? {});
  const categoriesRaw = ensureRecord(payload.cats ?? {});
  const controlsRaw = ensureRecord(payload.controls ?? {});
  const rooms = new Map<string, string>();
  const categories = new Map<string, string>();

  for (const [uuid, room] of Object.entries(roomsRaw)) {
    rooms.set(uuid, safeName((room as Record<string, unknown>).name));
  }
  for (const [uuid, category] of Object.entries(categoriesRaw)) {
    categories.set(uuid, safeName((category as Record<string, unknown>).name));
  }

  const controls: LoxoneControl[] = [];
  const controlsByAction: Record<string, LoxoneControl> = {};
  const stateOwnerByUuid: LoxoneStructure['stateOwnerByUuid'] = {};

  const visit = (
    controlUuid: string,
    rawControl: Record<string, unknown>,
    parent: LoxoneControl | null,
    inheritedRoom: string | null,
    inheritedCategory: string | null,
    path: string[],
  ): void => {
    const name = safeName(rawControl.name) || controlUuid;
    const roomUuid = typeof rawControl.room === 'string' ? rawControl.room : inheritedRoom;
    const categoryUuid = typeof rawControl.cat === 'string' ? rawControl.cat : inheritedCategory;
    const uuidAction =
      typeof rawControl.uuidAction === 'string' && rawControl.uuidAction.trim()
        ? rawControl.uuidAction
        : controlUuid;
    const states = coerceStateMap(rawControl.states);
    const control: LoxoneControl = {
      uuid: controlUuid,
      uuidAction,
      name,
      type: safeName(rawControl.type) || 'Unknown',
      roomName: roomUuid ? rooms.get(roomUuid) ?? null : null,
      categoryName: categoryUuid ? categories.get(categoryUuid) ?? null : null,
      states,
      details: coerceDetails(rawControl),
      parentUuidAction: parent?.uuidAction ?? null,
      path: [...path, name],
    };
    controls.push(control);
    controlsByAction[uuidAction] = control;

    for (const [stateName, stateUuid] of Object.entries(states)) {
      stateOwnerByUuid[normalizeUuid(stateUuid)] = {
        controlUuidAction: uuidAction,
        stateName,
      };
    }

    const subControls = rawControl.subControls;
    if (subControls && typeof subControls === 'object') {
      for (const [subUuid, subControl] of Object.entries(subControls)) {
        if (subControl && typeof subControl === 'object') {
          visit(
            subUuid,
            subControl as Record<string, unknown>,
            control,
            roomUuid,
            categoryUuid,
            control.path,
          );
        }
      }
    }
  };

  for (const [controlUuid, rawControl] of Object.entries(controlsRaw)) {
    if (rawControl && typeof rawControl === 'object') {
      visit(controlUuid, rawControl as Record<string, unknown>, null, null, null, []);
    }
  }

  const msInfo = ensureRecord(payload.msInfo ?? {});

  return {
    miniserverName: safeName(msInfo.msName) || 'Loxone Miniserver',
    serverModel: safeName(msInfo.model) || 'Miniserver',
    serial: safeName(msInfo.serialNr) || 'unknown',
    loxappVersion: safeName(payload.lastModified) || '',
    controls,
    controlsByAction,
    stateOwnerByUuid,
  };
}

function coerceStateMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      result[key] = normalizeUuid(raw);
    }
  }
  return result;
}

function coerceDetails(value: Record<string, unknown>): Record<string, unknown> {
  const details = coerceDetailsRecord(value.details);
  const securedDetails = coerceDetailsRecord(value.securedDetails);
  return mergeDetailRecords(details, securedDetails);
}

function coerceMaybeJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function coerceDetailsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function mergeDetailRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (
      current &&
      value &&
      typeof current === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(current) &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeDetailRecords(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function resolveIntercomAuth(
  control: LoxoneControl,
  credentials: StoredCredentials,
): { username: string; password: string } {
  const username = resolveDetailString(control.details, INTERCOM_USERNAME_DETAIL_PATHS);
  const password = resolveDetailString(control.details, INTERCOM_PASSWORD_DETAIL_PATHS);
  return {
    username: username || credentials.intercomUsername || credentials.username,
    password: password || credentials.intercomPassword || credentials.password,
  };
}

function resolveDetailString(details: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = getNestedValue(details, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function parseHeader(bytes: Uint8Array): PendingHeader {
  return {
    identifier: bytes[1],
  };
}

function parseValueStateTable(bytes: Uint8Array): Record<string, LoxoneStateValue> {
  const result: Record<string, LoxoneStateValue> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 24 <= bytes.byteLength; offset += 24) {
    const uuid = uuidFromBytesLe(bytes.subarray(offset, offset + 16));
    const value = view.getFloat64(offset + 16, true);
    result[uuid] = value;
  }
  return result;
}

function parseTextStateTable(bytes: Uint8Array): Record<string, LoxoneStateValue> {
  const result: Record<string, LoxoneStateValue> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 36 <= bytes.byteLength) {
    const uuid = uuidFromBytesLe(bytes.subarray(offset, offset + 16));
    offset += 16;
    offset += 16;
    const textLength = view.getUint32(offset, true);
    offset += 4;
    const paddedLength = Math.ceil(textLength / 4) * 4;
    if (paddedLength > bytes.length - offset) {
      break;
    }
    const slice = bytes.subarray(offset, offset + textLength);
    result[uuid] = decoder.decode(slice);
    offset += paddedLength;
  }
  return result;
}

function uuidFromBytesLe(bytes: Uint8Array): string {
  const ordered = [
    bytes[3],
    bytes[2],
    bytes[1],
    bytes[0],
    bytes[5],
    bytes[4],
    bytes[7],
    bytes[6],
    bytes[8],
    bytes[9],
    bytes[10],
    bytes[11],
    bytes[12],
    bytes[13],
    bytes[14],
    bytes[15],
  ];
  const hex = ordered.map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function parseCommandPayload(raw: string, command: string): { code: number; control: string; value: unknown } {
  const trimmed = sanitizeJsonLikeText(raw).trim();
  if (!trimmed) {
    throw new Error(rt('miniserver_empty_response'));
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && 'LL' in (parsed as Record<string, unknown>)) {
      const root = ensureRecord((parsed as Record<string, unknown>).LL);
      const code = Number(root.Code ?? root.code ?? 0);
      if (code === 401) {
        throw new LoxoneResponseError(code, rt('loxone_bad_credentials'));
      }
      if (code >= 400) {
        throw new LoxoneResponseError(code, rt('loxone_command_error', { code, command: commandName(command) }));
      }
      return {
        code,
        control: String(root.control ?? command),
        value: deserializeValue(root.value),
      };
    }
    return { code: 200, control: command, value: deserializeValue(parsed) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { code: 200, control: command, value: deserializeValue(trimmed) };
    }
    throw error;
  }
}

function commandName(command: string): string {
  const segments = command.split('/');
  return segments[0] === 'authwithtoken' ? segments[0] : segments.slice(0, 3).join('/');
}

function isAuthorizationError(error: unknown): error is LoxoneResponseError {
  return error instanceof LoxoneResponseError && [401, 403, 423, 429, 4003, 4006].includes(error.code);
}

function socketCloseError(code: number): Error {
  if ([4003, 4006].includes(code)) {
    return new LoxoneResponseError(code, rt('miniserver_login_blocked'));
  }
  if (code === 4007) {
    return new Error(rt('miniserver_out_of_service'));
  }
  return new Error(rt('miniserver_connection_interrupted'));
}

function sanitizeJsonLikeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, '');
}

function applyStateUpdateFromText(payload: string): {
  isStateUpdate: boolean;
  hasResponseCode: boolean;
  changed: Record<string, LoxoneStateValue>;
} {
  try {
    const parsed = JSON.parse(payload) as unknown;
    const root = ensureRecord((parsed as Record<string, unknown>).LL);
    const control = root.control;
    const rawCode = root.Code ?? root.code;
    const hasResponseCode = rawCode !== undefined;
    if (typeof control !== 'string') {
      return { isStateUpdate: false, hasResponseCode, changed: {} };
    }
    const match = control.match(/^[a-z/]+\/(?<uuid>[0-9A-Fa-f-]{32,36})(?:\/.*)?$/);
    if (!match?.groups?.uuid) {
      return { isStateUpdate: false, hasResponseCode, changed: {} };
    }
    return {
      isStateUpdate: true,
      hasResponseCode,
      changed: {
        [normalizeUuid(match.groups.uuid)]: deserializeValue(root.value) as LoxoneStateValue,
      },
    };
  } catch {
    return { isStateUpdate: false, hasResponseCode: false, changed: {} };
  }
}

function deserializeValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function hashCredentials(
  username: string,
  password: string,
  salt: string,
  keyHex: string,
  hashAlgorithm: string,
): string {
  const key = keyHex.trim();
  if (!/^(?:[\da-f]{2})+$/i.test(key)) {
    throw new Error(rt('invalid_hmac_key'));
  }
  const useSha256 = hashAlgorithm.includes('256');
  const hash = useSha256 ? CryptoJS.SHA256 : CryptoJS.SHA1;
  const hmac = useSha256 ? CryptoJS.HmacSHA256 : CryptoJS.HmacSHA1;
  const passwordHash = hash(`${password}:${salt}`).toString().toUpperCase();
  return hmac(`${username}:${passwordHash}`, CryptoJS.enc.Hex.parse(key)).toString();
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return normalizeUuid(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

function newClientUuid(): string {
  return randomUuid().replace(/-([\da-f]{12})$/, '$1');
}

function authKeyCommand(username: string): string {
  return `jdev/sys/getkey2/${encodeURIComponent(username)}`;
}

function authTokenCommand(
  username: string,
  password: string,
  salts: Record<string, unknown>,
  clientUuid: string,
  clientInfo: string,
): string {
  if (!hasAuthKeyPayload(salts)) throw new Error(rt('loxone_missing_value'));
  const key = asString(salts.key);
  const salt = asString(salts.salt);
  const hashAlgorithm = asString(salts.hashAlg ?? 'SHA1').toUpperCase();
  const hash = hashCredentials(username, password, salt, key, hashAlgorithm);
  return `jdev/sys/getjwt/${hash}/${encodeURIComponent(username)}/${TOKEN_PERMISSION_APP}/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`;
}

async function requestJwtToken(
  origin: string,
  serial: string | null,
  username: string,
  password: string,
  clientUuid: string,
  clientInfo: string,
  signal: AbortSignal,
): Promise<{ resolvedOrigin: string; payload: Record<string, unknown> }> {
  const lookup = remoteConnectLookup(origin, serial);
  const resolved = lookup ? await resolveRemoteConnect(lookup.serial, signal) : null;
  const candidates = new Set([
    ...authBootstrapOrigins(origin, serial),
    ...(resolved ? [resolved] : []),
    ...(lookup ? [lookup.redirectOrigin] : []),
  ]);
  let lastError: unknown = null;

  for (const candidateOrigin of candidates) {
    for (let attempt = 0; attempt < AUTH_BOOTSTRAP_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await requestJwtTokenOnce(
          candidateOrigin,
          username,
          password,
          clientUuid,
          clientInfo,
          signal,
        );
      } catch (error) {
        throwIfAborted(signal);
        if (isAuthorizationError(error)) throw error;
        lastError = error;
        if (attempt < AUTH_BOOTSTRAP_RETRIES - 1) {
          await delay(AUTH_BOOTSTRAP_RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(rt('loxone_unknown_error')));
}

async function requestJwtTokenOnce(
  candidateOrigin: string,
  username: string,
  password: string,
  clientUuid: string,
  clientInfo: string,
  signal: AbortSignal,
): Promise<{ resolvedOrigin: string; payload: Record<string, unknown> }> {
  const { publicKeyPem, resolvedOrigin, authOrigin } = await fetchPublicKey(candidateOrigin, signal);
  const tokenSalts = await requestEncryptedValue(
    authOrigin,
    authKeyCommand(username),
    publicKeyPem,
    signal,
    hasAuthKeyPayload,
  );
  await delay(AUTH_TOKEN_STEP_DELAY_MS);
  const payload = await requestEncryptedValue(
    authOrigin,
    authTokenCommand(username, password, tokenSalts, clientUuid, clientInfo),
    publicKeyPem,
    signal,
    hasAuthTokenPayload,
  );
  return {
    resolvedOrigin,
    payload,
  };
}

async function fetchPublicKey(
  origin: string,
  signal: AbortSignal,
): Promise<{ publicKeyPem: string; resolvedOrigin: string; authOrigin: string }> {
  try {
    const command = 'jdev/sys/getPublicKey';
    const url = new URL(command, ensureTrailingSlash(origin));
    const discovery = isRemoteConnectHost(url.hostname);
    const { response, text } = await fetchText(url, signal, CONNECT_TIMEOUT_MS, discovery ? 'follow' : 'error');
    const finalUrl = new URL(response.url || url.href);
    if (finalUrl.origin !== url.origin && !(discovery && isTrustedRelay(finalUrl))) {
      throw new Error(rt('socket_open_failed'));
    }
    const payload = parseHttpCommandPayload(response, text, command);
    return {
      publicKeyPem: normalizePublicKeyPem(asString(payload.value)),
      resolvedOrigin: resolveAuthResponseOrigin(origin, finalUrl.href, command),
      authOrigin: resolveAuthBootstrapOrigin(finalUrl.href),
    };
  } catch (error) {
    throw mapAuthBootstrapError(error, origin, 'jdev/sys/getPublicKey');
  }
}

function remoteConnectLookup(origin: string, serial: string | null): { serial: string; redirectOrigin: string } | null {
  const configured = new URL(origin);
  const cloud = isRemoteConnectHost(configured.hostname);
  const serialNumber = serial || (cloud ? configured.pathname.split('/').filter(Boolean)[0] : null);
  if (!serialNumber || !/^[a-z\d]+$/i.test(serialNumber)) {
    return null;
  }
  if (!cloud && !(self.location.protocol === 'https:' && isLocalHost(configured.hostname))) return null;
  return { serial: serialNumber, redirectOrigin: remoteConnectUrl(serialNumber.toUpperCase()) };
}

function isRemoteConnectHost(hostname: string): boolean {
  return hostname === 'connect.loxonecloud.com' || hostname === 'dns.loxonecloud.com';
}

function isTrustedRelay(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && url.hostname.endsWith('.loxonecloud.com');
}

async function resolveRemoteConnect(serial: string, signal: AbortSignal): Promise<string | null> {
  const lookup = new URL('https://connect.loxonecloud.com/getip');
  lookup.searchParams.set('snr', serial);
  try {
    const { response, text } = await fetchText(lookup, signal, 3500);
    if (!response.ok) return null;
    const payload = ensureRecord(JSON.parse(text));
    const resolved = typeof payload.url === 'string'
      ? new URL(payload.url)
      : typeof payload.IPHTTPS === 'string'
        ? buildCloudDnsTlsAddress(new URL(`https://${payload.IPHTTPS}`), serial)
        : null;
    if (!resolved || !isTrustedRelay(resolved)) return null;
    resolved.search = '';
    resolved.hash = '';
    return resolved.toString().replace(/\/$/, '');
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

async function fetchText(
  url: URL,
  signal: AbortSignal,
  timeoutMs = CONNECT_TIMEOUT_MS,
  redirect: RequestRedirect = 'error',
) {
  throwIfAborted(signal);
  const request = new AbortController();
  const abort = () => request.abort(signal.reason);
  const timer = setTimeout(() => request.abort(new Error(rt('websocket_open_failed'))), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { signal: request.signal, cache: 'no-store', redirect });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function parseHttpCommandPayload(response: Response, text: string, command: string) {
  if (!response.ok && !text.trim()) {
    throw new LoxoneResponseError(
      response.status,
      rt('loxone_command_error', { code: response.status, command: commandName(command) }),
    );
  }
  const payload = parseCommandPayload(text, command);
  if (!response.ok) {
    throw new LoxoneResponseError(
      response.status,
      rt('loxone_command_error', { code: response.status, command: commandName(command) }),
    );
  }
  return payload;
}

async function requestEncryptedValue(
  origin: string,
  command: string,
  publicKeyPem: string,
  signal: AbortSignal,
  validator?: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const encrypted = await encryptCommand(command, publicKeyPem);
  const urls = buildEncryptedCommandUrls(origin, encrypted);
  let lastError: unknown = null;

  for (const url of urls) {
    try {
      const { response, text: rawResponse } = await fetchText(new URL(url), signal);
      const decrypted = await tryDecryptEncryptedResponse(rawResponse, encrypted.aesKey, encrypted.aesIv);
      const payload = parseHttpCommandPayload(response, decrypted ?? rawResponse, command);
      const record = coerceMaybeJsonRecord(payload.value);
      if (validator && !validator(record)) {
        throw new Error(rt('loxone_missing_value'));
      }
      return record;
    } catch (error) {
      throwIfAborted(signal);
      if (isAuthorizationError(error) && error.code !== 401) throw error;
      if (!isAuthorizationError(lastError) || isAuthorizationError(error)) lastError = error;
    }
  }

  throw mapAuthBootstrapError(lastError, origin, commandName(command));
}

function hasAuthKeyPayload(value: Record<string, unknown>): boolean {
  return hasNonEmptyString(value.key) && hasNonEmptyString(value.salt);
}

function hasAuthTokenPayload(value: Record<string, unknown>): boolean {
  return hasNonEmptyString(value.token);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildEncryptedCommandUrls(
  origin: string,
  encrypted: {
    encryptedCommand: string;
    encryptedSessionKey: string;
  },
): string[] {
  const base = ensureTrailingSlash(origin);
  const candidates = [
    `${base}${encrypted.encryptedCommand}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`,
  ];
  const simplifiedCommand = encrypted.encryptedCommand.replace(/^jdev\/sys\//, '');
  if (simplifiedCommand !== encrypted.encryptedCommand) {
    candidates.push(`${base}${simplifiedCommand}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`);
  }
  return candidates;
}


async function encryptCommand(
  command: string,
  publicKeyPem: string,
): Promise<{
  aesKey: string;
  aesIv: string;
  encryptedCommand: string;
  encryptedSessionKey: string;
}> {
  const salt = forge.util.bytesToHex(forge.random.getBytesSync(2));
  const plainCommand = `salt/${salt}/${command}`;
  const aesKey = forge.util.bytesToHex(forge.random.getBytesSync(32));
  const aesIv = forge.util.bytesToHex(forge.random.getBytesSync(16));
  const encryptedPayload = await aesEncryptBase64(plainCommand, aesKey, aesIv);
  const rsaPublicKey = forge.pki.publicKeyFromPem(publicKeyPem) as forge.pki.rsa.PublicKey;
  const encryptedSessionKey = forge.util.encode64(
    rsaPublicKey.encrypt(`${aesKey}:${aesIv}`, 'RSAES-PKCS1-V1_5'),
  );
  return {
    aesKey,
    aesIv,
    encryptedCommand: `jdev/sys/fenc/${encodeURIComponent(encryptedPayload)}`,
    encryptedSessionKey,
  };
}

async function aesEncryptBase64(value: string, keyHex: string, ivHex: string): Promise<string> {
  return CryptoJS.AES.encrypt(value, CryptoJS.enc.Hex.parse(keyHex), {
    iv: CryptoJS.enc.Hex.parse(ivHex),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.ZeroPadding,
  }).ciphertext.toString(CryptoJS.enc.Base64);
}

async function decryptEncryptedResponse(value: string, keyHex: string, ivHex: string): Promise<string> {
  const base64 = value.replace(/\n/g, '');
  const hex = CryptoJS.enc.Base64.parse(base64).toString(CryptoJS.enc.Hex);
  const paddedHex = hex.length % 16 > 0 ? `${hex}${'0'.repeat(16 - (hex.length % 16))}` : hex;
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Hex.parse(paddedHex),
  });
  return CryptoJS.AES.decrypt(cipherParams, CryptoJS.enc.Hex.parse(keyHex), {
    iv: CryptoJS.enc.Hex.parse(ivHex),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.ZeroPadding,
  })
    .toString(CryptoJS.enc.Utf8)
    .replace(/[\0-\x1f]+$/g, '');
}

async function tryDecryptEncryptedResponse(value: string, keyHex: string, ivHex: string): Promise<string | null> {
  try {
    return await decryptEncryptedResponse(value, keyHex, ivHex);
  } catch {
    return null;
  }
}

function normalizePublicKeyPem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('\n')) {
    return trimmed
      .replace('BEGIN CERTIFICATE', 'BEGIN PUBLIC KEY')
      .replace('END CERTIFICATE', 'END PUBLIC KEY');
  }
  const begin = '-----BEGIN CERTIFICATE-----';
  const end = '-----END CERTIFICATE-----';
  if (!trimmed.startsWith(begin) || !trimmed.endsWith(end)) {
    return trimmed;
  }
  const body = trimmed.slice(begin.length, trimmed.length - end.length);
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join('\n') ?? body}\n-----END PUBLIC KEY-----`;
}

function sanitizeAuthSegment(value: string): string {
  if (value.includes('/')) {
    throw new Error(rt('login_slash_forbidden'));
  }
  return value.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isExpired(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && /^\d+$/.test(value)) {
    return LOXONE_EPOCH_MS + numeric * 1000 <= Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? false : parsed <= Date.now();
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(rt('miniserver_unexpected_data'));
  }
  return value as Record<string, unknown>;
}

function normalizeUuid(value: string): string {
  const compact = value.trim().toLowerCase().replace(/-/g, '');
  if (compact.length !== 32) {
    return value.trim().toLowerCase();
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function safeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function asString(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(rt('loxone_missing_value'));
  }
  return text;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value > 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'on';
  }
  return false;
}

function toNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['value', 'text', 'number']) {
      if (key in record) {
        const nested = toNumberLike(record[key]);
        if (nested !== null) {
          return nested;
        }
      }
    }
  }
  return null;
}

function getNestedValue(object: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = object;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return rt('loxone_unknown_error');
}

function mapAuthBootstrapError(error: unknown, origin: string, command: string): Error {
  const target = new URL(origin);
  const publicOrigin = self.location.origin;
  if (
    target.origin !== publicOrigin &&
    error instanceof TypeError
  ) {
    return new Error(rt('loxone_auth_cors_blocked', { command, host: target.host }));
  }
  if (error instanceof Error && error.message) {
    return error;
  }
  if (target.origin !== publicOrigin) {
    return new Error(rt('loxone_auth_cors_blocked', { command, host: target.host }));
  }
  return new Error(rt('loxone_command_error', { code: 0, command }));
}

function authBootstrapOrigins(origin: string, serial: string | null): string[] {
  return socketCandidates(origin, serial).map((candidate) => candidate.origin);
}

function isAllowedTransport(origin: URL): boolean {
  return origin.protocol === 'https:' || (origin.protocol === 'http:' && self.location.protocol !== 'https:');
}

function socketCandidates(origin: string, serial: string | null): Array<{ origin: string; wsUrl: string }> {
  const normalized = new URL(ensureTrailingSlash(origin));
  if (isRemoteConnectHost(normalized.hostname)) return [];
  const smartTlsOrigin = buildSmartTlsOrigin(normalized, serial);
  const origins = smartTlsOrigin ? [smartTlsOrigin, normalized] : [normalized];
  if (
    normalized.protocol === 'https:' &&
    isLocalHost(normalized.hostname) &&
    self.location.protocol !== 'https:'
  ) {
    const fallbackOrigin = new URL(normalized.toString());
    fallbackOrigin.protocol = 'http:';
    origins.push(fallbackOrigin);
  }

  return origins.filter(isAllowedTransport).map((candidate) => {
    const socket = new URL(WS_PATH, candidate);
    socket.protocol = candidate.protocol === 'https:' ? 'wss:' : 'ws:';
    return { origin: candidate.toString().replace(/\/$/, ''), wsUrl: socket.toString() };
  });
}

function buildSmartTlsOrigin(origin: URL, serial: string | null): URL | null {
  if (self.location.protocol !== 'https:' || !isLocalHost(origin.hostname) || !serial || origin.pathname !== '/') {
    return null;
  }
  return buildCloudDnsTlsAddress(origin, serial);
}

function buildCloudDnsTlsAddress(origin: URL, serial: string): URL | null {
  if (!/^[a-z\d]{1,63}$/i.test(serial)) return null;
  if (!/^(?:(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])$/i.test(origin.hostname)) return null;
  const dashedIp = origin.hostname.replace(/^\[|\]$/g, '').replace(/[:.]/g, '-');
  const port = origin.protocol === 'https:' && origin.port ? `:${origin.port}` : '';
  return new URL(`https://${dashedIp}.${serial.toLowerCase()}.dyndns.loxonecloud.com${port}/`);
}

function describeSocketFailure(origin: string, serial: string | null): string {
  const url = new URL(origin);
  if (self.location.protocol === 'https:' && url.protocol === 'http:' && isLocalHost(url.hostname)) {
    const suggestedHost = buildSuggestedDnsHost(url, serial);
    return suggestedHost
      ? rt('socket_https_local_ws_blocked', { host: suggestedHost })
      : rt('socket_https_local_ws_blocked_generic');
  }
  if (url.protocol === 'https:' && isLocalHost(url.hostname)) {
    return rt('socket_tls_mismatch');
  }
  return rt('socket_open_failed');
}

function buildSuggestedDnsHost(origin: URL, serial: string | null): string | null {
  if (!serial || !isLocalHost(origin.hostname)) {
    return null;
  }
  return remoteConnectUrl(serial);
}
