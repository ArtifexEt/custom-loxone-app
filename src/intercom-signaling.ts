import { CryptoJS, forge } from './loxone-crypto';
import type {
  IntercomRpcMethod,
  IntercomHistoryItem,
  IntercomSignalError,
  IntercomSignalMessage,
  IntercomSignalRequest,
  IntercomViewModel,
} from './types';

const OPEN_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HANGUP_TIMEOUT_MS = 700;
const SIGNALING_PROTOCOL = 'webrtc-signaling';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: SignalError) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SignalError extends Error {
  constructor(readonly reason: IntercomSignalError) {
    super(reason);
  }
}

export class IntercomSignaling {
  private current: SignalSocket | null = null;

  constructor(private readonly send: (message: IntercomSignalMessage) => void) {}

  keepFor(intercom: IntercomViewModel | null, username: string): void {
    if (this.current && !this.current.matches(intercom, username)) {
      this.current.close();
      this.current = null;
    }
  }

  async handle(
    message: IntercomSignalRequest,
    intercom: IntercomViewModel | null,
    username: string,
    localReach = false,
  ): Promise<void> {
    const { sessionId } = message;
    if (message.operation === 'close') {
      if (this.current?.id === sessionId) {
        this.current.close();
        this.current = null;
      }
      return;
    }
    if (message.operation === 'gathered') {
      if (this.current?.id === sessionId) {
        this.current.notify('iceGatheringFinished');
      }
      return;
    }
    if (!('requestId' in message)) {
      return;
    }

    const respond = (result: unknown) => this.send({
      type: 'intercomSignalResult', sessionId, requestId: message.requestId, result,
    });
    try {
      if (message.operation === 'open') {
        if (!intercom?.signalingUrl || !intercom.deviceUuid || !intercom.authToken ||
            intercom.uuidAction !== message.uuidAction || !username) {
          throw new SignalError('open');
        }
        this.current?.close();
        const socket = new SignalSocket(sessionId, intercom, username, localReach, this.send);
        this.current = socket;
        await socket.ready;
        respond(undefined);
        return;
      }
      if (this.current?.id !== sessionId) {
        throw new SignalError('closed');
      }
      respond(await this.current.request(message.method, message.params));
    } catch (error) {
      this.send({
        type: 'intercomSignalResult',
        sessionId,
        requestId: message.requestId,
        error: error instanceof SignalError ? error.reason : 'open',
      });
    }
  }
}

class SignalSocket {
  readonly ready: Promise<void>;
  private readonly socket: WebSocket;
  private openRequest: { resolve: () => void; reject: (error: SignalError) => void } | null = null;
  private readonly openTimer: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1000;
  private authenticated = false;
  private photoToken: string | null = null;
  private callStarted = false;
  private closing = false;
  private finished = false;

  constructor(
    readonly id: number,
    private readonly intercom: IntercomViewModel,
    private readonly username: string,
    private readonly localReach: boolean,
    private readonly send: (message: IntercomSignalMessage) => void,
  ) {
    this.socket = new WebSocket(intercom.signalingUrl!, SIGNALING_PROTOCOL);
    this.ready = new Promise<void>((resolve, reject) => {
      this.openRequest = { resolve, reject };
    });
    this.openTimer = setTimeout(() => this.finish('timeout'), OPEN_TIMEOUT_MS);
    this.socket.onopen = () => {
      if (this.socket.protocol !== SIGNALING_PROTOCOL) {
        this.finish('open');
      }
    };
    this.socket.onmessage = event => this.receive(event.data);
    this.socket.onerror = () => this.finish(this.openRequest ? 'open' : 'closed');
    this.socket.onclose = () => this.finish('closed');
  }

  matches(intercom: IntercomViewModel | null, username: string): boolean {
    return this.intercom.uuidAction === intercom?.uuidAction &&
      this.intercom.signalingUrl === intercom?.signalingUrl &&
      this.intercom.origin === intercom?.origin &&
      this.username === username && Boolean(intercom.authToken);
  }

  request(method: IntercomRpcMethod, params?: unknown[]): Promise<unknown> {
    if (this.closing || this.openRequest) {
      return Promise.reject(new SignalError('closed'));
    }
    if (method === 'call') {
      this.callStarted = true;
    }
    if (method === 'getLastActivities') {
      return this.fetchHistory(params);
    }
    return this.rpc(method, params);
  }

  private async fetchHistory(params?: unknown[]): Promise<IntercomHistoryItem[]> {
    let result: unknown;
    try {
      result = await this.rpc('getLastActivities', params);
    } catch (error) {
      if (!(error instanceof SignalError) || error.reason !== 'response' || params?.length !== 3) {
        throw error;
      }
      result = await this.rpc('getLastActivities', params.slice(0, 2));
    }
    const { origin, deviceUuid, address } = this.intercom;
    const proxy = origin && deviceUuid
      ? new URL(`${origin.replace(/\/$/, '')}/proxy/${encodeURIComponent(deviceUuid)}/`)
      : null;
    const direct = directArchiveBase(this.intercom);
    if ((!proxy && !direct) || !Array.isArray(result)) {
      return [];
    }

    const trustedHosts = [proxy?.host, address, direct?.host];
    const proxyPrefix = proxy?.pathname;
    const byTimestamp = new Map<string, IntercomHistoryItem>();
    for (const item of result.slice(0, 100)) {
      const record = asRecord(item);
      if (!record || (record.error != null && record.error !== 0 && record.error !== '0')) {
        continue;
      }
      const timestamp = activityTimestamp(record.date);
      if (!timestamp || byTimestamp.has(timestamp)) {
        continue;
      }
      const imagePaths = [record.imagePath, record.path, record.image];
      const thumbnailPaths = [record.thumbPath, record.thumbnailPath, record.thumbnail];
      const paths = [...imagePaths, ...thumbnailPaths];
      const previews = [...thumbnailPaths, ...imagePaths];
      const proxyImage = archiveImage(proxy, paths, trustedHosts, proxyPrefix);
      const proxyThumbnail = archiveImage(proxy, previews, trustedHosts, proxyPrefix);
      const directImage = archiveImage(direct, paths, trustedHosts, proxyPrefix, this.photoToken);
      const directThumbnail = archiveImage(direct, previews, trustedHosts, proxyPrefix, this.photoToken);
      const imageUrl = proxyImage ?? directImage;
      const thumbnailUrl = proxyThumbnail ?? directThumbnail;
      if (imageUrl) {
        byTimestamp.set(timestamp, {
          timestamp,
          label: timestamp,
          imageUrl,
          ...(thumbnailUrl && thumbnailUrl !== imageUrl ? { thumbnailUrl } : {}),
          ...(proxyImage && directImage ? { fallbackImageUrl: directImage } : {}),
          ...(proxyThumbnail && directThumbnail ? { fallbackThumbnailUrl: directThumbnail } : {}),
        });
      }
    }
    return [...byTimestamp.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  notify(method: string): void {
    if (!this.closing && !this.openRequest) {
      this.write({ jsonrpc: '2.0', method });
    }
  }

  close(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.rejectPending('closed');
    if (this.callStarted && this.socket.readyState === WebSocket.OPEN) {
      void this.rpc('hangup', undefined, HANGUP_TIMEOUT_MS)
        .catch(() => undefined)
        .finally(() => this.finish('closed'));
      return;
    }
    this.finish('closed');
  }

  private rpc(method: IntercomRpcMethod, params?: unknown[], timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalError('timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SignalError('closed'));
      }
    });
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') {
      return;
    }
    let message: Record<string, unknown> | null;
    try {
      message = asRecord(JSON.parse(raw));
    } catch {
      return;
    }
    if (message?.jsonrpc !== '2.0') {
      return;
    }
    const { id, method } = message;
    if (typeof method !== 'string') {
      this.acceptResult(id, message);
      return;
    }
    if (this.closing) {
      return;
    }
    const params = Array.isArray(message.params) ? message.params : [];
    if (method === 'kick' || method === 'hangup') {
      this.acknowledge(id);
      this.finish(this.openRequest ? 'auth' : 'closed');
      return;
    }
    if (method === 'authenticate' && this.openRequest && !this.authenticated) {
      try {
        const response = buildAuthentication(params, this.username, this.intercom.authToken!);
        if (!this.acknowledge(id, response)) {
          throw new SignalError('auth');
        }
        this.authenticated = true;
        this.photoToken = params[0] as string;
      } catch {
        this.finish('auth');
      }
      return;
    }
    if (method === 'ready' && this.openRequest) {
      if (!this.authenticated) {
        this.finish('auth');
        return;
      }
      this.acknowledge(id);
      clearTimeout(this.openTimer);
      this.openRequest.resolve();
      this.openRequest = null;
      return;
    }
    if (method === 'reachMode') {
      // The proven LAN flow uses ReachMode 2. Keep the existing proxy acknowledgement
      // for Remote Connect, whose reach-mode value is not documented.
      this.acknowledge(id, this.localReach ? [2] : undefined);
      return;
    }
    this.acknowledge(id);
    if (method === 'addIceCandidate' && this.authenticated) {
      this.send({ type: 'intercomSignalEvent', sessionId: this.id, event: 'candidate', params });
    }
  }

  private acceptResult(id: unknown, message: Record<string, unknown>): void {
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!entry) {
      if (this.openRequest && message.error != null) {
        this.finish('auth');
      }
      return;
    }
    this.pending.delete(id as number);
    clearTimeout(entry.timer);
    const envelope = asRecord(message.result);
    const code = envelope?.code;
    if (message.error != null || (typeof code === 'number' && (code < 200 || code >= 300))) {
      entry.reject(new SignalError('response'));
      return;
    }
    entry.resolve(envelope && 'data' in envelope ? envelope.data : message.result);
  }

  private acknowledge(id: unknown, data?: unknown): boolean {
    if (typeof id !== 'string' && typeof id !== 'number') {
      return false;
    }
    return this.write({
      jsonrpc: '2.0', id,
      result: { code: 200, message: 'Ok', ...(data === undefined ? {} : { data }) },
    });
  }

  private write(message: unknown): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private finish(reason: IntercomSignalError): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.photoToken = null;
    const wasReady = this.openRequest === null;
    clearTimeout(this.openTimer);
    this.openRequest?.reject(new SignalError(reason));
    this.openRequest = null;
    this.rejectPending(reason);
    this.closing = true;
    this.socket.onopen = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    this.socket.onmessage = null;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    if (wasReady) {
      this.send({ type: 'intercomSignalEvent', sessionId: this.id, event: 'closed' });
    }
  }

  private rejectPending(reason: IntercomSignalError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new SignalError(reason));
    }
    this.pending.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function activityTimestamp(value: unknown): string | null {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null;
  const timestamp = numeric !== null ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : typeof value === 'string' ? Date.parse(value) : NaN;
  const date = new Date(timestamp);
  return timestamp > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function directArchiveBase(intercom: IntercomViewModel): URL | null {
  if (intercom.transportMode !== 'lan-direct' || !intercom.historyBaseUrl || !intercom.signalingUrl) {
    return null;
  }
  const base = new URL(intercom.historyBaseUrl);
  const signaling = new URL(intercom.signalingUrl);
  signaling.protocol = signaling.protocol === 'wss:' ? 'https:' : 'http:';
  if (signaling.origin !== base.origin) {
    return null;
  }
  base.username = '';
  base.password = '';
  base.search = '';
  base.hash = '';
  return base;
}

function archiveImage(
  base: URL | null,
  candidates: unknown[],
  trustedHosts: Array<string | null | undefined>,
  proxyPrefix: string | undefined,
  token?: string | null,
): string | null {
  if (!base || token === null) {
    return null;
  }
  for (const value of candidates) {
    const photo = resolveArchiveImage(base, value, trustedHosts, proxyPrefix, token);
    if (photo) {
      return photo;
    }
  }
  return null;
}

function resolveArchiveImage(
  base: URL,
  value: unknown,
  trustedHosts: Array<string | null | undefined>,
  proxyPrefix: string | undefined,
  token?: string,
): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 ||
      value.startsWith('//') || /[\u0000-\u0020\u007f\\#]/.test(value)) {
    return null;
  }
  const separator = value.indexOf('?');
  let path = separator < 0 ? value : value.slice(0, separator);
  if (/^https?:\/\//i.test(path)) {
    const hostStart = path.indexOf('://') + 3;
    const pathStart = path.indexOf('/', hostStart);
    if (pathStart < 0) {
      return null;
    }
    try {
      const url = new URL(path.slice(0, pathStart));
      if (url.username || url.password || !trustedHosts.includes(url.host)) {
        return null;
      }
    } catch {
      return null;
    }
    path = path.slice(pathStart);
  }

  // Strip only this Intercom's existing proxy prefix. Keep the supplied query
  // bytes, because some firmware signs the activity URL's original parameters.
  const hasProxyPrefix = proxyPrefix && path.startsWith(proxyPrefix);
  if (!hasProxyPrefix && /^\/?proxy\//i.test(path)) {
    return null;
  }
  const relative = hasProxyPrefix ? path.slice(proxyPrefix.length) : path.replace(/^\//, '');
  if (!/^[a-z0-9._~+=/-]+$/i.test(relative) ||
      !(/^(images|jpg|snapshots)\//i.test(relative) || /\.jpe?g$/i.test(relative)) ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    return null;
  }
  const url = new URL(relative, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    return null;
  }
  const query = separator < 0 ? [] : value.slice(separator + 1).split('&').filter((pair) => {
    if (!pair) return false;
    try {
      return !/^(auth|autht)$/i.test(decodeURIComponent(pair.split('=', 1)[0]));
    } catch {
      return false;
    }
  });
  if (token) {
    query.push(`autht=${encodeURIComponent(token)}`);
  }
  return query.length ? `${url.href}?${query.join('&')}` : url.href;
}

function buildAuthentication(params: unknown[], username: string, token: string): [string, string, string] {
  const [challenge, modulus, exponent, pem] = params;
  if (typeof challenge !== 'string' || !challenge || challenge.length > 256) {
    throw new SignalError('auth');
  }
  let publicKey: forge.pki.PublicKey;
  if (typeof pem === 'string' && pem.length <= 18_000 && pem) {
    publicKey = pem.startsWith('-----BEGIN CERTIFICATE-----')
      ? forge.pki.certificateFromPem(pem).publicKey
      : forge.pki.publicKeyFromPem(pem);
  } else if (typeof modulus === 'string' && /^[a-f\d]{1,2048}$/i.test(modulus) &&
             typeof exponent === 'string' && /^[a-f\d]{1,16}$/i.test(exponent)) {
    publicKey = forge.pki.setRsaPublicKey(
      new forge.jsbn.BigInteger(modulus, 16), new forge.jsbn.BigInteger(exponent, 16),
    );
  } else {
    throw new SignalError('auth');
  }

  if (!('n' in publicKey)) {
    throw new SignalError('auth');
  }
  const bits = publicKey.n.bitLength();
  if (bits < 2048 || bits > 8192) {
    throw new SignalError('auth');
  }
  const key = CryptoJS.lib.WordArray.random(32);
  const iv = CryptoJS.lib.WordArray.random(16);
  const envelope = forge.util.encodeUtf8(`${key.toString(CryptoJS.enc.Hex)}:${iv.toString(CryptoJS.enc.Hex)}:${challenge}`);
  const encryptedEnvelope = forge.util.encode64(publicKey.encrypt(envelope, 'RSAES-PKCS1-V1_5'));
  const encryptedToken = CryptoJS.AES.encrypt(token, key, { iv });
  return [username, encryptedEnvelope, encryptedToken.ciphertext.toString(CryptoJS.enc.Base64)];
}
