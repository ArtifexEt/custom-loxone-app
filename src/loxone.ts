import CryptoJS from 'crypto-js';
import forge from 'node-forge';
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
const JWT_SUPPORT_VERSION = '10.1.12.11';
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

export class LoxoneClient {
  private credentials: StoredCredentials;
  private handlers: LoxoneClientHandlers;
  private hints: LoxoneConnectionHints;
  private ws: WebSocket | null = null;
  private pendingResponse:
    | {
        resolve: (value: string) => void;
        reject: (reason?: unknown) => void;
      }
    | null = null;
  private pendingHeader: PendingHeader | null = null;
  private keepaliveInterval: number | null = null;
  private reconnectTimer: number | null = null;
  private commandLock = Promise.resolve();
  private stateValues: Record<string, LoxoneStateValue> = {};
  private structure: LoxoneStructure | null = null;
  private closedManually = false;

  constructor(
    credentials: StoredCredentials,
    handlers: LoxoneClientHandlers,
    hints: LoxoneConnectionHints,
  ) {
    this.credentials = credentials;
    this.handlers = handlers;
    this.hints = hints;
  }

  updateCredentials(credentials: StoredCredentials): void {
    this.credentials = credentials;
  }

  currentResolvedOrigin(): string | null {
    return this.credentials.resolvedOrigin ?? null;
  }

  updateConnectionHints(hints: Partial<LoxoneConnectionHints>): void {
    this.hints = {
      ...this.hints,
      ...hints,
    };
  }

  async connect(forceReload = false): Promise<void> {
    this.closedManually = false;
    this.handlers.onConnecting();
    await this.disconnect(false);

    try {
      await this.ensureValidToken();
      this.ws = await this.openSocket();
      await this.authenticateSocket();
      if (forceReload || this.structure === null) {
        this.structure = await this.loadStructure();
      }
      await this.sendCommand('jdev/sps/enablebinstatusupdate');
      this.startKeepalive();
      this.handlers.onReady({
        structure: this.structure,
        stateValues: this.stateValues,
        token: this.credentials.token,
        tokenValidUntil: this.credentials.tokenValidUntil,
        resolvedOrigin: this.credentials.resolvedOrigin ?? effectiveOrigin(this.credentials),
      });
      this.handlers.onAvailabilityChanged(true, rt('miniserver_connected'));
    } catch (error) {
      const message = toErrorMessage(error);
      this.handlers.onError(message);
      await this.disconnect(false);
      throw error;
    }
  }

  async disconnect(markOffline = true): Promise<void> {
    this.stopKeepalive();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pendingResponse) {
      this.pendingResponse.reject(new Error(rt('miniserver_connection_closed')));
      this.pendingResponse = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    if (markOffline) {
      this.handlers.onAvailabilityChanged(false, rt('miniserver_connection_offline'));
    }
  }

  async sendAction(uuidAction: string, command: string): Promise<void> {
    const encodedUuid = encodeURIComponent(uuidAction);
    const encodedCommand = encodeURIComponent(command).replaceAll('%2F', '/');
    await this.sendCommand(`jdev/sps/io/${encodedUuid}/${encodedCommand}`);
  }

  async fetchSecuredDetails(uuidAction: string): Promise<Record<string, unknown>> {
    const encodedUuid = encodeURIComponent(uuidAction);
    const response = await this.sendCommand(`jdev/sps/io/${encodedUuid}/securedDetails`);
    return coerceMaybeJsonRecord(response.value);
  }

  stateSnapshot(): Record<string, LoxoneStateValue> {
    return { ...this.stateValues };
  }

  private async openSocket(): Promise<WebSocket> {
    const candidates = dedupeSocketCandidates([
      ...socketCandidates(effectiveOrigin(this.credentials), this.hints.serial),
      ...(this.credentials.resolvedOrigin && this.credentials.resolvedOrigin !== this.credentials.origin
        ? socketCandidates(this.credentials.origin, this.hints.serial)
        : []),
    ]);
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      try {
        const socket = await this.openSocketCandidate(candidate);
        this.credentials.resolvedOrigin = candidate.origin;
        return socket;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(rt('websocket_open_failed'));
      }
    }

    throw (
      lastError ??
      new Error(describeSocketFailure(effectiveOrigin(this.credentials), this.hints.serial))
    );
  }

  private async openSocketCandidate(candidate: { origin: string; wsUrl: string }): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(candidate.wsUrl, 'remotecontrol');
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        socket.onmessage = (event) => {
          void this.handleMessage(event.data);
        };
        socket.onclose = () => {
          if (!this.closedManually) {
            this.handlers.onAvailabilityChanged(false, rt('miniserver_connection_interrupted'));
            this.scheduleReconnect();
          }
        };
        socket.onerror = () => {
          this.handlers.onAvailabilityChanged(false, describeSocketFailure(candidate.origin, this.hints.serial));
        };
        resolve(socket);
      };
      socket.onerror = () => reject(new Error(describeSocketFailure(candidate.origin, this.hints.serial)));
    });
  }

  private async ensureValidToken(): Promise<void> {
    const username = sanitizeAuthSegment(this.credentials.username);
    if (this.credentials.token && !isExpired(this.credentials.tokenValidUntil)) {
      return;
    }

    const clientUuid = crypto.randomUUID();
    const tokenResult = await requestJwtToken(
      this.credentials.origin,
      this.hints.serial,
      username,
      this.credentials.password,
      clientUuid,
      'CustomLoxoneApp',
    );
    const token = asString(tokenResult.payload.token);
    this.credentials.resolvedOrigin = tokenResult.resolvedOrigin;
    this.credentials.token = token;
    this.credentials.tokenValidUntil = tokenResult.payload.validUntil
      ? String(tokenResult.payload.validUntil)
      : null;
  }

  private async authenticateSocket(): Promise<void> {
    const username = sanitizeAuthSegment(this.credentials.username);
    if (!this.credentials.token) {
      throw new Error(rt('loxone_missing_value'));
    }
    try {
      await this.sendCommand(
        `authwithtoken/${encodeURIComponent(this.credentials.token)}/${encodeURIComponent(username)}`,
      );
    } catch (error) {
      this.credentials.token = null;
      this.credentials.tokenValidUntil = null;
      throw error;
    }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(rt('websocket_not_connected'));
    }

    const operation = this.commandLock.then(
      () =>
        new Promise<string>((resolve, reject) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            reject(new Error(rt('websocket_not_connected')));
            return;
          }

          this.pendingResponse = { resolve, reject };
          this.ws.send(command);
          setTimeout(() => {
            if (this.pendingResponse?.resolve === resolve) {
              this.pendingResponse = null;
              reject(new Error(`Brak odpowiedzi dla komendy ${command}.`));
            }
          }, 20_000);
        }),
    );

    this.commandLock = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async handleMessage(data: Blob | ArrayBuffer | string): Promise<void> {
    if (typeof data === 'string') {
      this.deliverText(data);
      return;
    }

    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 8 && bytes[0] === 0x03) {
      const header = parseHeader(bytes);
      if (header.identifier === KEEPALIVE_RESPONSE) {
        return;
      }
      if (header.identifier === OUT_OF_SERVICE) {
        this.handlers.onError(rt('miniserver_out_of_service'));
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
    if (result.changed) {
      this.mergeChangedStates(result.changed);
    }
    if (this.pendingResponse && (!result.isStateUpdate || result.hasResponseCode)) {
      this.pendingResponse.resolve(payload);
      this.pendingResponse = null;
    }
  }

  private mergeChangedStates(changed: Record<string, LoxoneStateValue>): void {
    if (Object.keys(changed).length === 0) {
      return;
    }
    this.stateValues = {
      ...this.stateValues,
      ...changed,
    };
    this.handlers.onStatesChanged(changed);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveInterval = self.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('keepalive');
      }
    }, 15_000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveInterval !== null) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = self.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, 5_000);
  }
}

export function createDefaultView(
  intercomUuidAction: string | null = null,
  activityLogControlUuidAction: string | null = null,
): IntercomViewConfig {
  return {
    id: crypto.randomUUID(),
    type: 'intercom',
    title: rt('intercom_label'),
    intercomUuidAction,
    activityLogControlUuidAction,
    historyLimit: 8,
    quickTts: [
      { id: crypto.randomUUID(), label: rt('quick_tts_wait_label'), message: rt('quick_tts_wait_message') },
      { id: crypto.randomUUID(), label: rt('quick_tts_parcel_label'), message: rt('quick_tts_parcel_message') },
    ],
  };
}

export function listIntercoms(structure: LoxoneStructure): IntercomSummary[] {
  return structure.controls
    .filter(isIntercomControl)
    .map((control) => ({
      uuidAction: control.uuidAction,
      name: control.name,
      roomName: control.roomName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, localeForLanguage('pl')));
}

export function listLogSources(structure: LoxoneStructure): ActivityLogSourceSummary[] {
  return structure.controls
    .filter(isLogSourceControl)
    .map((control) => ({
      uuidAction: control.uuidAction,
      name: control.name,
      type: control.type,
      roomName: control.roomName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, localeForLanguage('pl')));
}

export function buildIntercomViewModel(
  config: IntercomViewConfig,
  structure: LoxoneStructure | null,
  stateValues: Record<string, LoxoneStateValue>,
  credentials: StoredCredentials | null,
  cachedHistoryByUuidAction: Record<string, string[]> = {},
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
  const microphoneMuted = lookupBooleanState(summary, stateValues, MUTE_STATE_CANDIDATES);
  const supportsAnswer = supportsIntercomAnswer(summary);
  const supportsMute = supportsIntercomMute(summary);
  const transport = credentials
    ? resolveIntercomTransportProfile(summary, mediaControl, stateValues, credentials)
    : {
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
  const snapshotUrl =
    transport.snapshotUrl ??
    (credentials && transport.runtimeOrigin
      ? signUrl(
          transport.runtimeOrigin,
          `camimage/${encodeURIComponent(summary.uuidAction)}`,
          credentials,
          'server',
        )
      : null);

  const nativeHistoryTokens = parseLastBellEvents(mediaControl, stateValues);
  const historyTokens = mergeHistoryTokens(nativeHistoryTokens, cachedHistoryByUuidAction[summary.uuidAction] ?? []);
  const history = credentials
    ? historyTokens.slice(0, config.historyLimit).map((timestamp) => ({
        timestamp,
        label: formatBellLabel(timestamp),
        imageUrl:
          nativeHistoryTokens.length > 0
            ? signUrl(
                transport.runtimeOrigin!,
                `camimage/${encodeURIComponent(summary.uuidAction)}/${encodeURIComponent(timestamp)}`,
                credentials,
                'server',
              )
            : signUrl(
                transport.runtimeOrigin!,
                `camimage/${encodeURIComponent(summary.uuidAction)}?event=${encodeURIComponent(timestamp)}`,
                credentials,
                'server',
              ),
      }))
    : [];

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
    deviceUuid: resolveIntercomDeviceUuid(summary),
    address: transport.addressHost,
    origin: transport.runtimeOrigin,
    authToken: credentials?.token ?? null,
    transportMode: transport.mode,
    mediaAuthMode: transport.mediaAuthMode,
    signalingUrl: transport.signalingUrl,
    mediaBaseUrl: transport.mediaBaseUrl,
    historyBaseUrl: transport.historyBaseUrl,
    mediaRootPath: transport.mediaRootPath,
    doorbellActive,
    microphoneMuted,
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

function parseLastBellEvents(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
): string[] {
  for (const stateName of Object.keys(control.states)) {
    if (normalizeText(stateName) !== 'lastbellevents') {
      continue;
    }
    return coerceLastBellEvents(stateValues[control.states[stateName]]);
  }
  for (const detailPath of HISTORY_DETAIL_PATHS) {
    const value = getNestedValue(control.details, detailPath);
    const parsed = coerceLastBellEvents(value);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
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
  const runtimeOrigin = effectiveOrigin(credentials);
  const deviceUuid = resolveIntercomDeviceUuid(control) ?? resolveIntercomDeviceUuid(mediaControl);
  const addressBase = resolveAddressBase(mediaControl, stateValues) ?? resolveAddressBase(control, stateValues);
  const addressHost = addressBase ? new URL(addressBase).host : null;

  if (addressBase && self.location.protocol !== 'https:') {
    const intercomAuth = resolveIntercomAuth(mediaControl, credentials);
    const signalingUrl = addressBase.replace(/^http/i, addressBase.startsWith('https://') ? 'wss' : 'ws');
    const mediaBaseUrl = signAbsoluteUrl(ensureTrailingSlash(addressBase), credentials, 'intercom', intercomAuth);
    return {
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

  if (runtimeOrigin && deviceUuid) {
    const rootPath = `/proxy/${encodeURIComponent(deviceUuid)}`;
    const mediaBaseUrl = `${runtimeOrigin.replace(/\/$/, '')}${rootPath}/`;
    const signalingUrl = mediaBaseUrl.replace(/^http/i, runtimeOrigin.startsWith('https://') ? 'wss' : 'ws');
    return {
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
    mode: 'none',
    mediaAuthMode: 'none',
    signalingUrl: null,
    mediaBaseUrl: null,
    historyBaseUrl: null,
    mediaRootPath: null,
    snapshotUrl: resolveConfiguredMediaUrl(mediaControl, stateValues, SNAPSHOT_DETAIL_PATHS, credentials),
    streamUrl: resolveConfiguredMediaUrl(mediaControl, stateValues, STREAM_DETAIL_PATHS, credentials),
    runtimeOrigin,
    addressHost,
  };
}

function mergeHistoryTokens(...sources: string[][]): string[] {
  const seen = new Set<string>();
  const tokens = sources
    .flat()
    .map((item) => item.trim())
    .filter(Boolean);
  tokens.sort((left, right) => historyTokenScore(right) - historyTokenScore(left));
  return tokens.filter((item) => {
    if (seen.has(item)) {
      return false;
    }
    seen.add(item);
    return true;
  });
}

function historyTokenScore(value: string): number {
  if (/^\d{14}$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function coerceLastBellEvents(value: unknown): string[] {
  if (typeof value === 'string') {
    const parts = value
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.reverse();
  }
  if (Array.isArray(value)) {
    return value.map((part) => String(part)).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return coerceLastBellEvents((value as Record<string, unknown>).value);
  }
  return [];
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
    .replaceAll('\x14', '\n')
    .replaceAll(';', '\n')
    .split(/[\r\n|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveConfiguredMediaUrl(
  control: LoxoneControl,
  stateValues: Record<string, LoxoneStateValue>,
  detailPaths: string[],
  credentials: StoredCredentials,
): string | null {
  for (const stateName of Object.keys(control.states)) {
    const tail = normalizeText(stateName);
    if (!detailPaths.some((path) => normalizeText(path.split('.').at(-1) ?? '') === tail)) {
      continue;
    }
    const value = stateValues[control.states[stateName]];
    const resolved = resolveIntercomHttpUrl(control, value, stateValues, credentials);
    if (resolved) {
      return resolved;
    }
  }
  for (const detailPath of detailPaths) {
    const value = getNestedValue(control.details, detailPath);
    const resolved = resolveIntercomHttpUrl(control, value, stateValues, credentials);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function resolveIntercomHttpUrl(
  control: LoxoneControl,
  value: unknown,
  stateValues: Record<string, LoxoneStateValue>,
  credentials: StoredCredentials,
): string | null {
  if (typeof value === 'string') {
    const rawValue = value.trim();
    if (!rawValue) {
      return null;
    }
    if (rawValue.startsWith('{') || rawValue.startsWith('[')) {
      try {
        return resolveIntercomHttpUrl(control, JSON.parse(rawValue), stateValues, credentials);
      } catch {
        return null;
      }
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveIntercomHttpUrl(control, item, stateValues, credentials);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['streamUrl', 'url', 'href', 'path', 'liveImageUrl', 'liveImage', 'alertImage', 'imageUrl', 'value']) {
      if (!(key in record)) {
        continue;
      }
      const resolved = resolveIntercomHttpUrl(control, record[key], stateValues, credentials);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  const intercomAuth = resolveIntercomAuth(control, credentials);
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const mode = pickAuthMode(raw, effectiveOrigin(credentials));
    return signAbsoluteUrl(raw, credentials, mode, mode === 'intercom' ? intercomAuth : undefined);
  }
  if (raw.startsWith('/camimage/') || raw.startsWith('camimage/')) {
    return signUrl(effectiveOrigin(credentials), raw, credentials, 'server');
  }
  if (raw.startsWith('/')) {
    return signUrl(effectiveOrigin(credentials), raw, credentials, 'server');
  }

  const addressBase = resolveAddressBase(control, stateValues);
  if (addressBase) {
    return signUrl(addressBase, raw, credentials, 'intercom', intercomAuth);
  }

  if (raw.includes('/')) {
    return signUrl(effectiveOrigin(credentials), raw, credentials, 'server');
  }
  return signUrl(effectiveOrigin(credentials), raw, credentials, 'server');
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
    return `${isPrivateHost(host) ? 'http' : 'https'}://${host}`;
  }
  return `${isPrivateHost(value) ? 'http' : 'https'}://${value}`;
}

function pickAuthMode(url: string, origin: string): 'server' | 'intercom' {
  const normalizedOrigin = new URL(origin).host;
  return new URL(url).host === normalizedOrigin ? 'server' : 'intercom';
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

function dedupeSocketCandidates(candidates: Array<{ origin: string; wsUrl: string }>): Array<{ origin: string; wsUrl: string }> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.origin}|${candidate.wsUrl}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveAuthResponseOrigin(origin: string, responseUrl: string, commandPath: string): string {
  const fallback = new URL(origin);
  const response = new URL(responseUrl, fallback);
  const commandUrl = new URL(commandPath, ensureTrailingSlash(fallback.toString()));
  const commandPathname = commandUrl.pathname;
  const commandSuffix = `/${commandPath.replace(/^\/+/, '')}`;
  const matchedSuffix = response.pathname.endsWith(commandPathname)
    ? commandPathname
    : response.pathname.endsWith(commandSuffix)
      ? commandSuffix
      : null;
  if (matchedSuffix) {
    const trimmedPath = response.pathname.slice(0, response.pathname.length - matchedSuffix.length);
    response.pathname = trimmedPath || '/';
  }
  response.search = '';
  response.hash = '';
  return response.toString().replace(/\/$/, '');
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
    const paddedLength = (textLength + 3) & ~0x03;
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
        throw new Error(rt('loxone_bad_credentials'));
      }
      if (code >= 400) {
        throw new Error(rt('loxone_command_error', { code, command }));
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

async function hashPassword(password: string, salt: string, hashAlgorithm: string): Promise<string> {
  const payload = new TextEncoder().encode(`${password}:${salt}`);
  const hash = await crypto.subtle.digest(hashAlgorithm.includes('256') ? 'SHA-256' : 'SHA-1', payload);
  return arrayBufferToHex(hash).toUpperCase();
}

async function hmacUserHash(
  user: string,
  passwordHash: string,
  keyHex: string,
  hashAlgorithm: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    bytesToArrayBuffer(hexToBytes(keyHex)),
    {
      name: 'HMAC',
      hash: hashAlgorithm.includes('256') ? 'SHA-256' : 'SHA-1',
    },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${user}:${passwordHash}`),
  );
  return arrayBufferToHex(signature);
}

function arrayBufferToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized.length % 2 !== 0) {
    throw new Error(rt('invalid_hmac_key'));
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function requestJwtToken(
  origin: string,
  serial: string | null,
  username: string,
  password: string,
  clientUuid: string,
  clientInfo: string,
): Promise<{ origin: string; resolvedOrigin: string; payload: Record<string, unknown> }> {
  const candidates = authBootstrapOrigins(origin, serial);
  let lastError: unknown = null;

  for (const candidateOrigin of candidates) {
    try {
      const { publicKeyPem, resolvedOrigin } = await fetchPublicKey(candidateOrigin);
      const tokenSalts = await requestEncryptedValue(
        resolvedOrigin,
        `jdev/sys/getkey2/${encodeURIComponent(username)}`,
        publicKeyPem,
      );
      const key = asString(tokenSalts.key);
      const salt = asString(tokenSalts.salt);
      const hashAlg = asString(tokenSalts.hashAlg ?? 'SHA1').toUpperCase();
      const passwordHash = await hashPassword(password, salt, hashAlg);
      const userHash = await hmacUserHash(username, passwordHash, key, hashAlg);
      const tokenPath = supportsVersion(JWT_SUPPORT_VERSION, null) ? 'jdev/sys/getjwt/' : 'jdev/sys/gettoken/';
      const payload = await requestEncryptedValue(
        resolvedOrigin,
        `${tokenPath}${userHash}/${encodeURIComponent(username)}/${TOKEN_PERMISSION_APP}/${encodeURIComponent(clientUuid)}/${encodeURIComponent(clientInfo)}`,
        publicKeyPem,
      );
      return {
        origin: candidateOrigin,
        resolvedOrigin,
        payload,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw (lastError instanceof Error ? lastError : new Error(rt('loxone_unknown_error')));
}

async function fetchPublicKey(origin: string): Promise<{ publicKeyPem: string; resolvedOrigin: string }> {
  try {
    const response = await fetch(new URL('jdev/sys/getPublicKey', ensureTrailingSlash(origin)), {
      method: 'GET',
    });
    const payload = parseCommandPayload(await response.text(), 'jdev/sys/getPublicKey');
    return {
      publicKeyPem: normalizePublicKeyPem(asString(payload.value)),
      resolvedOrigin: resolveAuthResponseOrigin(origin, response.url, 'jdev/sys/getPublicKey'),
    };
  } catch (error) {
    throw mapAuthBootstrapError(error, origin, 'jdev/sys/getPublicKey');
  }
}

export async function resolveRuntimeOrigin(origin: string, serial: string | null): Promise<string | null> {
  const candidates = authBootstrapOrigins(origin, serial);
  for (const candidateOrigin of candidates) {
    try {
      const { resolvedOrigin } = await fetchPublicKey(candidateOrigin);
      return resolvedOrigin;
    } catch {
      // Keep background probing silent.
    }
  }
  return null;
}

async function requestEncryptedValue(
  origin: string,
  command: string,
  publicKeyPem: string,
): Promise<Record<string, unknown>> {
  const encrypted = await encryptCommand(command, publicKeyPem);
  try {
    const response = await fetch(buildEncryptedCommandUrl(origin, encrypted), {
      method: 'GET',
    });
    const rawResponse = await response.text();
    const decrypted = await tryDecryptEncryptedResponse(rawResponse, encrypted.aesKey, encrypted.aesIv);
    const payload = parseCommandPayload(decrypted ?? rawResponse, command);
    return coerceMaybeJsonRecord(payload.value);
  } catch (error) {
    throw mapAuthBootstrapError(error, origin, command);
  }
}

function buildEncryptedCommandUrl(
  origin: string,
  encrypted: {
    encryptedCommand: string;
    encryptedSessionKey: string;
  },
): string {
  const base = ensureTrailingSlash(origin);
  return `${base}${encrypted.encryptedCommand}?sk=${encodeURIComponent(encrypted.encryptedSessionKey)}`;
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
  const aesKey = forge.pkcs5.pbkdf2(
    forge.util.bytesToHex(forge.random.getBytesSync(36)),
    forge.random.getBytesSync(16),
    50,
    32,
  );
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

function supportsVersion(minimum: string, current: string | null): boolean {
  if (!current) {
    return true;
  }
  const left = minimum.split('.').map((part) => Number.parseInt(part, 10));
  const right = current.split('.').map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (rightValue > leftValue) {
      return true;
    }
    if (rightValue < leftValue) {
      return false;
    }
  }
  return true;
}

function sanitizeAuthSegment(value: string): string {
  if (value.includes('/')) {
    throw new Error(rt('login_slash_forbidden'));
  }
  return value.trim();
}

function isExpired(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && /^\d+$/.test(value)) {
    return numeric * 1000 <= Date.now();
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
  const compact = value.trim().toLowerCase().replaceAll('-', '');
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

function formatBellLabel(timestamp: string): string {
  if (/^\d{14}$/.test(timestamp)) {
    const year = timestamp.slice(0, 4);
    const month = timestamp.slice(4, 6);
    const day = timestamp.slice(6, 8);
    const hours = timestamp.slice(8, 10);
    const minutes = timestamp.slice(10, 12);
    return `${day}.${month}.${year} ${hours}:${minutes}`;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }
  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
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
  const candidates = socketCandidates(origin, serial);
  const orderedOrigins = candidates.map((candidate) => candidate.origin);
  const normalizedOrigin = new URL(origin).toString().replace(/\/$/, '');
  if (!orderedOrigins.includes(normalizedOrigin)) {
    orderedOrigins.push(normalizedOrigin);
  }
  return orderedOrigins;
}

function socketCandidates(origin: string, serial: string | null): Array<{ origin: string; wsUrl: string }> {
  const normalized = new URL(origin);
  const candidates: Array<{ origin: string; wsUrl: string }> = [];

  const smartTlsOrigin = buildSmartTlsOrigin(normalized, serial);
  if (smartTlsOrigin) {
    const smartTlsWs = new URL(WS_PATH, smartTlsOrigin);
    smartTlsWs.protocol = 'wss:';
    candidates.push({
      origin: smartTlsOrigin.toString().replace(/\/$/, ''),
      wsUrl: smartTlsWs.toString(),
    });
  }

  const primary = new URL(WS_PATH, normalized);
  primary.protocol = normalized.protocol === 'https:' ? 'wss:' : 'ws:';
  candidates.push({ origin: normalized.toString().replace(/\/$/, ''), wsUrl: primary.toString() });

  if (
    normalized.protocol === 'https:' &&
    isPrivateHost(normalized.hostname) &&
    self.location.protocol !== 'https:'
  ) {
    const fallbackOrigin = new URL(normalized.toString());
    fallbackOrigin.protocol = 'http:';
    const fallbackWs = new URL(WS_PATH, fallbackOrigin);
    fallbackWs.protocol = 'ws:';
    candidates.push({
      origin: fallbackOrigin.toString().replace(/\/$/, ''),
      wsUrl: fallbackWs.toString(),
    });
  }

  return candidates;
}

function buildSmartTlsOrigin(origin: URL, serial: string | null): URL | null {
  if (self.location.protocol !== 'https:' || origin.protocol !== 'http:' || !isPrivateHost(origin.hostname) || !serial) {
    return null;
  }

  return buildCloudDnsOrigin(serial);
}

function describeSocketFailure(origin: string, serial: string | null): string {
  const url = new URL(origin);
  if (self.location.protocol === 'https:' && url.protocol === 'http:' && isPrivateHost(url.hostname)) {
    const suggestedHost = buildSuggestedDnsHost(url, serial);
    return suggestedHost
      ? rt('socket_https_local_ws_blocked', { host: suggestedHost })
      : rt('socket_https_local_ws_blocked_generic');
  }
  if (url.protocol === 'https:' && isPrivateHost(url.hostname)) {
    return rt('socket_tls_mismatch');
  }
  return rt('socket_open_failed');
}

function buildSuggestedDnsHost(origin: URL, serial: string | null): string | null {
  if (!serial || !isPrivateHost(origin.hostname)) {
    return null;
  }
  return buildCloudDnsOrigin(serial)?.toString().replace(/\/$/, '') ?? null;
}

function buildCloudDnsOrigin(serial: string): URL | null {
  const normalizedSerial = serial.trim().toUpperCase();
  if (!normalizedSerial) {
    return null;
  }
  return new URL(`https://dns.loxonecloud.com/${encodeURIComponent(normalizedSerial)}/`);
}

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    return true;
  }
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
