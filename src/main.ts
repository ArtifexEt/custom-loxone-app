import './styles.css';
import CryptoJS from 'crypto-js';
import forge from 'node-forge';
import { loadMediaCacheEntry, saveMediaCacheEntry } from './storage';
import { localeForLanguage, setRuntimeLanguage, t } from './translations';
import type {
  ActivityLogItem,
  AppLanguage,
  AppViewModel,
  IntercomViewConfig,
  IntercomHistoryItem,
  MainToWorkerMessage,
  QuickTtsPhrase,
  WorkerToMainMessage,
} from './types';

const worker = new Worker(new URL('./app.worker.ts', import.meta.url), { type: 'module' });
const rootElement = document.querySelector<HTMLDivElement>('#app');

if (!rootElement) {
  throw new Error('Missing app root container.');
}

const root = rootElement;
type SidePanelTab = 'history' | 'log';
type BrowserConversationState = 'idle' | 'starting' | 'active' | 'error';
type IntercomPanelMode = 'actions' | 'tts' | null;
const TRANSPARENT_1PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

let state: AppViewModel = {
  screen: 'loading',
  settingsOpen: false,
  settingsMode: null,
  language: 'pl',
  languageOverride: null,
  connection: { status: 'idle' },
  notice: null,
  serverForm: {
    origin: '',
    serial: null,
    username: '',
    passwordStored: false,
  },
  miniserverName: null,
  lastSyncedAt: null,
  views: [],
  intercoms: [],
  logSources: [],
  activeViewId: null,
  settingsEditorViewId: null,
  currentEditorView: null,
  currentView: null,
};
let sidePanelOpen = false;
let sidePanelTab: SidePanelTab = 'history';
let intercomPanelMode: IntercomPanelMode = null;
let browserConversationState: BrowserConversationState = 'idle';
let browserConversationMessage = '';
let browserConversationAttempt = 0;
let selectedHistoryImage: IntercomHistoryItem | null = null;
let savedMessagesDialogViewId: string | null = null;
let selectedSavedMessageId: string | null = null;
let localMicrophoneStream: MediaStream | null = null;
let localViewDraft: IntercomViewConfig | null = null;
let localServerDraft: {
  origin: string;
  serial: string;
  username: string;
  password: string;
  passwordStored: boolean;
} | null = null;
let browserHistoryByIntercomUuidAction = new Map<string, IntercomHistoryItem[]>();
let historyImageCache = new Map<string, string>();
let failedHistoryImageLoads = new Set<string>();
let pendingHistoryImageCacheReads = new Set<string>();
let pendingHistoryImageCacheWrites = new Set<string>();
let activeHistoryIntercomKey: string | null = null;
let historyDrawerScrollTop = 0;
let historyDrawerViewportHeight = 0;
let historyVirtualWindowKey = '';
let pendingFocusSelector: string | null = null;
let deferredRenderRequested = false;
let rtcPlaybackRetryTimer: number | null = null;
let lastRapidActionSignature = '';
let lastRapidActionAt = 0;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

const HISTORY_DRAWER_GAP = 12;
const HISTORY_DRAWER_OVERSCAN_ROWS = 2;
const HISTORY_CARD_HEIGHT_DESKTOP = 196;
const HISTORY_CARD_HEIGHT_MOBILE = 236;
const RTC_PREVIEW_STALL_MS = 8000;
const INTERCOM_AUDIO_UNSUPPORTED_ERROR = '__INTERCOM_AUDIO_UNSUPPORTED__';
const INTERCOM_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.loxonecloud.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

type CurrentIntercom = NonNullable<NonNullable<AppViewModel['currentView']>['intercom']>;

function tr<Key extends Parameters<typeof t>[1]>(
  key: Key,
  params?: Parameters<typeof t>[2],
): string {
  return t(state.language, key, params);
}

class IntercomRtcSession {
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private remoteStream: MediaStream | null = null;
  private conversationEnabled = false;
  private authReady: Promise<void> | null = null;
  private resolveAuthReady: (() => void) | null = null;
  private rejectAuthReady: ((reason?: unknown) => void) | null = null;
  private commandId = 1000;
  private pendingCommands = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private currentIntercomKey: string | null = null;
  private currentSocketUrl: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private retryTimer: number | null = null;
  private previewDeadlineTimer: number | null = null;
  private previewStartAt: number | null = null;
  private firstRenderedVideoFrameAt: number | null = null;
  private remoteVideoTrackSeen = false;
  private historyLoadedForKey: string | null = null;
  private historyLoadingForKey: string | null = null;

  hasRemoteStreamFor(uuidAction: string): boolean {
    return this.currentIntercomKey === uuidAction && this.hasIncomingVideo();
  }

  hasPendingSessionFor(uuidAction: string): boolean {
    return this.currentIntercomKey === uuidAction && this.isPeerSessionPending();
  }

  hasRemoteTrackFor(uuidAction: string): boolean {
    return this.currentIntercomKey === uuidAction && this.remoteVideoTrackSeen;
  }

  isConversationEnabledFor(uuidAction: string): boolean {
    return this.currentIntercomKey === uuidAction && this.conversationEnabled;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  noteRenderedVideoFrame(): boolean {
    const firstFrame = this.firstRenderedVideoFrameAt === null;
    this.firstRenderedVideoFrameAt = Date.now();
    if (firstFrame) {
      this.clearPreviewDeadline();
    }
    return firstFrame;
  }

  async ensurePreview(intercom: CurrentIntercom, localAudioStream: MediaStream | null = null): Promise<void> {
    const wantsConversation = Boolean(localAudioStream?.getAudioTracks().length);
    if (this.connectPromise) {
      await this.connectPromise.catch(() => {
        // Let the follow-up attempt decide whether another retry is needed.
      });
      if (
        this.currentIntercomKey !== intercom.uuidAction ||
        this.conversationEnabled !== wantsConversation ||
        !this.hasIncomingVideo()
      ) {
        return this.ensurePreview(intercom, localAudioStream);
      }
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.ensurePreviewInternal(intercom, localAudioStream).finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.clearRetry();
    await this.teardown();
  }

  private async ensurePreviewInternal(intercom: CurrentIntercom, localAudioStream: MediaStream | null): Promise<void> {
    const signalingUrls = resolveIntercomSignalingUrls(intercom);
    if (signalingUrls.length === 0 || !intercom.authToken || !intercom.deviceUuid) {
      throw new Error(tr('signaling_data_missing'));
    }

    const wantsConversation = Boolean(localAudioStream?.getAudioTracks().length);
    const intercomChanged = this.currentIntercomKey !== intercom.uuidAction;
    const modeChanged = this.conversationEnabled !== wantsConversation;
    if (intercomChanged || modeChanged) {
      await this.teardown();
      this.currentIntercomKey = intercom.uuidAction;
      this.conversationEnabled = wantsConversation;
      this.historyLoadedForKey = null;
      this.historyLoadingForKey = null;
    }

    let lastError: unknown = null;
    for (const signalingUrl of signalingUrls) {
      try {
        if (this.currentSocketUrl !== signalingUrl || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
          await this.teardown();
          this.currentIntercomKey = intercom.uuidAction;
          this.currentSocketUrl = signalingUrl;
        }
        await this.ensureAuthorized(intercom, signalingUrl);
        if (this.peer && this.hasIncomingVideo()) {
          this.clearRetry();
          this.clearPreviewDeadline();
          attachRtcStreamToDom();
          void this.refreshHistory(intercom);
          return;
        }
        if (this.peer && this.isPeerSessionPending()) {
          this.clearRetry();
          attachRtcStreamToDom();
          void this.refreshHistory(intercom);
          return;
        }
        if (this.peer) {
          await this.teardown();
          this.currentIntercomKey = intercom.uuidAction;
          this.currentSocketUrl = signalingUrl;
          this.conversationEnabled = wantsConversation;
          await this.ensureAuthorized(intercom, signalingUrl);
        }
        await this.startVideo(localAudioStream);
        this.clearRetry();
        void this.refreshHistory(intercom);
        return;
      } catch (error) {
        lastError = error;
        await this.teardown();
        this.currentIntercomKey = intercom.uuidAction;
        this.conversationEnabled = wantsConversation;
      }
    }

    this.scheduleRetry(intercom.uuidAction);
    throw (lastError instanceof Error ? lastError : new Error(tr('signaling_open_failed')));
  }

  private async ensureAuthorized(intercom: CurrentIntercom, signalingUrl: string): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.authReady) {
      await this.authReady;
      return;
    }
    this.authReady = new Promise<void>((resolve, reject) => {
      this.resolveAuthReady = resolve;
      this.rejectAuthReady = reject;
    });
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(signalingUrl, 'webrtc-signaling');
      this.socket = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(tr('signaling_open_failed')));
      socket.onclose = () => {
        this.rejectAllPending(new Error(tr('signaling_closed')));
        if (this.rejectAuthReady) {
          this.rejectAuthReady(new Error(tr('signaling_closed')));
        }
        this.resolveAuthReady = null;
        this.rejectAuthReady = null;
        this.authReady = null;
        this.socket = null;
        const peerHealthy = this.hasIncomingVideo() || this.isPeerSessionPending();
        if (!peerHealthy) {
          this.peer = null;
          this.remoteStream = null;
        }
        if (this.currentIntercomKey && !peerHealthy) {
          this.scheduleRetry(this.currentIntercomKey);
        }
        render();
      };
      socket.onmessage = (event) => {
        void this.handleMessage(event.data, intercom);
      };
    });
    await this.authReady;
  }

  private async handleMessage(rawData: unknown, intercom: CurrentIntercom): Promise<void> {
    const payload = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData as ArrayBuffer);
    const message = JSON.parse(payload) as {
      id?: number;
      method?: string;
      params?: unknown[];
      result?: { data?: unknown };
      error?: { message?: string };
    };

    if (typeof message.method === 'string' && typeof message.id === 'number') {
      await this.handleRpcCall(
        {
          id: message.id,
          method: message.method,
          params: message.params,
        },
        intercom,
      );
      return;
    }

    if (typeof message.method === 'string') {
      if (message.method === 'ready') {
        this.resolveAuthReady?.();
        this.resolveAuthReady = null;
        this.rejectAuthReady = null;
        return;
      }
      await this.handleRpcCall(
        {
          id: null,
          method: message.method,
          params: message.params,
        },
        intercom,
      );
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pendingCommands.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingCommands.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? tr('signaling_error')));
        return;
      }
      pending.resolve(message.result?.data);
    }
  }

  private async handleRpcCall(
    message: { id: number | null; method: string; params?: unknown[] },
    intercom: CurrentIntercom,
  ): Promise<void> {
    const respondOk = (data?: unknown) => {
      if (message.id === null) {
        return;
      }
      this.sendRaw({
        jsonrpc: '2.0',
        result: {
          code: 200,
          message: 'Ok',
          ...(data === undefined ? {} : { data }),
        },
        id: message.id,
      });
    };

    if (message.method === 'authenticate') {
      const params = Array.isArray(message.params) ? message.params : [];
      const [sessionToken, modulus, exponent, publicKey] = params;
      const authPayload = await buildIntercomAuthenticationPayload({
        username: state.serverForm.username,
        token: intercom.authToken,
        sessionToken: String(sessionToken ?? ''),
        modulus: typeof modulus === 'string' ? modulus : null,
        exponent: typeof exponent === 'string' ? exponent : null,
        publicKey: typeof publicKey === 'string' ? publicKey : null,
      });
      respondOk(authPayload);
      return;
    }

    if (message.method === 'addIceCandidate') {
      const params = Array.isArray(message.params) ? message.params : [];
      const candidate: RTCIceCandidateInit =
        typeof params[0] === 'object' && params[0] !== null
          ? (params[0] as RTCIceCandidateInit)
          : {
              candidate: String(params[0] ?? ''),
              sdpMLineIndex:
                typeof params[1] === 'number'
                  ? params[1]
                  : Number.isFinite(Number(params[1]))
                    ? Number(params[1])
                    : null,
              sdpMid: typeof params[2] === 'string' ? params[2] : null,
              usernameFragment: typeof params[3] === 'string' ? params[3] : null,
            };
      if (this.peer?.remoteDescription) {
        await this.peer.addIceCandidate(candidate);
      } else {
        this.pendingRemoteCandidates.push(candidate);
      }
      respondOk();
      return;
    }

    if (message.method === 'reachMode' || message.method === 'info' || message.method === 'callState') {
      respondOk();
      return;
    }

    // Intercom signaling can invoke benign client RPCs that do not require
    // local handling. Rejecting them tears down the RTC bootstrap, so keep the
    // session permissive unless a method really needs client-side work.
    respondOk();
  }

  private async startVideo(localAudioStream: MediaStream | null, allowAudioFallback = true): Promise<void> {
    const wantsConversation = Boolean(localAudioStream?.getAudioTracks().length);
    const localAudioTrack = localAudioStream?.getAudioTracks()[0] ?? null;
    this.remoteStream = new MediaStream();
    this.remoteVideoTrackSeen = false;
    this.previewStartAt = Date.now();
    this.firstRenderedVideoFrameAt = null;
    this.peer = new RTCPeerConnection({
      iceServers: INTERCOM_ICE_SERVERS,
      iceCandidatePoolSize: 4,
    });
    this.pendingRemoteCandidates = [];
    this.armPreviewDeadline();

    this.peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (event.track?.kind === 'video') {
        this.remoteVideoTrackSeen = true;
      }
      if (stream) {
        this.remoteStream = stream;
      } else if (this.remoteStream) {
        this.remoteStream.addTrack(event.track);
      }
      attachRtcStreamToDom();
      render();
    };

    this.peer.onconnectionstatechange = () => {
      if (!this.peer) {
        return;
      }
      if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'disconnected') {
        if (this.currentIntercomKey) {
          this.scheduleRetry(this.currentIntercomKey);
        }
      }
      render();
    };

    this.peer.oniceconnectionstatechange = () => {
      if (!this.peer) {
        return;
      }
      if (this.peer.iceConnectionState === 'failed' || this.peer.iceConnectionState === 'disconnected') {
        if (this.currentIntercomKey) {
          this.scheduleRetry(this.currentIntercomKey);
        }
      }
      render();
    };

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        void this.request('addIceCandidate', [
          event.candidate.candidate,
          event.candidate.sdpMLineIndex,
          event.candidate.sdpMid,
          event.candidate.usernameFragment,
        ]).catch(() => {
          // Candidate ACKs can race with reconnects and are safe to ignore.
        });
        return;
      }
      this.sendRaw({
        jsonrpc: '2.0',
        method: 'iceGatheringFinished',
      });
    };

    this.peer.addTransceiver('video', { direction: 'recvonly' });
    if (localAudioTrack) {
      const audioTransceiver = this.peer.addTransceiver('audio', {
        direction: 'sendrecv',
      });
      await audioTransceiver.sender.replaceTrack(localAudioTrack);
    }
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    let rawAnswer: unknown;
    try {
      rawAnswer = await this.request('call', [
        this.peer.localDescription,
        'new',
        wantsConversation,
        0,
      ]);
    } catch (error) {
      const message = toErrorMessage(error);
      const shouldFallback =
        wantsConversation &&
        allowAudioFallback &&
        message.includes(tr('signaling_timeout', { method: 'call' }));
      if (!shouldFallback) {
        throw error;
      }
      await this.teardown();
      await this.startVideo(null, false);
      throw new Error(INTERCOM_AUDIO_UNSUPPORTED_ERROR);
    }
    const answer = normalizeRtcAnswer(rawAnswer);
    if (!answer?.sdp) {
      throw new Error(tr('intercom_no_sdp'));
    }
    try {
      await this.peer.setRemoteDescription(answer);
    } catch (error) {
      const message = toErrorMessage(error);
      const shouldFallback = wantsConversation && allowAudioFallback && /m-?lines?/i.test(message);
      if (!shouldFallback) {
        throw error;
      }
      await this.teardown();
      await this.startVideo(null, false);
      throw new Error(INTERCOM_AUDIO_UNSUPPORTED_ERROR);
    }
    for (const candidate of this.pendingRemoteCandidates.splice(0)) {
      await this.peer.addIceCandidate(candidate);
    }
    attachRtcStreamToDom();
    render();
  }

  private async refreshHistory(intercom: CurrentIntercom): Promise<void> {
    if (this.historyLoadedForKey === intercom.uuidAction || this.historyLoadingForKey === intercom.uuidAction) {
      return;
    }
    this.historyLoadingForKey = intercom.uuidAction;
    try {
      const response = await this.request('getLastActivities', [0, 100, 2]);
      const items = mapIntercomActivitiesToHistory(response, intercom);
      if (items.length > 0) {
        browserHistoryByIntercomUuidAction.set(intercom.uuidAction, items);
      }
      this.historyLoadedForKey = intercom.uuidAction;
      render();
    } catch {
      // Keep existing fallback history from worker.
    } finally {
      if (this.historyLoadingForKey === intercom.uuidAction) {
        this.historyLoadingForKey = null;
      }
    }
  }

  private request(method: string, params?: unknown[]): Promise<unknown> {
    const id = this.commandId++;
    this.sendRaw({
      jsonrpc: '2.0',
      method,
      params,
      id,
    });
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });
      window.setTimeout(() => {
        const pending = this.pendingCommands.get(id);
        if (!pending) {
          return;
        }
        this.pendingCommands.delete(id);
        reject(new Error(tr('signaling_timeout', { method })));
      }, 10000);
    });
  }

  private sendRaw(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  private async teardown(): Promise<void> {
    this.rejectAllPending(new Error(tr('session_reset')));
    this.clearPreviewDeadline();
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onicecandidate = null;
      this.peer.close();
      this.peer = null;
    }
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
      this.socket = null;
    }
    this.remoteStream = null;
    this.pendingRemoteCandidates = [];
    this.currentIntercomKey = null;
    this.currentSocketUrl = null;
    this.conversationEnabled = false;
    this.previewStartAt = null;
    this.authReady = null;
    this.resolveAuthReady = null;
    this.rejectAuthReady = null;
    this.firstRenderedVideoFrameAt = null;
    this.remoteVideoTrackSeen = false;
    this.historyLoadingForKey = null;
  }

  private hasIncomingVideo(): boolean {
    return this.firstRenderedVideoFrameAt !== null;
  }

  private hasRemoteVideoTrack(): boolean {
    return Boolean(this.remoteStream && this.remoteStream.getVideoTracks().length > 0);
  }

  private isPeerSessionPending(): boolean {
    if (!this.peer) {
      return false;
    }
    if (this.hasIncomingVideo()) {
      return false;
    }
    const { connectionState, iceConnectionState, signalingState } = this.peer;
    if (connectionState === 'failed' || connectionState === 'closed') {
      return false;
    }
    if (iceConnectionState === 'failed' || iceConnectionState === 'closed') {
      return false;
    }
    if (this.previewStartAt && Date.now() - this.previewStartAt > RTC_PREVIEW_STALL_MS) {
      return false;
    }
    if (this.hasRemoteVideoTrack()) {
      return true;
    }
    return (
      connectionState === 'new' ||
      connectionState === 'connecting' ||
      iceConnectionState === 'new' ||
      iceConnectionState === 'checking' ||
      signalingState === 'have-local-offer' ||
      signalingState === 'have-remote-offer'
    );
  }

  private scheduleRetry(uuidAction: string): void {
    if (this.retryTimer !== null) {
      return;
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      const intercom = state.currentView?.intercom;
      if (!intercom || intercom.uuidAction !== uuidAction) {
        return;
      }
      const rtcAudioStream =
        browserConversationState === 'active' || browserConversationState === 'starting'
          ? localMicrophoneStream
          : null;
      void this.ensurePreview(intercom, rtcAudioStream).catch(() => {
        // Keep existing fallback UI; retry stays best-effort.
      });
    }, 3000);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private armPreviewDeadline(): void {
    const uuidAction = this.currentIntercomKey;
    this.clearPreviewDeadline();
    this.previewDeadlineTimer = window.setTimeout(() => {
      this.previewDeadlineTimer = null;
      if (!uuidAction || this.hasIncomingVideo()) {
        return;
      }
      void this.teardown().finally(() => {
        this.currentIntercomKey = uuidAction;
        this.scheduleRetry(uuidAction);
        render();
      });
    }, RTC_PREVIEW_STALL_MS);
  }

  private clearPreviewDeadline(): void {
    if (this.previewDeadlineTimer !== null) {
      window.clearTimeout(this.previewDeadlineTimer);
      this.previewDeadlineTimer = null;
    }
  }
}

const intercomRtcSession = new IntercomRtcSession();

worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
  if (event.data.type !== 'state') {
    return;
  }
  state = event.data.state;
  setRuntimeLanguage(state.language);
  syncLocalViewDraft();
  const nextIntercomKey = state.currentView?.intercom?.uuidAction ?? null;
  if (nextIntercomKey !== activeHistoryIntercomKey) {
    activeHistoryIntercomKey = nextIntercomKey;
    historyImageCache = new Map();
    failedHistoryImageLoads = new Set();
    pendingHistoryImageCacheReads = new Set();
    pendingHistoryImageCacheWrites = new Set();
    historyDrawerScrollTop = 0;
    historyDrawerViewportHeight = 0;
    historyVirtualWindowKey = '';
  }
  if (!state.currentView?.intercom) {
    sidePanelOpen = false;
    intercomPanelMode = null;
    selectedHistoryImage = null;
    stopBrowserConversation(false, false);
    void intercomRtcSession.disconnect();
  }
  render();
};

worker.onerror = () => {
  renderMarkup(
    `<main class="shell"><section class="panel error-card"><h1>Błąd workera</h1><p>Nie udało się uruchomić logiki aplikacji. Odśwież stronę i sprawdź konsolę przeglądarki.</p></section></main>`,
  );
};

function rapidActionSignature(actionElement: HTMLElement): string {
  return [
    actionElement.dataset.action ?? '',
    actionElement.dataset.viewId ?? '',
    actionElement.dataset.panel ?? '',
    actionElement.dataset.messageId ?? '',
  ].join('|');
}

function shouldHandleRapidAction(actionElement: HTMLElement): boolean {
  const signature = rapidActionSignature(actionElement);
  const now = Date.now();
  if (signature === lastRapidActionSignature && now - lastRapidActionAt < 450) {
    return false;
  }
  lastRapidActionSignature = signature;
  lastRapidActionAt = now;
  return true;
}

root.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement;
  const actionElement = target.closest<HTMLElement>('[data-action]');
  if (!actionElement) {
    return;
  }
  const action = actionElement.dataset.action;
  if (
    action !== 'connect-toggle' &&
    action !== 'open-saved-messages' &&
    action !== 'close-saved-messages' &&
    action !== 'select-saved-message' &&
    action !== 'confirm-saved-message'
  ) {
    return;
  }
  if (!shouldHandleRapidAction(actionElement)) {
    return;
  }
  event.preventDefault();
  handleUiAction(actionElement);
});

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const actionElement = target.closest<HTMLElement>('[data-action]');
  if (!actionElement) {
    return;
  }
  const action = actionElement.dataset.action;
  if (
    action === 'open-saved-messages' ||
    action === 'close-saved-messages' ||
    action === 'select-saved-message' ||
    action === 'confirm-saved-message'
  ) {
    return;
  }

  if (action === 'connect-toggle') {
    if (!shouldHandleRapidAction(actionElement)) {
      return;
    }
    handleUiAction(actionElement);
    return;
  }

  handleUiAction(actionElement);
});

function handleUiAction(actionElement: HTMLElement): void {
  switch (actionElement.dataset.action) {
    case 'show-app-settings':
      post({ type: 'showAppSettings' });
      return;
    case 'show-view-settings':
      post({ type: 'showViewSettings', viewId: actionElement.dataset.viewId });
      return;
    case 'close-settings':
      void closeSettingsOverlay();
      return;
    case 'toggle-side-panel':
      if (sidePanelOpen) {
        prepareSidePanelCloseFocus();
      }
      sidePanelOpen = !sidePanelOpen;
      render();
      return;
    case 'open-side-panel':
      sidePanelOpen = true;
      sidePanelTab = (actionElement.dataset.tab as SidePanelTab) || 'history';
      render();
      return;
    case 'close-side-panel':
      prepareSidePanelCloseFocus();
      sidePanelOpen = false;
      render();
      return;
    case 'open-history-image': {
      const timestamp = actionElement.dataset.timestamp ?? '';
      const intercom = state.currentView?.intercom;
      if (!intercom) {
        return;
      }
      const historyItems = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
      if (actionElement instanceof HTMLButtonElement) {
        actionElement.blur();
      }
      selectedHistoryImage = historyItems.find((item) => item.timestamp === timestamp) ?? null;
      sidePanelOpen = false;
      pendingFocusSelector = '[data-action="close-history-image"]';
      render();
      return;
    }
    case 'close-history-image':
      selectedHistoryImage = null;
      pendingFocusSelector = null;
      render();
      return;
    case 'history-image-prev': {
      const adjacent = getAdjacentHistoryImage(-1);
      if (adjacent) {
        selectedHistoryImage = adjacent;
        render();
      }
      return;
    }
    case 'history-image-next': {
      const adjacent = getAdjacentHistoryImage(1);
      if (adjacent) {
        selectedHistoryImage = adjacent;
        render();
      }
      return;
    }
    case 'toggle-intercom-panel': {
      const panel = (actionElement.dataset.panel as IntercomPanelMode) || null;
      intercomPanelMode = intercomPanelMode === panel ? null : panel;
      render();
      return;
    }
    case 'close-intercom-panel':
      intercomPanelMode = null;
      render();
      return;
    case 'select-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'selectView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'add-intercom-view':
      post({ type: 'addIntercomView' });
      return;
    case 'configure-intercom-view':
      post({ type: 'configureIntercomView' });
      return;
    case 'edit-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'editView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'delete-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'deleteView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'set-default-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'setDefaultView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'run-child-function':
      if (actionElement.dataset.viewId && actionElement.dataset.functionUuidAction) {
        post({
          type: 'sendChildFunction',
          viewId: actionElement.dataset.viewId,
          functionUuidAction: actionElement.dataset.functionUuidAction,
        });
      }
      return;
    case 'connect-toggle':
      if (actionElement.dataset.viewId) {
        const intercom = state.currentView?.intercom ?? null;
        if (intercom && isIntercomConversationActive(intercom)) {
          stopBrowserConversation(true);
        } else {
          void handleConnect(actionElement.dataset.viewId);
        }
      }
      return;
    case 'mute':
    case 'unmute':
      if (actionElement.dataset.viewId) {
        post({
          type: 'runBuiltInAction',
          viewId: actionElement.dataset.viewId,
          action: actionElement.dataset.action as 'connect' | 'mute' | 'unmute',
        });
      }
      return;
    case 'dismiss-notice':
      post({ type: 'dismissNotice' });
      return;
    case 'open-saved-messages':
      if (actionElement.dataset.viewId) {
        openSavedMessagesDialog(actionElement.dataset.viewId);
      }
      return;
    case 'close-saved-messages':
      closeSavedMessagesDialog();
      render();
      return;
    case 'select-saved-message':
      selectedSavedMessageId = actionElement.dataset.phraseId ?? null;
      render();
      return;
    case 'confirm-saved-message':
      if (actionElement.dataset.viewId) {
        confirmSavedMessage(actionElement.dataset.viewId, actionElement.dataset.phraseId ?? '');
      }
      return;
    case 'add-tts-row':
      appendTtsRow();
      return;
    case 'remove-tts-row':
      removeTtsRow(actionElement.closest<HTMLElement>('.tts-row')?.dataset.phraseId ?? null);
      return;
    default:
      return;
  }
}

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (form.dataset.form === 'server') {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && form.contains(activeElement)) {
      activeElement.blur();
    }
    const formData = new FormData(form);
    const serialField = form.querySelector<HTMLInputElement>('input[name="serial"]');
    post({
      type: 'saveServer',
      payload: {
        origin: String(formData.get('origin') ?? ''),
        serial: serialField ? String(formData.get('serial') ?? '') : '',
        username: String(formData.get('username') ?? ''),
        password: String(formData.get('password') ?? ''),
      },
    });
    return;
  }

  if (form.dataset.form === 'view') {
    syncDraftFromViewForm(form);
    const payload: IntercomViewConfig = {
      ...(localViewDraft ?? state.currentEditorView ?? {
        id: String(new FormData(form).get('viewId') ?? ''),
        type: 'intercom' as const,
        title: tr('intercom_label'),
        intercomUuidAction: null,
        activityLogControlUuidAction: null,
        historyLimit: 8,
        quickTts: [],
      }),
      quickTts: collectQuickTts(form),
    };
    post({ type: 'saveView', payload });
    return;
  }

  if (form.dataset.form === 'tts') {
    const formData = new FormData(form);
    post({
      type: 'sendTts',
      viewId: String(formData.get('viewId') ?? ''),
      message: String(formData.get('message') ?? ''),
    });
    form.reset();
  }
});

root.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  if (target.name !== 'languageOverride') {
    return;
  }
  const nextLanguageOverride = normalizeLanguage(target.value);
  const nextLanguage = nextLanguageOverride ?? normalizeLanguage(navigator.language.slice(0, 2)) ?? 'pl';
  state = {
    ...state,
    languageOverride: nextLanguageOverride,
    language: nextLanguage,
  };
  setRuntimeLanguage(nextLanguage);
  render();
  post({
    type: 'saveAppSettings',
    payload: {
      languageOverride: nextLanguageOverride,
    },
  });
});

root.addEventListener(
  'scroll',
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains('insight-drawer-body')) {
      return;
    }
    if (!sidePanelOpen || sidePanelTab !== 'history') {
      return;
    }
    const nextScrollTop = target.scrollTop;
    const nextViewportHeight = target.clientHeight;
    if (Math.abs(nextScrollTop - historyDrawerScrollTop) < 2 && nextViewportHeight === historyDrawerViewportHeight) {
      return;
    }
    historyDrawerScrollTop = nextScrollTop;
    historyDrawerViewportHeight = nextViewportHeight;
    const intercom = state.currentView?.intercom;
    if (!intercom) {
      return;
    }
    const historyItems = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
    const nextWindowKey = getHistoryVirtualizationState(historyItems).windowKey;
    if (nextWindowKey === historyVirtualWindowKey) {
      return;
    }
    historyVirtualWindowKey = nextWindowKey;
    render();
  },
  true,
);

root.addEventListener(
  'load',
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
      return;
    }
    const sourceUrl = target.dataset.historySourceUrl;
    if (!sourceUrl || target.currentSrc.startsWith('data:')) {
      return;
    }
    void cacheHistoryImageFromElement(target, sourceUrl);
  },
  true,
);

registerServiceWorker();
setupViewportHeightTracking();
post({ type: 'bootstrap', browserLanguage: navigator.language });
render();

function render(): void {
  if (shouldDeferRenderForActiveEditor()) {
    deferredRenderRequested = true;
    return;
  }
  deferredRenderRequested = false;
  const focusedField = captureFocusedFieldState();
  renderMarkup(`
    <main class="shell ${state.screen === 'loading' ? 'shell-loading' : ''}">
      <div class="ambient ambient-a"></div>
      <div class="ambient ambient-b"></div>
      ${state.screen === 'loading' ? renderLoadingScreen() : renderAppShell()}
      ${state.settingsOpen ? renderSettingsOverlay() : ''}
      ${selectedHistoryImage ? renderHistoryImageOverlay(selectedHistoryImage) : ''}
      ${renderSavedMessagesOverlay()}
      ${state.notice ? renderNotice() : ''}
    </main>
  `);
  attachRtcStreamToDom();
  syncHistoryDrawerMetrics();
  flushPendingFocus();
  if (!pendingFocusSelector) {
    restoreFocusedFieldState(focusedField);
  }
  const intercom = state.currentView?.intercom;
  if (intercom) {
    void hydrateVisibleHistoryCache(intercom);
  }
  if (
    intercom &&
    canUseRtcPreview(intercom) &&
    !intercomRtcSession.hasRemoteStreamFor(intercom.uuidAction) &&
    !intercomRtcSession.hasPendingSessionFor(intercom.uuidAction)
  ) {
    const rtcAudioStream = browserConversationState === 'active' || browserConversationState === 'starting'
      ? localMicrophoneStream
      : null;
    void intercomRtcSession.ensurePreview(intercom, rtcAudioStream).catch(() => undefined);
  }
}

function shouldDeferRenderForActiveEditor(): boolean {
  if (pendingFocusSelector) {
    return false;
  }
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLInputElement) &&
    !(activeElement instanceof HTMLTextAreaElement) &&
    !(activeElement instanceof HTMLSelectElement)
  ) {
    return false;
  }
  return Boolean(activeElement.closest('form[data-form]'));
}

type FocusedFieldState = {
  selector: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

function captureFocusedFieldState(): FocusedFieldState | null {
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLInputElement) &&
    !(activeElement instanceof HTMLTextAreaElement) &&
    !(activeElement instanceof HTMLSelectElement)
  ) {
    return null;
  }

  const form = activeElement.closest<HTMLFormElement>('form[data-form]');
  const fieldName = activeElement.getAttribute('name');
  if (!form || !fieldName) {
    return null;
  }

  const formName = form.dataset.form;
  if (!formName) {
    return null;
  }

  const escapedFormName = escapeCssSelectorValue(formName);
  const escapedFieldName = escapeCssSelectorValue(fieldName);
  const selector = `form[data-form="${escapedFormName}"] [name="${escapedFieldName}"]`;
  const selectionStart =
    activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
      ? activeElement.selectionStart
      : null;
  const selectionEnd =
    activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
      ? activeElement.selectionEnd
      : null;

  return {
    selector,
    selectionStart,
    selectionEnd,
  };
}

function restoreFocusedFieldState(fieldState: FocusedFieldState | null): void {
  if (!fieldState) {
    return;
  }
  const target = document.querySelector<HTMLElement>(fieldState.selector);
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement) &&
    !(target instanceof HTMLSelectElement)
  ) {
    return;
  }
  if (document.activeElement === target) {
    return;
  }
  target.focus({ preventScroll: true });
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    fieldState.selectionStart !== null &&
    fieldState.selectionEnd !== null
  ) {
    try {
      target.setSelectionRange(fieldState.selectionStart, fieldState.selectionEnd);
    } catch {
      // Some input types do not support selection ranges.
    }
  }
}

function escapeCssSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

document.addEventListener('focusout', () => {
  window.setTimeout(() => {
    if (!deferredRenderRequested || shouldDeferRenderForActiveEditor()) {
      return;
    }
    render();
  }, 0);
});

function flushPendingFocus(): void {
  if (!pendingFocusSelector) {
    return;
  }
  const target = document.querySelector<HTMLElement>(pendingFocusSelector);
  if (!target) {
    return;
  }
  target.focus();
  pendingFocusSelector = null;
}

function prepareSidePanelCloseFocus(): void {
  const drawer = document.querySelector<HTMLElement>('.insight-drawer');
  const activeElement = document.activeElement;
  if (!drawer || !(activeElement instanceof HTMLElement) || !drawer.contains(activeElement)) {
    return;
  }
  pendingFocusSelector = `.rail-tab-button[data-tab="${sidePanelTab}"]`;
}

function syncHistoryDrawerMetrics(): void {
  const drawerBody = document.querySelector<HTMLElement>('.insight-drawer-body');
  if (!drawerBody || !sidePanelOpen || sidePanelTab !== 'history') {
    return;
  }
  historyDrawerScrollTop = drawerBody.scrollTop;
  historyDrawerViewportHeight = drawerBody.clientHeight;
  const intercom = state.currentView?.intercom;
  if (!intercom) {
    return;
  }
  const historyItems = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
  historyVirtualWindowKey = getHistoryVirtualizationState(historyItems).windowKey;
}

function renderMarkup(markup: string): void {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  morphChildren(root, template.content);
}

function morphChildren(targetParent: Node, sourceParent: Node): void {
  const sourceChildren = Array.from(sourceParent.childNodes);
  let targetChild = targetParent.firstChild;

  for (const sourceChild of sourceChildren) {
    if (!targetChild) {
      targetParent.appendChild(sourceChild.cloneNode(true));
      continue;
    }

    const nextTarget = targetChild.nextSibling;
    const updatedNode = morphNode(targetChild, sourceChild);
    if (updatedNode === targetChild) {
      targetChild = nextTarget;
    } else {
      targetChild = updatedNode.nextSibling;
    }
  }

  while (targetChild) {
    const nextTarget = targetChild.nextSibling;
    targetParent.removeChild(targetChild);
    targetChild = nextTarget;
  }
}

function morphNode(targetNode: Node, sourceNode: Node): Node {
  if (
    targetNode.nodeType !== sourceNode.nodeType ||
    (targetNode instanceof Element &&
      sourceNode instanceof Element &&
      targetNode.tagName !== sourceNode.tagName)
  ) {
    const replacement = sourceNode.cloneNode(true);
    targetNode.parentNode?.replaceChild(replacement, targetNode);
    return replacement;
  }

  if (targetNode.nodeType === Node.TEXT_NODE || targetNode.nodeType === Node.COMMENT_NODE) {
    if (targetNode.nodeValue !== sourceNode.nodeValue) {
      targetNode.nodeValue = sourceNode.nodeValue;
    }
    return targetNode;
  }

  if (!(targetNode instanceof HTMLElement) || !(sourceNode instanceof HTMLElement)) {
    return targetNode;
  }

  syncAttributes(targetNode, sourceNode);
  syncElementState(targetNode, sourceNode);
  if (!(targetNode instanceof HTMLTextAreaElement)) {
    morphChildren(targetNode, sourceNode);
  }
  return targetNode;
}

function syncAttributes(target: HTMLElement, source: HTMLElement): void {
  const sourceAttributes = new Map(Array.from(source.attributes).map((attribute) => [attribute.name, attribute.value]));
  for (const attribute of Array.from(target.attributes)) {
    if (!sourceAttributes.has(attribute.name)) {
      target.removeAttribute(attribute.name);
    }
  }
  for (const [name, value] of sourceAttributes) {
    if (target.getAttribute(name) !== value) {
      target.setAttribute(name, value);
    }
  }
}

function syncElementState(target: HTMLElement, source: HTMLElement): void {
  const activeElement = document.activeElement;
  const isFocused = activeElement === target;

  if (target instanceof HTMLInputElement && source instanceof HTMLInputElement) {
    if (!isFocused && target.value !== source.value) {
      target.value = source.value;
    }
    if (target.checked !== source.checked) {
      target.checked = source.checked;
    }
    return;
  }

  if (target instanceof HTMLTextAreaElement && source instanceof HTMLTextAreaElement) {
    if (!isFocused && target.value !== source.value) {
      target.value = source.value;
    }
    return;
  }

  if (target instanceof HTMLSelectElement && source instanceof HTMLSelectElement) {
    if (!isFocused && target.value !== source.value) {
      target.value = source.value;
    }
  }
}

function renderLoadingScreen(): string {
  const hasSavedServerConfiguration =
    Boolean(state.serverForm.origin.trim()) &&
    Boolean(state.serverForm.username.trim()) &&
    state.serverForm.passwordStored;
  const showForm =
    !hasSavedServerConfiguration ||
    state.connection.status === 'error' ||
    state.connection.status === 'offline';
  const title = showForm ? tr('loading_title_configure') : tr('loading_title_starting');
  const copy = showForm ? tr('loading_copy_configure') : tr('loading_copy_starting');

  return `
    <section class="splash-screen">
      <div class="splash-brand">
        <p class="eyebrow">Custom Loxone App</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="splash-copy">${escapeHtml(copy)}</p>
        ${showForm ? '' : '<div class="spinner-row"><span class="spinner"></span></div>'}
      </div>
      <div class="panel splash-panel">
        ${showForm ? renderConnectionPanel() : `<p class="empty-copy">${escapeHtml(tr('loading_fetching'))}</p>`}
      </div>
    </section>
  `;
}

function renderAppShell(): string {
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">Custom Loxone App</p>
        <h1>${escapeHtml(state.miniserverName ?? tr('topbar_fallback_name'))}</h1>
      </div>
      <div class="topbar-actions">
        ${state.lastSyncedAt ? `<span class="status-pill">${escapeHtml(formatDate(state.lastSyncedAt))}</span>` : ''}
        <button class="icon-button" data-action="show-app-settings" aria-label="${escapeAttribute(tr('app_settings_aria'))}">⚙</button>
      </div>
    </header>
    ${state.screen === 'picker' ? renderViewPicker() : renderDashboard()}
  `;
}

function renderConnectionPanel(): string {
  return `
    <div class="section-head compact">
      <p class="eyebrow">${escapeHtml(tr('connection_section'))}</p>
    </div>
    <p class="empty-copy connection-copy">
      ${escapeHtml(tr('connection_helper'))}
    </p>
    ${renderServerForm()}
  `;
}

function renderViewPicker(): string {
  const intercomCount = state.intercoms.length;
  return `
    <section class="picker-screen">
      <div class="picker-copy">
        <p class="eyebrow">${escapeHtml(tr('picker_step'))}</p>
        <h2>${escapeHtml(tr('picker_title'))}</h2>
        <p class="subtle">
          ${escapeHtml(tr('picker_copy'))}
        </p>
      </div>
      <article class="panel picker-card">
        <div class="picker-card-head">
          <p class="eyebrow">${escapeHtml(tr('picker_intercom'))}</p>
          <button class="icon-button" data-action="configure-intercom-view" aria-label="${escapeAttribute(tr('view_settings_aria'))}">⚙</button>
        </div>
        <p class="picker-meta">
          ${escapeHtml(tr('picker_detected_intercoms', { count: intercomCount }))}: <strong>${intercomCount}</strong>
        </p>
        <p class="subtle">
          ${escapeHtml(tr('picker_intercom_copy'))}
        </p>
        <button class="action-button action-button-wide" data-action="add-intercom-view" ${intercomCount === 0 ? 'disabled' : ''}>
          ${escapeHtml(tr('picker_add_intercom'))}
        </button>
        ${intercomCount === 0 ? `<p class="empty-copy">${escapeHtml(tr('picker_no_intercom'))}</p>` : ''}
      </article>
    </section>
  `;
}

function renderDashboard(): string {
  return `
    <section class="dashboard-screen">
      ${state.views.length > 1 ? renderViewTabs() : ''}
      ${state.currentView ? renderIntercomStage() : renderEmptyDashboard()}
    </section>
  `;
}

function renderViewTabs(): string {
  return `
    <div class="view-tabs">
      ${state.views
        .map(
          (view) => `
            <button
              class="view-chip ${view.id === state.activeViewId ? 'view-chip-active' : ''}"
              data-action="select-view"
              data-view-id="${escapeAttribute(view.id)}"
            >
              ${escapeHtml(view.title)}
            </button>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderEmptyDashboard(): string {
  return `
    <section class="panel">
      <h2>${escapeHtml(tr('dashboard_no_view_title'))}</h2>
      <p class="empty-copy">${escapeHtml(tr('dashboard_no_view_copy'))}</p>
    </section>
  `;
}

function renderIntercomStage(): string {
  const currentView = state.currentView;
  if (!currentView) {
    return renderEmptyDashboard();
  }
  const intercom = currentView.intercom;
  const viewId = currentView.config.id;
  if (!intercom) {
    return `
      <section class="panel">
        <h2>${escapeHtml(currentView.config.title)}</h2>
        <p class="empty-copy">${escapeHtml(tr('view_needs_config'))}</p>
        <button class="ghost-button" data-action="show-view-settings" data-view-id="${escapeAttribute(viewId)}">${escapeHtml(tr('configure_now'))}</button>
      </section>
    `;
  }
  const realtimeAvailable = isRealtimeAvailable();
  const controlsDisabled = realtimeAvailable ? '' : 'disabled';
  const expandedPanels = shouldExpandIntercomPanels();
  const hasRtcMedia =
    intercomRtcSession.hasRemoteTrackFor(intercom.uuidAction) ||
    intercomRtcSession.hasRemoteStreamFor(intercom.uuidAction);
  const rtcConnectPending =
    canUseRtcPreview(intercom) && browserConversationState === 'starting' && !hasRtcMedia;
  const fallbackMediaUrl = resolveFallbackMediaUrl(intercom);
  const hasVisualMedia = hasRtcMedia || (!rtcConnectPending && Boolean(fallbackMediaUrl));
  const conversationActive = isIntercomConversationActive(intercom);
  const mediaFrameStateClass = !realtimeAvailable && !hasVisualMedia
    ? 'media-frame-offline'
    : hasVisualMedia
      ? ''
      : 'media-frame-connecting';
  const mediaFrameOverlay = !realtimeAvailable && !hasVisualMedia
    ? `<div class="media-frame-status-overlay"><span>${escapeHtml(tr('offline_intercom'))}</span></div>`
    : hasVisualMedia
      ? ''
      : `<div class="media-frame-status-overlay"><span>${escapeHtml(tr('rtc_connecting'))}</span></div>`;
  const connectLabel =
    conversationActive
      ? tr('disconnect')
      : intercom.doorbellActive
        ? tr('answer')
        : tr('connect');
  const connectDisabled = !realtimeAvailable || !intercom.supportsAnswer ? 'disabled' : '';

  return `
    <article class="intercom-layout ${expandedPanels ? 'intercom-layout-expanded' : 'intercom-layout-compact'}">
      <section class="panel media-panel">
        <div class="media-header">
          <div>
            <p class="eyebrow">${escapeHtml(intercom.roomName ?? tr('intercom_room_fallback'))}</p>
            <p class="subtle">${escapeHtml(intercom.name)}</p>
          </div>
          <div class="badge-row">
            <button class="icon-button" data-action="show-view-settings" data-view-id="${escapeAttribute(viewId)}" aria-label="${escapeAttribute(tr('view_settings_aria'))}">⚙</button>
          </div>
        </div>
        <div class="media-frame ${intercom.doorbellActive ? 'media-frame-bell-active' : ''} ${conversationActive ? 'media-frame-conversation-active' : ''} ${mediaFrameStateClass}">
          ${mediaFrameOverlay}
          <div class="media-overlay-controls">
            <button
              class="ghost-button media-overlay-button"
              data-action="connect-toggle"
              data-view-id="${escapeAttribute(viewId)}"
              ${connectDisabled}
            >
              ${escapeHtml(connectLabel)}
            </button>
            ${intercom.supportsMute
              ? `
                <button
                  class="ghost-button media-overlay-button"
                  data-action="${intercom.microphoneMuted ? 'unmute' : 'mute'}"
                  data-view-id="${escapeAttribute(viewId)}"
                  ${controlsDisabled}
                >
                  ${escapeHtml(intercom.microphoneMuted ? tr('unmute') : tr('mute'))}
                </button>
              `
              : ''}
            ${expandedPanels
              ? ''
              : `
                <button
                  class="ghost-button media-overlay-button ${intercomPanelMode === 'actions' ? 'intercom-panel-switch-active' : ''}"
                  type="button"
                  data-action="toggle-intercom-panel"
                  data-panel="actions"
                  ${controlsDisabled}
                >
                  ${escapeHtml(tr('actions'))}
                </button>
                <button
                  class="ghost-button media-overlay-button ${intercomPanelMode === 'tts' ? 'intercom-panel-switch-active' : ''}"
                  type="button"
                  data-action="toggle-intercom-panel"
                  data-panel="tts"
                  ${controlsDisabled}
                >
                  ${escapeHtml(tr('tts'))}
                </button>
              `}
          </div>
          ${renderMedia(intercom)}
        </div>
        ${renderBrowserConversationStatus()}
      </section>

      ${expandedPanels || intercomPanelMode === 'actions'
        ? `
      <section class="panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('actions'))}</p>
          ${expandedPanels ? '' : `<button class="icon-button" type="button" data-action="close-intercom-panel" aria-label="${escapeAttribute(tr('close_actions_aria'))}">×</button>`}
        </div>
        <div class="secondary-action-grid">
          ${intercom.functions.length > 0
            ? intercom.functions
                .map(
                  (item) => `
                    <button
                      class="ghost-button function-button"
                      data-action="run-child-function"
                      data-view-id="${escapeAttribute(viewId)}"
                      data-function-uuid-action="${escapeAttribute(item.uuidAction)}"
                      ${controlsDisabled}
                    >
                      ${escapeHtml(item.name)}
                    </button>
                  `,
                )
                .join('')
            : `<p class="empty-copy">${escapeHtml(tr('no_extra_actions'))}</p>`}
        </div>
      </section>
      `
        : ''}

      ${expandedPanels || intercomPanelMode === 'tts'
        ? `
      <section class="panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('tts'))}</p>
          <div class="inline-actions">
            <button
              class="icon-button"
              type="button"
              data-action="show-view-settings"
              data-view-id="${escapeAttribute(viewId)}"
              aria-label="${escapeAttribute(tr('tts_settings_aria'))}"
            >
              ⚙
            </button>
            ${expandedPanels ? '' : `<button class="icon-button" type="button" data-action="close-intercom-panel" aria-label="${escapeAttribute(tr('close_tts_aria'))}">×</button>`}
          </div>
        </div>
        <form class="tts-form" data-form="tts">
          <input type="hidden" name="viewId" value="${escapeAttribute(viewId)}" />
          <textarea id="tts-message" name="message" rows="3" placeholder="${escapeAttribute(tr('tts_placeholder'))}" ${controlsDisabled}></textarea>
          ${currentView.config.quickTts.length > 0
            ? `
              <button
                type="button"
                class="ghost-button saved-messages-button"
                data-action="open-saved-messages"
                data-view-id="${escapeAttribute(viewId)}"
                ${controlsDisabled}
              >
                ${escapeHtml(tr('saved_messages'))}
              </button>
            `
            : ''}
          <button class="action-button action-button-wide" type="submit" ${controlsDisabled}>${escapeHtml(tr('tts_read'))}</button>
        </form>
      </section>
      `
        : ''}

      ${renderInsightRail(intercom)}
    </article>
  `;
}

function renderInsightRail(intercom: NonNullable<AppViewModel['currentView']>['intercom']): string {
  if (!intercom) {
    return '';
  }
  const hasActivityLog = Boolean(intercom.activityLogSourceName);
  if (!hasActivityLog && sidePanelTab === 'log') {
    sidePanelTab = 'history';
  }
  const historyActive = sidePanelTab === 'history';
  const logActive = hasActivityLog && sidePanelTab === 'log';
  return `
    <div class="insight-rail ${sidePanelOpen ? 'insight-rail-open' : ''}">
      <div class="insight-rail-handles">
        <button
          class="rail-tab-button ${historyActive ? 'rail-tab-button-active' : ''}"
          data-action="open-side-panel"
          data-tab="history"
          aria-expanded="${sidePanelOpen && historyActive ? 'true' : 'false'}"
        >
          <span class="rail-tab-label">${escapeHtml(tr('photos'))}</span>
        </button>
        ${hasActivityLog
          ? `
            <button
              class="rail-tab-button ${logActive ? 'rail-tab-button-active' : ''}"
              data-action="open-side-panel"
              data-tab="log"
              aria-expanded="${sidePanelOpen && logActive ? 'true' : 'false'}"
            >
              <span class="rail-tab-label">${escapeHtml(tr('log'))}</span>
            </button>
          `
          : ''}
      </div>
      <aside class="insight-drawer panel" aria-hidden="${sidePanelOpen ? 'false' : 'true'}" ${sidePanelOpen ? '' : 'inert'}>
        <div class="insight-drawer-head">
          <p class="eyebrow">${historyActive ? escapeHtml(tr('photos')) : escapeHtml(tr('log'))}</p>
          <button class="icon-button" data-action="close-side-panel" aria-label="${escapeAttribute(tr('close_side_panel_aria'))}">×</button>
        </div>
        <div class="insight-drawer-body">
          ${historyActive ? renderHistoryPanel(intercom) : renderActivityLogPanel(intercom)}
        </div>
      </aside>
    </div>
  `;
}

function renderHistoryPanel(intercom: NonNullable<AppViewModel['currentView']>['intercom']): string {
  if (!intercom) {
    return '';
  }
  const historyItems = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
  const virtualization = getHistoryVirtualizationState(historyItems);
  return `
    <div class="drawer-section">
      <div
        class="history-virtual-window"
        style="padding-top:${virtualization.topSpacerHeight}px;padding-bottom:${virtualization.bottomSpacerHeight}px"
      >
      <div class="history-grid history-grid-drawer">
        ${historyItems.length > 0
          ? `
              ${virtualization.items
              .map(
                (item) => {
                  const cacheKey = normalizeHistoryImageCacheKey(item.imageUrl);
                  return `
                  <button
                    class="history-card"
                    type="button"
                    data-action="open-history-image"
                    data-timestamp="${escapeAttribute(item.timestamp)}"
                    aria-label="${escapeAttribute(tr('open_photo_aria', { label: item.label }))}"
                  >
                    <span class="history-card-media">
                      <img
                        src="${escapeAttribute(resolveHistoryImageDisplayUrl(item.imageUrl, intercom) ?? TRANSPARENT_1PX)}"
                        alt="${escapeAttribute(item.label)}"
                        loading="lazy"
                        decoding="async"
                        data-history-source-url="${escapeAttribute(item.imageUrl)}"
                        data-loading="${historyImageCache.has(cacheKey) ? 'false' : 'true'}"
                      />
                    </span>
                    <span>${escapeHtml(item.label)}</span>
                  </button>
                `;
                },
              )
              .join('')}
            `
          : `<p class="empty-copy">${escapeHtml(tr('no_photos'))}</p>`}
      </div>
      </div>
    </div>
  `;
}

function renderActivityLogPanel(intercom: NonNullable<AppViewModel['currentView']>['intercom']): string {
  if (!intercom) {
    return '';
  }
  const groupedEntries = groupActivityLogEntries(intercom.activityLog);
  return `
    <div class="drawer-section">
      <div class="section-head compact">
        <p class="eyebrow">${escapeHtml(intercom.activityLogSourceName ?? tr('event_log_source_fallback'))}</p>
      </div>
      ${
        intercom.activityLogSourceName
          ? intercom.activityLog.length > 0
            ? `
              <div class="activity-log activity-log-drawer">
                ${groupedEntries
                  .map(
                    (group) => `
                      <section class="activity-log-group">
                        <header class="activity-log-date">${escapeHtml(group.dateLabel)}</header>
                        <div class="activity-log-group-items">
                          ${group.items
                            .map(
                              (item) => `
                                <article class="activity-log-item">
                                  ${item.timeLabel ? `<span class="activity-log-time">${escapeHtml(item.timeLabel)}</span>` : ''}
                                  <p>${escapeHtml(item.message)}</p>
                                </article>
                              `,
                            )
                            .join('')}
                        </div>
                      </section>
                    `,
                  )
                  .join('')}
              </div>
            `
            : intercom.activityLogWarning
              ? `<p class="empty-copy">${escapeHtml(intercom.activityLogWarning)}</p>`
              : `<p class="empty-copy">${escapeHtml(tr('log_not_published'))}</p>`
          : `<p class="empty-copy">${escapeHtml(tr('log_attach_source'))}</p>`
      }
    </div>
  `;
}

function renderSettingsOverlay(): string {
  const isAppSettings = state.settingsMode === 'app';
  const isViewSettings = state.settingsMode === 'view';
  return `
    <div class="overlay">
      <section class="overlay-panel">
        <div class="section-head">
          <p class="eyebrow">${escapeHtml(isAppSettings ? tr('app_settings') : tr('view_settings'))}</p>
          <button class="icon-button" data-action="close-settings" aria-label="${escapeAttribute(tr('close_settings_aria'))}">×</button>
        </div>
        ${isAppSettings ? renderAppSettingsContent() : ''}
        ${isViewSettings ? renderViewSettingsContent() : ''}
      </section>
    </div>
  `;
}

function renderSavedMessagesOverlay(): string {
  const currentView = state.currentView;
  if (!savedMessagesDialogViewId || !currentView || currentView.config.id !== savedMessagesDialogViewId) {
    return '';
  }
  const phrases = currentView.config.quickTts.filter((phrase) => phrase.message.trim());
  if (phrases.length === 0) {
    return '';
  }
  const selectedPhrase = phrases.find((phrase) => phrase.id === selectedSavedMessageId) ?? phrases[0] ?? null;
  return `
    <div class="overlay">
      <section class="overlay-panel saved-messages-panel">
        <div class="section-head">
          <p class="eyebrow">${escapeHtml(tr('saved_messages'))}</p>
          <button class="icon-button" data-action="close-saved-messages" aria-label="${escapeAttribute(tr('close_saved_messages_aria'))}">×</button>
        </div>
        <div class="saved-messages-list" role="listbox" aria-label="${escapeAttribute(tr('saved_messages'))}">
          ${phrases
            .map(
              (phrase) => `
                <button
                  type="button"
                  class="saved-message-item ${selectedPhrase?.id === phrase.id ? 'saved-message-item-active' : ''}"
                  data-action="select-saved-message"
                  data-phrase-id="${escapeAttribute(phrase.id)}"
                  aria-selected="${selectedPhrase?.id === phrase.id ? 'true' : 'false'}"
                >
                  <strong>${escapeHtml(phrase.label || phrase.message)}</strong>
                  <span>${escapeHtml(phrase.message)}</span>
                </button>
              `,
            )
            .join('')}
        </div>
        <div class="saved-messages-actions">
          <button type="button" class="ghost-button" data-action="close-saved-messages">${escapeHtml(tr('cancel'))}</button>
          <button
            type="button"
            class="action-button"
            data-action="confirm-saved-message"
            data-view-id="${escapeAttribute(savedMessagesDialogViewId)}"
            data-phrase-id="${escapeAttribute(selectedPhrase?.id ?? '')}"
          >
            ${escapeHtml(tr('send_selected_message'))}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderHistoryImageOverlay(item: IntercomHistoryItem): string {
  const intercom = state.currentView?.intercom ?? null;
  const imageSrc =
    intercom ? resolveHistoryImageDisplayUrl(item.imageUrl, intercom) ?? item.imageUrl : historyImageCache.get(normalizeHistoryImageCacheKey(item.imageUrl)) ?? item.imageUrl;
  const previous = getAdjacentHistoryImage(-1);
  const next = getAdjacentHistoryImage(1);
  return `
    <div class="overlay history-lightbox">
      <section class="overlay-panel history-lightbox-panel">
        <div class="section-head history-lightbox-head">
          <p class="eyebrow">${escapeHtml(tr('photo_title'))}</p>
          <div class="inline-actions">
            <button
              class="icon-button"
              data-action="history-image-prev"
              aria-label="${escapeAttribute(tr('previous_photo_aria'))}"
              ${previous ? '' : 'disabled'}
            >
              ‹
            </button>
            <button
              class="icon-button"
              data-action="history-image-next"
              aria-label="${escapeAttribute(tr('next_photo_aria'))}"
              ${next ? '' : 'disabled'}
            >
              ›
            </button>
            <button class="icon-button" data-action="close-history-image" aria-label="${escapeAttribute(tr('close_photo_aria'))}">×</button>
          </div>
        </div>
        <div class="history-lightbox-body">
          <img
            class="history-lightbox-image"
            src="${escapeAttribute(imageSrc)}"
            alt="${escapeAttribute(item.label)}"
            loading="eager"
            decoding="async"
            data-history-source-url="${escapeAttribute(item.imageUrl)}"
          />
          <p class="history-lightbox-caption">${escapeHtml(item.label)}</p>
        </div>
      </section>
    </div>
  `;
}

function getAdjacentHistoryImage(offset: -1 | 1): IntercomHistoryItem | null {
  if (!selectedHistoryImage) {
    return null;
  }
  const intercom = state.currentView?.intercom;
  if (!intercom) {
    return null;
  }
  const historyItems = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
  const currentIndex = historyItems.findIndex((item) => item.timestamp === selectedHistoryImage?.timestamp);
  if (currentIndex === -1) {
    return null;
  }
  return historyItems[currentIndex + offset] ?? null;
}

function renderAppSettingsContent(): string {
  return `
    <div class="settings-grid">
      <article class="panel settings-panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('server_section'))}</p>
        </div>
        ${renderServerForm(false)}
        ${renderLanguageForm()}
        <div class="settings-panel-footer">
          <a
            class="support-link"
            href="https://buymeacoffee.com/szymonrybka"
            target="_blank"
            rel="noreferrer noopener"
          >
            buy me a coffee
          </a>
        </div>
      </article>
      <article class="panel settings-panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('views_section'))}</p>
          <button class="ghost-button mini-button" data-action="configure-intercom-view">${escapeHtml(tr('new_intercom'))}</button>
        </div>
        ${state.views.length > 0 ? renderViewList() : `<p class="empty-copy">${escapeHtml(tr('no_saved_views'))}</p>`}
      </article>
    </div>
  `;
}

function renderLanguageForm(): string {
  return `
    <div class="server-form server-form-secondary">
      <label>
        <span>${escapeHtml(tr('language_label'))}</span>
        <select name="languageOverride">
          <option value="" ${state.languageOverride === null ? 'selected' : ''}>${escapeHtml(tr('language_browser_default', { language: describeLanguage(state.language) }))}</option>
          <option value="pl" ${state.languageOverride === 'pl' ? 'selected' : ''}>${escapeHtml(tr('language_polish'))}</option>
          <option value="en" ${state.languageOverride === 'en' ? 'selected' : ''}>${escapeHtml(tr('language_english'))}</option>
          <option value="de" ${state.languageOverride === 'de' ? 'selected' : ''}>${escapeHtml(tr('language_german'))}</option>
        </select>
      </label>
    </div>
  `;
}

function renderViewSettingsContent(): string {
  const editorView = localViewDraft ?? state.currentEditorView;
  return `
    <div class="settings-grid settings-grid-single">
      <article class="panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('view_section'))}</p>
        </div>
        ${editorView ? renderViewEditor(editorView) : `<p class="empty-copy">${escapeHtml(tr('no_editor_view'))}</p>`}
      </article>
    </div>
  `;
}

function renderServerForm(showSubmit = true): string {
  const serverForm = localServerDraft ?? state.serverForm;
  return `
    <form class="server-form" data-form="server">
      <label>
        <span>${escapeHtml(tr('loxone_address'))}</span>
        <input name="origin" placeholder="https://miniserver.local" value="${escapeAttribute(serverForm.origin)}" />
      </label>
      <label>
        <span>${escapeHtml(tr('login'))}</span>
        <input name="username" required placeholder="uzytkownik" value="${escapeAttribute(serverForm.username)}" />
      </label>
      <label>
        <span>${escapeHtml(tr('password'))}</span>
        <input name="password" type="password" placeholder="${escapeAttribute(serverForm.passwordStored ? tr('password_keep') : tr('password_placeholder'))}" value="${escapeAttribute(localServerDraft?.password ?? '')}" />
      </label>
      ${showSubmit ? `<button class="action-button action-button-wide" type="submit">${escapeHtml(tr('save_and_connect'))}</button>` : ''}
    </form>
  `;
}

function renderViewList(): string {
  return `
    <div class="view-list">
      ${state.views
        .map(
          (view) => `
            <article class="view-list-item ${view.id === state.settingsEditorViewId ? 'view-list-item-active' : ''}">
              <div>
                <strong>${escapeHtml(view.title)}</strong>
                <p>${escapeHtml(resolveIntercomName(view.intercomUuidAction))}</p>
              </div>
              <div class="inline-actions">
                <button class="ghost-button mini-button" data-action="edit-view" data-view-id="${escapeAttribute(view.id)}">${escapeHtml(tr('edit'))}</button>
                <button class="ghost-button mini-button" data-action="set-default-view" data-view-id="${escapeAttribute(view.id)}">${escapeHtml(tr('default'))}</button>
                <button class="ghost-button mini-button" data-action="delete-view" data-view-id="${escapeAttribute(view.id)}">${escapeHtml(tr('delete'))}</button>
              </div>
            </article>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderViewEditor(view: IntercomViewConfig): string {
  return `
    <form class="view-form" data-form="view">
      <input type="hidden" name="viewId" value="${escapeAttribute(view.id)}" />
      <label>
        <span>${escapeHtml(tr('view_name'))}</span>
        <input name="title" required value="${escapeAttribute(view.title)}" />
      </label>
      <label>
        <span>${escapeHtml(tr('intercom_label'))}</span>
        <select name="intercomUuidAction">
          <option value="">${escapeHtml(tr('first_found_intercom'))}</option>
          ${state.intercoms
            .map(
              (intercom) => `
                <option value="${escapeAttribute(intercom.uuidAction)}" ${view.intercomUuidAction === intercom.uuidAction ? 'selected' : ''}>
                  ${escapeHtml(intercom.name)}${intercom.roomName ? ` · ${escapeHtml(intercom.roomName)}` : ''}
                </option>
              `,
            )
            .join('')}
        </select>
      </label>
      <label>
        <span>${escapeHtml(tr('optional_log_source'))}</span>
        <select name="activityLogControlUuidAction">
          <option value="">${escapeHtml(tr('no_extra_log'))}</option>
          ${state.logSources
            .map(
              (source) => `
                <option value="${escapeAttribute(source.uuidAction)}" ${view.activityLogControlUuidAction === source.uuidAction ? 'selected' : ''}>
                  ${escapeHtml(source.name)}${source.roomName ? ` · ${escapeHtml(source.roomName)}` : ''} (${escapeHtml(source.type)})
                </option>
              `,
            )
            .join('')}
        </select>
      </label>
      <label>
        <span>${escapeHtml(tr('history_limit'))}</span>
        <input name="historyLimit" type="number" min="3" max="20" value="${escapeAttribute(String(view.historyLimit))}" />
      </label>
      <div class="tts-editor">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('quick_tts'))}</p>
          <button class="ghost-button mini-button" type="button" data-action="add-tts-row">${escapeHtml(tr('add_phrase'))}</button>
        </div>
        <div id="tts-editor-rows">
          ${view.quickTts.map(renderTtsRow).join('')}
        </div>
      </div>
      <button class="action-button action-button-wide" type="submit">${escapeHtml(tr('save_view'))}</button>
    </form>
  `;
}

function renderTtsRow(phrase: QuickTtsPhrase): string {
  return `
    <div class="tts-row" data-phrase-id="${escapeAttribute(phrase.id)}">
      <input name="phraseMessage" placeholder="${escapeAttribute(tr('phrase_placeholder'))}" value="${escapeAttribute(phrase.message ?? phrase.label ?? '')}" />
      <button class="icon-button tts-row-remove" type="button" data-action="remove-tts-row" aria-label="${escapeAttribute(tr('remove_phrase_aria'))}">×</button>
    </div>
  `;
}

function renderNotice(): string {
  if (!state.notice) {
    return '';
  }
  const label =
    state.notice.kind === 'error' ? tr('app_warning') : state.notice.kind === 'success' ? tr('app_ok') : tr('app_info');
  return `
    <section class="notice notice-${state.notice.kind} toast-notice">
      <span class="toast-dot toast-dot-${state.notice.kind}" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <p>${escapeHtml(state.notice.message)}</p>
      </div>
      <button class="icon-button" data-action="dismiss-notice" aria-label="${escapeAttribute(tr('dismiss_notice_aria'))}">×</button>
    </section>
  `;
}

function renderBrowserConversationStatus(): string {
  if (browserConversationState !== 'error') {
    return '';
  }
  const tone = 'empty-copy';
  return `
    <div class="conversation-status">
      <p class="${tone}">${escapeHtml(browserConversationMessage)}</p>
    </div>
  `;
}

function isRealtimeAvailable(): boolean {
  return state.connection.status === 'online';
}

async function handleConnect(viewId: string): Promise<void> {
  const intercom = state.currentView?.intercom ?? null;
  if (intercom && isIntercomConversationActive(intercom)) {
    stopBrowserConversation(true);
    return;
  }
  if (!intercom) {
    browserConversationState = 'idle';
    browserConversationMessage = '';
    render();
    return;
  }
  if (intercom.doorbellActive) {
    browserConversationState = 'idle';
    browserConversationMessage = '';
    post({
      type: 'runBuiltInAction',
      viewId,
      action: 'answer',
    });
    render();
    return;
  }
  await startBrowserConversation(intercom);
}

async function startBrowserConversation(intercom: CurrentIntercom): Promise<void> {
  const attemptId = ++browserConversationAttempt;
  if (browserConversationState === 'starting' || browserConversationState === 'active') {
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    browserConversationState = 'error';
    browserConversationMessage = tr('rtc_browser_unsupported');
    render();
    return;
  }
  browserConversationState = 'starting';
  browserConversationMessage = '';
  render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (attemptId !== browserConversationAttempt) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }
    if (localMicrophoneStream) {
      for (const track of localMicrophoneStream.getTracks()) {
        track.stop();
      }
    }
    localMicrophoneStream = stream;
    await intercomRtcSession.ensurePreview(intercom, stream);
    if (attemptId !== browserConversationAttempt) {
      return;
    }
    browserConversationState = 'active';
    browserConversationMessage = '';
  } catch (error) {
    if (attemptId !== browserConversationAttempt) {
      return;
    }
    const message = toErrorMessage(error);
    if (message === INTERCOM_AUDIO_UNSUPPORTED_ERROR || message.includes(tr('signaling_timeout', { method: 'call' }))) {
      if (localMicrophoneStream) {
        for (const track of localMicrophoneStream.getTracks()) {
          track.stop();
        }
        localMicrophoneStream = null;
      }
      browserConversationState = 'idle';
      browserConversationMessage = '';
      render();
      return;
    }
    if (message.includes(tr('session_reset'))) {
      browserConversationState = 'idle';
      browserConversationMessage = '';
      render();
      return;
    }
    browserConversationState = 'error';
    browserConversationMessage = tr('rtc_audio_failed', { message });
  }
  render();
}

function stopBrowserConversation(renderAfter = true, cancelPending = true): void {
  if (cancelPending) {
    browserConversationAttempt += 1;
  }
  void resetBrowserConversationSession(true, renderAfter);
}

async function resetBrowserConversationSession(restartPreview: boolean, renderAfter = false): Promise<void> {
  const intercom = state.currentView?.intercom ?? null;
  if (localMicrophoneStream) {
    for (const track of localMicrophoneStream.getTracks()) {
      track.stop();
    }
    localMicrophoneStream = null;
  }
  const liveMedia = document.querySelector('#intercom-live-media');
  if (liveMedia instanceof HTMLVideoElement) {
    liveMedia.muted = true;
  }
  await intercomRtcSession.disconnect();
  browserConversationState = 'idle';
  browserConversationMessage = '';
  if (restartPreview && intercom) {
    void intercomRtcSession.ensurePreview(intercom).catch(() => {
      // Keep striped loading state if preview restart fails.
    });
  }
  if (renderAfter) {
    render();
  }
}

function renderMedia(intercom: CurrentIntercom): string {
  if (
    canUseRtcPreview(intercom) &&
    (
      intercomRtcSession.hasRemoteTrackFor(intercom.uuidAction) ||
      intercomRtcSession.hasRemoteStreamFor(intercom.uuidAction) ||
      browserConversationState === 'starting'
    )
  ) {
    return `<video id="intercom-live-media" class="intercom-media" autoplay ${isIntercomConversationActive(intercom) ? '' : 'muted'} playsinline></video>`;
  }
  const liveUrl = resolveFallbackMediaUrl(intercom);
  return liveUrl
    ? renderMediaUrl(liveUrl, intercom.snapshotUrl, intercom.name, false)
    : `<div class="media-empty"><p>${escapeHtml(tr('media_empty'))}</p></div>`;
}

function isIntercomConversationActive(intercom: CurrentIntercom): boolean {
  if (browserConversationState === 'active' || browserConversationState === 'starting') {
    return true;
  }
  return intercomRtcSession.isConversationEnabledFor(intercom.uuidAction);
}

function resolveFallbackMediaUrl(intercom: CurrentIntercom): string | null {
  if (canUseRtcPreview(intercom)) {
    const proxySnapshotUrl = resolveProxySnapshotUrl(intercom);
    return proxySnapshotUrl ?? intercom.snapshotUrl ?? intercom.streamUrl ?? null;
  }
  return intercom.streamUrl ?? intercom.snapshotUrl ?? null;
}

function renderMediaUrl(url: string, snapshotUrl: string | null, alt: string, bustCache = false): string {
  const resolvedUrl = state.currentView?.intercom ? resolveRenderableMediaUrl(url, state.currentView.intercom, bustCache) : url;
  const resolvedPoster =
    snapshotUrl && state.currentView?.intercom
      ? resolveRenderableMediaUrl(snapshotUrl, state.currentView.intercom, false)
      : snapshotUrl;
  if (isVideoLikeUrl(url)) {
    return `<video id="intercom-live-media" class="intercom-media" src="${escapeAttribute(resolvedUrl)}" controls autoplay ${browserConversationState === 'active' ? '' : 'muted'} playsinline poster="${escapeAttribute(resolvedPoster ?? '')}"></video>`;
  }
  return `<img id="intercom-live-media" class="intercom-media" src="${escapeAttribute(resolvedUrl)}" alt="${escapeAttribute(alt)}" loading="eager" decoding="async" />`;
}

async function closeSettingsOverlay(): Promise<void> {
  if (state.settingsMode === 'app') {
    await persistServerSettingsFromOverlay();
  }
  localServerDraft = null;
  post({ type: 'closeSettings' });
}

async function persistServerSettingsFromOverlay(): Promise<void> {
  const form = document.querySelector<HTMLFormElement>('form[data-form="server"]');
  if (!form) {
    return;
  }
  const formData = new FormData(form);
  const serialField = form.querySelector<HTMLInputElement>('input[name="serial"]');
  const origin = String(formData.get('origin') ?? '').trim();
  const serial = serialField ? String(formData.get('serial') ?? '').trim() : '';
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const changed =
    origin !== state.serverForm.origin ||
    (serialField ? serial !== (state.serverForm.serial ?? '') : false) ||
    username !== state.serverForm.username ||
    password.trim().length > 0;
  if (!changed) {
    return;
  }
  post({
    type: 'saveServer',
    payload: {
      origin,
      serial,
      username,
      password,
    },
  });
}

function getHistoryVirtualizationState(items: IntercomHistoryItem[]): {
  items: IntercomHistoryItem[];
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  windowKey: string;
} {
  if (items.length === 0) {
    return {
      items: [],
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      windowKey: 'empty',
    };
  }

  const columns = window.innerWidth <= 900 ? 1 : 2;
  const rowHeight = resolveHistoryRowHeight();
  const totalRows = Math.ceil(items.length / columns);
  const viewportHeight = historyDrawerViewportHeight || rowHeight * Math.min(3, totalRows);
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const startRow = Math.max(0, Math.floor(historyDrawerScrollTop / rowHeight) - HISTORY_DRAWER_OVERSCAN_ROWS);
  const endRow = Math.min(totalRows, startRow + visibleRows + HISTORY_DRAWER_OVERSCAN_ROWS * 2);
  const startIndex = startRow * columns;
  const endIndex = Math.min(items.length, endRow * columns);

  return {
    items: items.slice(startIndex, endIndex),
    topSpacerHeight: startRow * rowHeight,
    bottomSpacerHeight: Math.max(0, (totalRows - endRow) * rowHeight),
    windowKey: `${columns}:${startRow}:${endRow}:${rowHeight}`,
  };
}

function resolveHistoryRowHeight(): number {
  const cardHeight = window.innerWidth <= 900 ? HISTORY_CARD_HEIGHT_MOBILE : HISTORY_CARD_HEIGHT_DESKTOP;
  return cardHeight + HISTORY_DRAWER_GAP;
}

async function hydrateVisibleHistoryCache(intercom: CurrentIntercom): Promise<void> {
  const items = collectVisibleHistoryItems(intercom);
  for (const item of items) {
    const cacheKey = normalizeHistoryImageCacheKey(item.imageUrl);
    if (
      historyImageCache.has(cacheKey) ||
      pendingHistoryImageCacheReads.has(cacheKey)
    ) {
      continue;
    }
    pendingHistoryImageCacheReads.add(cacheKey);
    try {
      const cached = await loadMediaCacheEntry(cacheKey);
      if (cached) {
        historyImageCache.set(cacheKey, cached);
        render();
      }
    } finally {
      pendingHistoryImageCacheReads.delete(cacheKey);
    }
  }
}

function collectVisibleHistoryItems(intercom: CurrentIntercom): IntercomHistoryItem[] {
  if (!sidePanelOpen && !selectedHistoryImage) {
    return [];
  }

  const historyItems = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
  const items = new Map<string, IntercomHistoryItem>();

  if (sidePanelOpen && sidePanelTab === 'history') {
    for (const item of getHistoryVirtualizationState(historyItems).items) {
      items.set(item.timestamp, item);
    }
  }

  if (selectedHistoryImage) {
    items.set(selectedHistoryImage.timestamp, selectedHistoryImage);
  }

  return Array.from(items.values());
}

function resolveHistoryImageDisplayUrl(sourceUrl: string, intercom: CurrentIntercom): string | null {
  const cacheKey = normalizeHistoryImageCacheKey(sourceUrl);
  return historyImageCache.get(cacheKey) ?? buildHistoryImageRequestUrl(sourceUrl, intercom, false);
}

function buildHistoryImageRequestUrl(sourceUrl: string, intercom: CurrentIntercom, bustCache: boolean): string {
  return resolveRenderableMediaUrl(sourceUrl, intercom, bustCache);
}

function normalizeHistoryImageCacheKey(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.username = '';
  url.password = '';
  url.searchParams.delete('auth');
  url.searchParams.delete('autht');
  url.searchParams.delete('cacheBuster');
  return url.toString();
}

async function cacheHistoryImageFromElement(image: HTMLImageElement, sourceUrl: string): Promise<void> {
  const cacheKey = normalizeHistoryImageCacheKey(sourceUrl);
  if (
    historyImageCache.has(cacheKey) ||
    failedHistoryImageLoads.has(cacheKey) ||
    pendingHistoryImageCacheWrites.has(cacheKey) ||
    image.naturalWidth === 0 ||
    image.naturalHeight === 0
  ) {
    return;
  }

  pendingHistoryImageCacheWrites.add(cacheKey);
  try {
    const cached = await loadMediaCacheEntry(cacheKey);
    if (cached) {
      historyImageCache.set(cacheKey, cached);
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      failedHistoryImageLoads.add(cacheKey);
      return;
    }
    context.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    historyImageCache.set(cacheKey, dataUrl);
    void saveMediaCacheEntry(cacheKey, dataUrl);
    render();
  } catch {
    failedHistoryImageLoads.add(cacheKey);
  } finally {
    pendingHistoryImageCacheWrites.delete(cacheKey);
  }
}

function resolveIntercomName(uuidAction: string | null): string {
  if (!uuidAction) {
    return tr('auto_first_intercom');
  }
  return state.intercoms.find((item) => item.uuidAction === uuidAction)?.name ?? tr('misc_other');
}

function appendTtsRow(): void {
  if (!ensureLocalViewDraft()) {
    return;
  }
  syncDraftFromViewForm();
  localViewDraft = {
    ...localViewDraft!,
    quickTts: [
      ...localViewDraft!.quickTts,
      { id: crypto.randomUUID(), label: '', message: '' },
    ],
  };
  render();
}

function removeTtsRow(phraseId: string | null): void {
  if (!phraseId || !ensureLocalViewDraft()) {
    return;
  }
  syncDraftFromViewForm();
  localViewDraft = {
    ...localViewDraft!,
    quickTts: localViewDraft!.quickTts.filter((item) => item.id !== phraseId),
  };
  render();
}

function openSavedMessagesDialog(viewId: string): void {
  const view = state.views.find((item) => item.id === viewId);
  const phrases = view?.quickTts.filter((phrase) => phrase.message.trim()) ?? [];
  if (phrases.length === 0) {
    return;
  }
  savedMessagesDialogViewId = viewId;
  selectedSavedMessageId = phrases[0]?.id ?? null;
  render();
}

function closeSavedMessagesDialog(): void {
  savedMessagesDialogViewId = null;
  selectedSavedMessageId = null;
}

function confirmSavedMessage(viewId: string, phraseId: string): void {
  const view = state.views.find((item) => item.id === viewId);
  const phrase = view?.quickTts.find((item) => item.id === phraseId && item.message.trim());
  if (!phrase) {
    return;
  }
  post({
    type: 'sendTts',
    viewId,
    message: phrase.message,
  });
  closeSavedMessagesDialog();
  render();
}

function collectQuickTts(form: HTMLFormElement, includeEmpty = false): QuickTtsPhrase[] {
  return Array.from(form.querySelectorAll<HTMLElement>('.tts-row'))
    .map((row) => ({
      id: row.dataset.phraseId || crypto.randomUUID(),
      label: row.querySelector<HTMLInputElement>('input[name="phraseMessage"]')?.value.trim() ?? '',
      message: row.querySelector<HTMLInputElement>('input[name="phraseMessage"]')?.value.trim() ?? '',
    }))
    .filter((item) => includeEmpty || item.label || item.message);
}

root.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const serverForm = target.closest<HTMLFormElement>('form[data-form="server"]');
  if (serverForm) {
    syncDraftFromServerForm(serverForm);
    return;
  }
  const form = target.closest<HTMLFormElement>('form[data-form="view"]');
  if (!form) {
    return;
  }
  syncDraftFromViewForm(form);
});

root.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const serverForm = target.closest<HTMLFormElement>('form[data-form="server"]');
  if (serverForm) {
    syncDraftFromServerForm(serverForm);
    return;
  }
  const form = target.closest<HTMLFormElement>('form[data-form="view"]');
  if (!form) {
    return;
  }
  syncDraftFromViewForm(form);
});

function syncLocalServerDraft(): void {
  if (state.settingsMode !== 'app') {
    localServerDraft = null;
    return;
  }
  if (!localServerDraft) {
    localServerDraft = {
      origin: state.serverForm.origin,
      serial: state.serverForm.serial ?? '',
      username: state.serverForm.username,
      password: '',
      passwordStored: state.serverForm.passwordStored,
    };
  }
}

function syncLocalViewDraft(): void {
  syncLocalServerDraft();
  if (state.settingsMode !== 'view' || !state.currentEditorView) {
    localViewDraft = null;
    return;
  }
  if (!localViewDraft || localViewDraft.id !== state.currentEditorView.id) {
    localViewDraft = structuredClone(state.currentEditorView);
  }
}

function syncDraftFromServerForm(form?: HTMLFormElement | null): void {
  const sourceForm = form ?? document.querySelector<HTMLFormElement>('form[data-form="server"]');
  if (!sourceForm) {
    return;
  }
  const formData = new FormData(sourceForm);
  const serialField = sourceForm.querySelector<HTMLInputElement>('input[name="serial"]');
  localServerDraft = {
    origin: String(formData.get('origin') ?? '').trim(),
    serial: serialField
      ? String(formData.get('serial') ?? '').trim().toUpperCase()
      : (localServerDraft?.serial ?? state.serverForm.serial ?? ''),
    username: String(formData.get('username') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    passwordStored: state.serverForm.passwordStored,
  };
}

function ensureLocalViewDraft(): boolean {
  if (localViewDraft) {
    return true;
  }
  if (!state.currentEditorView) {
    return false;
  }
  localViewDraft = structuredClone(state.currentEditorView);
  return true;
}

function syncDraftFromViewForm(form?: HTMLFormElement | null): void {
  if (!ensureLocalViewDraft()) {
    return;
  }
  const sourceForm = form ?? document.querySelector<HTMLFormElement>('form[data-form="view"]');
  if (!sourceForm) {
    return;
  }
  const formData = new FormData(sourceForm);
  localViewDraft = {
    id: String(formData.get('viewId') ?? localViewDraft!.id),
    type: 'intercom',
    title: String(formData.get('title') ?? '').trim() || 'Interkom',
    intercomUuidAction: normalizeNullable(String(formData.get('intercomUuidAction') ?? '')),
    activityLogControlUuidAction: normalizeNullable(
      String(formData.get('activityLogControlUuidAction') ?? ''),
    ),
    historyLimit: Number(formData.get('historyLimit') ?? 8),
    quickTts: collectQuickTts(sourceForm, true),
  };
}

function post(message: MainToWorkerMessage): void {
  worker.postMessage(message);
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    void registration.update();
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      window.location.reload();
    });
  } catch {
    // Offline shell is best-effort only.
  }
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(localeForLanguage(state.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function normalizeNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function describeLanguage(value: AppLanguage): string {
  switch (value) {
    case 'en':
      return tr('language_english');
    case 'de':
      return tr('language_german');
    default:
      return tr('language_polish');
  }
}

function shouldExpandIntercomPanels(): boolean {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return viewportWidth >= 1400 && viewportHeight >= 980;
}

function setupViewportHeightTracking(): void {
  const updateViewportHeight = (): void => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
  };

  updateViewportHeight();
  window.addEventListener('resize', updateViewportHeight);
  window.visualViewport?.addEventListener('resize', updateViewportHeight);
  window.visualViewport?.addEventListener('scroll', updateViewportHeight);

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const isTextEntryTarget =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if (!isTextEntryTarget) {
      return;
    }
    window.setTimeout(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
  });
}

function normalizeLanguage(value: string): AppLanguage | null {
  return value === 'en' ? 'en' : value === 'de' ? 'de' : value === 'pl' ? 'pl' : null;
}

function groupActivityLogEntries(items: ActivityLogItem[]): Array<{
  dateLabel: string;
  items: Array<{ timeLabel: string | null; message: string }>;
}> {
  const parsedItems = items
    .map((item, index) => parseActivityLogLabel(item.label, index))
    .sort((left, right) => right.sortKey - left.sortKey);

  const groups: Array<{
    dateLabel: string;
    items: Array<{ timeLabel: string | null; message: string }>;
  }> = [];

  for (const item of parsedItems) {
    const currentGroup = groups.at(-1);
    if (!currentGroup || currentGroup.dateLabel !== item.dateLabel) {
      groups.push({
        dateLabel: item.dateLabel,
        items: [{ timeLabel: item.timeLabel, message: item.message }],
      });
      continue;
    }
    currentGroup.items.push({ timeLabel: item.timeLabel, message: item.message });
  }

  return groups;
}

function parseActivityLogLabel(
  label: string,
  fallbackIndex: number,
): {
  dateLabel: string;
  timeLabel: string | null;
  message: string;
  sortKey: number;
} {
  const isoMatch = label.match(
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[ T](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?\s+(?<message>.+)$/u,
  );
  if (isoMatch?.groups) {
    const second = isoMatch.groups.second ?? '00';
    const sortValue = Date.parse(
      `${isoMatch.groups.year}-${isoMatch.groups.month}-${isoMatch.groups.day}T${isoMatch.groups.hour}:${isoMatch.groups.minute}:${second}`,
    );
    return {
      dateLabel: `${isoMatch.groups.year}-${isoMatch.groups.month}-${isoMatch.groups.day}`,
      timeLabel: `${isoMatch.groups.hour}:${isoMatch.groups.minute}${isoMatch.groups.second ? `:${isoMatch.groups.second}` : ''}`,
      message: isoMatch.groups.message.trim(),
      sortKey: Number.isNaN(sortValue) ? Number.MAX_SAFE_INTEGER - fallbackIndex : sortValue,
    };
  }

  const europeanMatch = label.match(
    /^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})[ T](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?\s+(?<message>.+)$/u,
  );
  if (europeanMatch?.groups) {
    const second = europeanMatch.groups.second ?? '00';
    const sortValue = Date.parse(
      `${europeanMatch.groups.year}-${europeanMatch.groups.month}-${europeanMatch.groups.day}T${europeanMatch.groups.hour}:${europeanMatch.groups.minute}:${second}`,
    );
    return {
      dateLabel: `${europeanMatch.groups.day}.${europeanMatch.groups.month}.${europeanMatch.groups.year}`,
      timeLabel: `${europeanMatch.groups.hour}:${europeanMatch.groups.minute}${europeanMatch.groups.second ? `:${europeanMatch.groups.second}` : ''}`,
      message: europeanMatch.groups.message.trim(),
      sortKey: Number.isNaN(sortValue) ? Number.MAX_SAFE_INTEGER - fallbackIndex : sortValue,
    };
  }

  return {
    dateLabel: tr('misc_other'),
    timeLabel: null,
    message: label,
    sortKey: Number.MAX_SAFE_INTEGER - fallbackIndex,
  };
}

function isVideoLikeUrl(value: string): boolean {
  if (/\.(jpg|jpeg|png|gif|bmp|webp|mjpg|mjpeg)(\?|$)/i.test(value)) {
    return false;
  }
  if (/(?:^|\/)(?:mjpg|mjpeg)\//i.test(value) || /image\.jpg(\?|$)/i.test(value)) {
    return false;
  }
  if (/\.(mp4|webm|ogg|m3u8|mpd)(\?|$)/i.test(value)) {
    return true;
  }
  return false;
}

function canUseRtcPreview(intercom: CurrentIntercom): boolean {
  return Boolean(intercom.deviceUuid && intercom.authToken && intercom.signalingUrl);
}

function resolveIntercomSignalingUrls(intercom: CurrentIntercom): string[] {
  return intercom.signalingUrl ? [intercom.signalingUrl] : [];
}

async function buildIntercomAuthenticationPayload(input: {
  username: string;
  token: string | null;
  sessionToken: string;
  modulus: string | null;
  exponent: string | null;
  publicKey: string | null;
}): Promise<[string, string, string]> {
  if (!input.username || !input.token || !input.sessionToken) {
    throw new Error(tr('intercom_auth_missing'));
  }
  const passphrase = CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Hex);
  const encryptedToken = CryptoJS.AES.encrypt(input.token, passphrase, {
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const envelope = [encryptedToken.key.toString(CryptoJS.enc.Hex), encryptedToken.iv.toString(CryptoJS.enc.Hex), input.sessionToken].join(':');
  const encryptedEnvelope = encryptIntercomEnvelope(envelope, input.publicKey, input.modulus, input.exponent);
  if (!encryptedEnvelope) {
    throw new Error(tr('intercom_challenge_encrypt_failed'));
  }
  return [
    input.username,
    encryptedEnvelope,
    encryptedToken.ciphertext.toString(CryptoJS.enc.Base64),
  ];
}

function encryptIntercomEnvelope(
  value: string,
  publicKey: string | null,
  modulus: string | null,
  exponent: string | null,
): string | null {
  try {
    let key: forge.pki.rsa.PublicKey | null = null;
    if (publicKey) {
      key = forge.pki.publicKeyFromPem(publicKey) as forge.pki.rsa.PublicKey;
    } else if (modulus && exponent) {
      key = forge.pki.setRsaPublicKey(
        new forge.jsbn.BigInteger(modulus, 16),
        new forge.jsbn.BigInteger(exponent, 16),
      );
    }
    if (!key) {
      return null;
    }
    return forge.util.encode64(key.encrypt(value, 'RSAES-PKCS1-V1_5'));
  } catch {
    return null;
  }
}

function mapIntercomActivitiesToHistory(value: unknown, intercom: CurrentIntercom): IntercomHistoryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mediaBase = resolveIntercomHistoryBase(intercom);
  if (!mediaBase) {
    return [];
  }
  return value
    .map((item) => mapIntercomActivityToHistoryItem(item, mediaBase, intercom))
    .filter((item): item is IntercomHistoryItem => item !== null)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function mapIntercomActivityToHistoryItem(
  value: unknown,
  mediaBase: string,
  intercom?: CurrentIntercom,
): IntercomHistoryItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const dateValue = record.date;
  const rawPath = resolveHistoryMediaPath(record);
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return null;
  }
  const timestamp = normalizeIntercomActivityDate(dateValue);
  const imageUrl = resolveHistoryImageUrl(record, mediaBase, intercom);
  return {
    timestamp,
    label: formatBellLabel(timestamp),
    imageUrl,
  };
}

function resolveHistoryImageUrl(
  record: Record<string, unknown>,
  mediaBase: string,
  intercom?: CurrentIntercom,
): string {
  const rawPath = resolveHistoryMediaPath(record);
  if (typeof rawPath === 'string' && rawPath.trim()) {
    return inheritMediaAuth(resolveMediaUrlAgainstBase(rawPath, mediaBase), mediaBase, intercom);
  }
  return mediaBase;
}

function resolveHistoryMediaPath(record: Record<string, unknown>): unknown {
  return (
    record.thumbPath ??
    record.thumbnailPath ??
    record.imagePath ??
    record.path ??
    record.thumbnail ??
    record.image ??
    null
  );
}

function resolveMediaUrlAgainstBase(rawPath: string, mediaBase: string): URL {
  const trimmedPath = rawPath.trim();
  const intercom = state.currentView?.intercom ?? null;
  const base = new URL(mediaBase);
  if (/^https?:\/\//i.test(trimmedPath)) {
    const absolute = new URL(trimmedPath);
    if (intercom?.transportMode === 'secure-proxy' && intercom.mediaRootPath) {
      return new URL(`${intercom.mediaRootPath}${absolute.pathname}${absolute.search}`, base.origin);
    }
    return absolute;
  }

  if (trimmedPath.startsWith('/') && intercom?.mediaRootPath) {
    return new URL(`${intercom.mediaRootPath}${trimmedPath}`, base.origin);
  }

  return new URL(trimmedPath, mediaBase);
}

function resolveIntercomHistoryBase(intercom: CurrentIntercom): string | null {
  return resolveProxyMediaBase(intercom) || intercom.historyBaseUrl || intercom.mediaBaseUrl || null;
}

function resolveProxyMediaBase(intercom: CurrentIntercom): string | null {
  if (!intercom.origin || !intercom.deviceUuid) {
    return null;
  }
  return `${intercom.origin.replace(/\/$/, '')}/proxy/${encodeURIComponent(intercom.deviceUuid)}/`;
}

function resolveProxySnapshotUrl(intercom: CurrentIntercom): string | null {
  const proxyBase = resolveProxyMediaBase(intercom);
  return proxyBase ? new URL('jpg/image.jpg', proxyBase).toString() : null;
}

function isServerMediaUrl(url: URL, intercom?: CurrentIntercom): boolean {
  if (url.pathname.includes('/proxy/') || url.pathname.includes('/camimage/')) {
    return true;
  }
  if (!intercom?.origin) {
    return false;
  }
  try {
    return new URL(intercom.origin).host === url.host;
  } catch {
    return false;
  }
}

function inheritMediaAuth(url: URL, mediaBase: string, intercom?: CurrentIntercom): string {
  const base = new URL(mediaBase);
  const useServerToken = Boolean(intercom?.authToken && isServerMediaUrl(url, intercom));
  if (useServerToken) {
    url.username = '';
    url.password = '';
    url.searchParams.delete('auth');
    url.searchParams.set('autht', intercom!.authToken!);
    return url.toString();
  }
  if (intercom?.mediaAuthMode === 'basic') {
    if (!url.username && base.username && url.host === base.host) {
      url.username = base.username;
      url.password = base.password;
    }
    url.searchParams.delete('auth');
    url.searchParams.delete('autht');
    return url.toString();
  }
  if (intercom?.mediaAuthMode === 'token' && intercom.authToken) {
    url.username = '';
    url.password = '';
    url.searchParams.delete('auth');
    url.searchParams.set('autht', intercom.authToken);
  }
  return url.toString();
}

function resolveRenderableMediaUrl(sourceUrl: string, intercom: CurrentIntercom, bustCache: boolean): string {
  const url = new URL(sourceUrl);
  const useServerToken = Boolean(intercom.authToken && isServerMediaUrl(url, intercom));
  if (useServerToken) {
    url.username = '';
    url.password = '';
    url.searchParams.set('autht', intercom.authToken!);
    url.searchParams.delete('auth');
  } else if (intercom.mediaAuthMode === 'basic') {
    const mediaBase = intercom.mediaBaseUrl ? new URL(intercom.mediaBaseUrl) : null;
    if (!url.username && mediaBase?.username && url.host === mediaBase.host) {
      url.username = mediaBase.username;
      url.password = mediaBase.password;
    }
    url.searchParams.delete('auth');
    url.searchParams.delete('autht');
  } else if (intercom.mediaAuthMode === 'token' && intercom.authToken) {
    url.username = '';
    url.password = '';
    url.searchParams.set('autht', intercom.authToken);
    url.searchParams.delete('auth');
  }
  if (bustCache) {
    url.searchParams.set('cacheBuster', Date.now().toString());
  } else {
    url.searchParams.delete('cacheBuster');
  }
  return url.toString();
}

function normalizeIntercomActivityDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const unixMs = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(unixMs).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function formatBellLabel(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }
  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(parsed);
}

function attachRtcStreamToDom(): void {
  const media = document.querySelector('#intercom-live-media');
  const stream = intercomRtcSession.getRemoteStream();
  if (!(media instanceof HTMLVideoElement) || !stream) {
    return;
  }
  const markFrameVisible = () => {
    if (intercomRtcSession.noteRenderedVideoFrame()) {
      render();
    }
  };
  const isNewStream = media.srcObject !== stream;
  if (isNewStream) {
    media.srcObject = stream;
    media.addEventListener('loadedmetadata', () => {
      void ensureRtcVideoPlayback(media, true);
    }, { once: true });
    media.addEventListener('canplay', () => {
      void ensureRtcVideoPlayback(media, true);
    }, { once: true });
    media.addEventListener('loadeddata', markFrameVisible, { once: true });
    media.addEventListener('playing', markFrameVisible, { once: true });
    media.addEventListener('timeupdate', markFrameVisible, { once: true });
    if ('requestVideoFrameCallback' in media) {
      (media as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      }).requestVideoFrameCallback?.(() => {
        markFrameVisible();
      });
    }
  }
  media.muted = browserConversationState !== 'active';
  void ensureRtcVideoPlayback(media, isNewStream);
}

function normalizeRtcAnswer(value: unknown): RTCSessionDescriptionInit | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sdp = typeof record.sdp === 'string' ? record.sdp : null;
  if (!sdp) {
    return null;
  }
  const rawType = typeof record.type === 'string' ? record.type : 'answer';
  const type: RTCSdpType =
    rawType === 'offer' || rawType === 'answer' || rawType === 'pranswer' || rawType === 'rollback'
      ? rawType
      : 'answer';
  return { type, sdp };
}

async function ensureRtcVideoPlayback(media: HTMLVideoElement, forceRetry = false): Promise<void> {
  media.autoplay = true;
  media.playsInline = true;
  try {
    await media.play();
  } catch {
    // Some browsers need another kick after metadata/canplay or after a
    // render-driven element replacement.
  }

  if (rtcPlaybackRetryTimer !== null) {
    window.clearTimeout(rtcPlaybackRetryTimer);
    rtcPlaybackRetryTimer = null;
  }

  const needsRetry =
    forceRetry ||
    media.paused ||
    media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    media.currentTime === 0;

  if (!needsRetry) {
    return;
  }

  rtcPlaybackRetryTimer = window.setTimeout(() => {
    rtcPlaybackRetryTimer = null;
    const liveMedia = document.querySelector('#intercom-live-media');
    if (!(liveMedia instanceof HTMLVideoElement) || !liveMedia.srcObject) {
      return;
    }
    void liveMedia.play().catch(() => {
      // Keep the RTC preview best-effort; some kiosk browsers still require
      // a later retry once the frame pipeline is warm.
    });
  }, 750);
}
