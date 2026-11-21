import { throwIfAborted } from './abort';
import type {
  IntercomHistoryItem,
  IntercomRpcMethod,
  IntercomSignalError,
  IntercomSignalMessage,
  IntercomSignalRequest,
  IntercomViewModel,
} from './types';

const VIDEO_TIMEOUT_MS = 8_000;
const AUDIO_TRANSPORT_TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 128;
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.loxonecloud.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

type MediaErrorReason = IntercomSignalError | 'no-sdp' | 'audio-unsupported' | 'transport';
type CallAction = 'new' | 'add_audio' | 'remove_audio';

export class IntercomMediaError extends Error {
  constructor(readonly reason: MediaErrorReason, readonly method?: IntercomRpcMethod) {
    super(reason);
  }
}

interface PeerSession {
  id: number;
  peer: RTCPeerConnection;
  stream: MediaStream;
  controller: AbortController;
  videoReady: Promise<void>;
  audio: RTCRtpTransceiver | null;
  local: RTCIceCandidateInit[];
  remote: RTCIceCandidateInit[];
  needsGatheringNotice: boolean;
  negotiating: boolean;
  firstFrame: boolean;
  videoTimer: number | null;
  historyLoading: boolean;
}

interface MediaCallbacks {
  post: (message: IntercomSignalRequest) => void;
  changed: () => void;
  interrupted: () => void;
  history: (items: IntercomHistoryItem[], intercom: IntercomViewModel) => void;
}

export function supportsBrowserRtc(): boolean {
  return typeof RTCPeerConnection === 'function' &&
    typeof RTCPeerConnection.prototype.addTransceiver === 'function' &&
    typeof MediaStream === 'function' && typeof AbortController === 'function';
}

function peerConnectionState(peer: RTCPeerConnection): string {
  return peer.connectionState || peer.iceConnectionState;
}

/** The browser owns WebRTC and its tracks. The app worker owns the signaling socket. */
export class IntercomRtcSession {
  private intercom: IntercomViewModel | null = null;
  private session: PeerSession | null = null;
  private sessionSerial = 0;
  private requestSerial = 0;
  private retryTimer: number | null = null;
  private retryCount = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: IntercomMediaError) => void;
    method?: IntercomRpcMethod;
  }>();

  constructor(private readonly callbacks: MediaCallbacks) {}

  sync(intercom: IntercomViewModel | null): void {
    if (!intercom?.deviceUuid || !intercom.signalingUrl || !intercom.authToken ||
        !supportsBrowserRtc()) {
      intercom = null;
    }
    const previous = this.intercom;
    this.intercom = intercom;
    if (intercom?.uuidAction === previous?.uuidAction && intercom?.signalingUrl === previous?.signalingUrl) {
      if (intercom && previous?.doorbellActive && !intercom.doorbellActive && this.session) {
        void this.refreshHistory(this.session, intercom);
      }
      return;
    }
    this.clearRetry();
    this.retryCount = 0;
    this.closeSession();
    if (intercom) {
      this.startPreview();
    }
  }

  handle(message: IntercomSignalMessage): void {
    const session = this.session;
    if (!session || message.sessionId !== session.id) {
      return;
    }
    if (message.type === 'intercomSignalResult') {
      const request = this.pending.get(message.requestId);
      if (request) {
        this.pending.delete(message.requestId);
        if ('error' in message) {
          request.reject(new IntercomMediaError(message.error, request.method));
        } else {
          request.resolve(message.result);
        }
      }
      return;
    }
    if (message.event === 'closed') {
      this.recover(session);
      return;
    }
    const candidate = parseCandidate(message.params);
    if (!candidate) {
      return;
    }
    if (session.negotiating) {
      if (session.remote.length < MAX_CANDIDATES) {
        session.remote.push(candidate);
      }
    } else if (session.peer.remoteDescription) {
      void this.applyCandidate(session, candidate);
    }
  }

  getRemoteStream(): MediaStream | null {
    return this.session?.stream ?? null;
  }

  hasRemoteTrackFor(uuidAction: string): boolean {
    return this.intercom?.uuidAction === uuidAction &&
      Boolean(this.session?.stream.getVideoTracks().some(track => track.readyState === 'live'));
  }

  hasRemoteStreamFor(uuidAction: string): boolean {
    return this.hasRemoteTrackFor(uuidAction) && this.session?.firstFrame === true;
  }

  noteRenderedVideoFrame(stream: MediaStream): boolean {
    const session = this.session;
    if (!session || session.stream !== stream || session.firstFrame ||
        !stream.getVideoTracks().some(track => track.readyState === 'live')) {
      return false;
    }
    session.firstFrame = true;
    this.clearVideoTimer(session);
    this.retryCount = 0;
    return true;
  }

  async startConversation(track: MediaStreamTrack, attemptSignal: AbortSignal): Promise<void> {
    if (!this.session && this.intercom) {
      this.clearRetry();
      this.startPreview();
    }
    const session = this.session;
    if (!session) {
      throw new IntercomMediaError('transport');
    }
    await abortable(session.videoReady, attemptSignal);
    await waitForPeer(session.peer, session.controller.signal, attemptSignal);
    throwIfAborted(attemptSignal);

    try {
      const audio = session.audio ?? session.peer.addTransceiver('audio');
      session.audio = audio;
      audio.direction = 'sendrecv';
      await audio.sender.replaceTrack(track);
      await this.negotiate(session, 'add_audio');
      if (audio.currentDirection !== 'sendrecv' || audio.receiver.track.readyState !== 'live') {
        throw new IntercomMediaError('audio-unsupported');
      }
    } catch (error) {
      this.recover(session, false);
      throw error;
    }
  }

  async endConversation(): Promise<void> {
    const session = this.session;
    const audio = session?.audio;
    if (!session || !audio || audio.direction !== 'sendrecv') {
      return;
    }
    try {
      await audio.sender.replaceTrack(null);
      audio.direction = 'inactive';
      await this.negotiate(session, 'remove_audio');
    } catch {
      this.recover(session, false);
    }
  }

  private startPreview(): void {
    if (!this.intercom || this.session) {
      return;
    }
    const intercom = this.intercom;
    let peer: RTCPeerConnection;
    try {
      peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch {
      return;
    }
    const session: PeerSession = {
      id: ++this.sessionSerial,
      peer,
      stream: new MediaStream(),
      controller: new AbortController(),
      videoReady: Promise.resolve(),
      audio: null,
      local: [],
      remote: [],
      needsGatheringNotice: false,
      negotiating: true,
      firstFrame: false,
      videoTimer: null,
      historyLoading: false,
    };
    this.session = session;
    peer.ontrack = ({ track }) => {
      if (this.session !== session) {
        return;
      }
      session.stream.addTrack(track);
      if (track.kind === 'video') {
        track.onended = () => this.recover(session);
      }
      this.callbacks.changed();
    };
    const checkConnection = () => {
      const status = peerConnectionState(peer);
      if (status === 'failed' || status === 'closed') {
        this.recover(session);
      } else if (this.session === session && status === 'disconnected') {
        this.armVideoTimer(session);
      } else if (this.session === session && (status === 'connected' || status === 'completed') && session.firstFrame) {
        this.clearVideoTimer(session);
      }
    };
    peer.onconnectionstatechange = checkConnection;
    peer.oniceconnectionstatechange = checkConnection;
    peer.onicecandidate = ({ candidate }) => {
      if (this.session !== session) {
        return;
      }
      if (candidate) {
        if (session.negotiating) {
          if (session.local.length < MAX_CANDIDATES) {
            session.local.push(candidate.toJSON());
          }
        } else {
          this.sendCandidate(session, candidate);
        }
      } else if (session.negotiating) {
        session.needsGatheringNotice = true;
      } else {
        this.notifyGathered(session);
      }
    };
    const video = peer.addTransceiver('video', { direction: 'recvonly' });
    preferH264(video);
    session.videoReady = this.openAndStartVideo(session, intercom);
    void session.videoReady.catch(() => this.recover(session));
  }

  private async openAndStartVideo(session: PeerSession, intercom: IntercomViewModel): Promise<void> {
    await this.sendRequest(session, { operation: 'open', uuidAction: intercom.uuidAction });
    // Preserve the official app's bootstrap without making optional RPCs a
    // prerequisite for the preview.
    void this.request(session, 'info').catch(() => undefined);
    await this.negotiate(session, 'new');
    void this.refreshHistory(session, intercom);
    this.armVideoTimer(session);
  }

  private async negotiate(session: PeerSession, action: CallAction): Promise<void> {
    throwIfAborted(session.controller.signal);
    session.negotiating = true;
    const offer = await session.peer.createOffer();
    await session.peer.setLocalDescription(offer);
    const sdp = offer.sdp;
    if (!sdp) {
      throw new IntercomMediaError('no-sdp');
    }
    const params: unknown[] = [{ type: 'offer', sdp: trickleOffer(sdp) }, action, false];
    if (action !== 'new') {
      params.push(0);
    }
    const response = await this.request(session, 'call', params);
    const answer = response && typeof response === 'object' && 'sdp' in response ? response.sdp : null;
    if (typeof answer !== 'string' || !answer) {
      throw new IntercomMediaError('no-sdp');
    }
    await session.peer.setRemoteDescription({ type: 'answer', sdp: acceptH264Alias(sdp, answer) });
    session.negotiating = false;
    for (const candidate of session.remote.splice(0)) {
      await this.applyCandidate(session, candidate);
    }
    for (const candidate of session.local.splice(0)) {
      this.sendCandidate(session, candidate);
    }
    if (session.needsGatheringNotice) {
      session.needsGatheringNotice = false;
      this.notifyGathered(session);
    }
  }

  private async refreshHistory(session: PeerSession, intercom: IntercomViewModel): Promise<void> {
    if (session.historyLoading) {
      return;
    }
    session.historyLoading = true;
    try {
      const value = await this.request(session, 'getLastActivities', [0, 100, 2]);
      if (this.session === session && Array.isArray(value)) {
        this.callbacks.history(value as IntercomHistoryItem[], intercom);
      }
    } catch {
      // Media and Miniserver bell history remain usable without the archive.
    } finally {
      session.historyLoading = false;
    }
  }

  private sendCandidate(session: PeerSession, candidate: RTCIceCandidateInit): void {
    const params: unknown[] = [candidate.candidate, candidate.sdpMLineIndex, candidate.sdpMid];
    if (candidate.usernameFragment) {
      params.push(candidate.usernameFragment);
    }
    void this.request(session, 'addIceCandidate', params).catch(() => undefined);
  }

  private async applyCandidate(session: PeerSession, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await session.peer.addIceCandidate(candidate);
    } catch {
      // Invalid or obsolete candidates may arrive during a renegotiation.
    }
  }

  private notifyGathered(session: PeerSession): void {
    if (this.session === session) {
      this.callbacks.post({ type: 'intercomSignal', sessionId: session.id, operation: 'gathered' });
    }
  }

  private request(session: PeerSession, method: IntercomRpcMethod, params?: unknown[]): Promise<unknown> {
    return this.sendRequest(session, { operation: 'request', method, params });
  }

  private sendRequest(
    session: PeerSession,
    payload: { operation: 'open'; uuidAction: string } |
      { operation: 'request'; method: IntercomRpcMethod; params?: unknown[] },
  ): Promise<unknown> {
    if (this.session !== session) {
      return Promise.reject(new IntercomMediaError('closed'));
    }
    const requestId = ++this.requestSerial;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, method: 'method' in payload ? payload.method : undefined });
      this.callbacks.post({ type: 'intercomSignal', sessionId: session.id, requestId, ...payload });
    });
  }

  private recover(session: PeerSession, interrupted = true): void {
    if (this.session !== session) {
      return;
    }
    this.closeSession();
    if (interrupted) {
      this.callbacks.interrupted();
    }
    if (this.intercom) {
      const delay = Math.min(2_000 * 2 ** this.retryCount++, 30_000);
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = null;
        this.startPreview();
      }, delay);
    }
    this.callbacks.changed();
  }

  private armVideoTimer(session: PeerSession): void {
    this.clearVideoTimer(session);
    if (this.session === session && (!session.firstFrame || session.peer.connectionState === 'disconnected')) {
      session.videoTimer = window.setTimeout(() => this.recover(session), VIDEO_TIMEOUT_MS);
    }
  }

  private clearVideoTimer(session: PeerSession): void {
    if (session.videoTimer !== null) {
      clearTimeout(session.videoTimer);
      session.videoTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private closeSession(): void {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = null;
    this.callbacks.post({ type: 'intercomSignal', sessionId: session.id, operation: 'close' });
    this.clearVideoTimer(session);
    session.controller.abort(new IntercomMediaError('closed'));
    for (const request of this.pending.values()) {
      request.reject(new IntercomMediaError('closed'));
    }
    this.pending.clear();
    session.peer.ontrack = null;
    session.peer.onconnectionstatechange = null;
    session.peer.oniceconnectionstatechange = null;
    session.peer.onicecandidate = null;
    session.peer.close();
    for (const track of session.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new IntercomMediaError('closed'));
      return;
    }
    const abort = () => reject(signal.reason ?? new IntercomMediaError('closed'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function waitForPeer(peer: RTCPeerConnection, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signals.some(signal => signal.aborted)) {
      reject(new IntercomMediaError('closed'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener('connectionstatechange', check);
      peer.removeEventListener('iceconnectionstatechange', check);
      for (const signal of signals) {
        signal.removeEventListener('abort', abort);
      }
    };
    const abort = () => {
      cleanup();
      reject(new IntercomMediaError('closed'));
    };
    const check = () => {
      const status = peerConnectionState(peer);
      if (status === 'connected' || status === 'completed') {
        cleanup();
        resolve();
      } else if (status === 'failed' || status === 'closed') {
        cleanup();
        reject(new IntercomMediaError('transport'));
      }
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new IntercomMediaError('transport'));
    }, AUDIO_TRANSPORT_TIMEOUT_MS);
    peer.addEventListener('connectionstatechange', check);
    peer.addEventListener('iceconnectionstatechange', check);
    for (const signal of signals) {
      signal.addEventListener('abort', abort, { once: true });
    }
    check();
  });
}

function parseCandidate(params: unknown[]): RTCIceCandidateInit | null {
  const value = params[0];
  const object = value && typeof value === 'object' ? value as RTCIceCandidateInit : null;
  const candidate = object ? object.candidate : value;
  const index = object ? object.sdpMLineIndex : params[1];
  const mid = object ? object.sdpMid : params[2];
  const fragment = object ? object.usernameFragment : params[3];
  const sdpMLineIndex = typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 65536
    ? index
    : null;
  const sdpMid = typeof mid === 'string' && mid ? mid : null;
  if (typeof candidate !== 'string' || !candidate || (sdpMLineIndex === null && sdpMid === null)) {
    return null;
  }
  return {
    candidate: candidate.replace(/^a=/, ''), sdpMLineIndex, sdpMid,
    usernameFragment: typeof fragment === 'string' ? fragment : null,
  };
}

function preferH264(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
  const h264 = codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
  if (h264.length && transceiver.setCodecPreferences) {
    try {
      transceiver.setCodecPreferences([...h264, ...codecs.filter(codec => !h264.includes(codec))]);
    } catch {
      // The default codec order remains available.
    }
  }
}

function trickleOffer(sdp: string): string {
  const lines = sdp.trimEnd().split(/\r?\n/)
    .filter(line => !/^a=(?:candidate:|end-of-candidates)/.test(line));
  const firstMedia = lines.findIndex(line => line.startsWith('m='));
  if (firstMedia >= 0 && !lines.slice(0, firstMedia).some(line => /^a=ice-options:.*\btrickle\b/.test(line))) {
    lines.splice(firstMedia, 0, 'a=ice-options:trickle');
  }
  return lines.join('\r\n') + '\r\n';
}

/** Some firmware advertises PT 101 but emits PT 99. Only accept aliases offered
 * as H.264 by this browser, preserving all existing SDP lines and attributes. */
function acceptH264Alias(offer: string, answer: string): string {
  const offered = new Map(offer.split(/(?=^m=)/m).slice(1).map(section => {
    const lines = section.trimEnd().split(/\r?\n/);
    const mid = lines.find(line => line.startsWith('a=mid:'));
    return [mid, lines];
  }));
  return answer.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=video ')) {
      return section;
    }
    const lines = section.trimEnd().split(/\r?\n/);
    const fields = lines[0].split(' ');
    if (fields[1] === '0') {
      return section;
    }
    const offeredLines = offered.get(lines.find(line => line.startsWith('a=mid:')));
    if (!offeredLines?.[0].startsWith('m=video ')) {
      return section;
    }
    const aliasTypes = ['99', '101'];
    const h264 = /^a=rtpmap:(99|101) H264\//i;
    if (!lines.some(line => h264.test(line))) {
      return section;
    }
    const alias = aliasTypes.find(id => !fields.slice(3).includes(id) &&
      offeredLines.some(line => h264.exec(line)?.[1] === id));
    if (!alias) {
      return section;
    }
    const aliasAttributes = new RegExp(`^a=(?:rtpmap|fmtp|rtcp-fb):${alias} `);
    lines[0] += ` ${alias}`;
    lines.push(...offeredLines.filter(line => aliasAttributes.test(line)));
    return lines.join('\r\n') + '\r\n';
  }).join('');
}
