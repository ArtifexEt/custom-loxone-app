import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

async function readConfig() {
  if (process.argv[2]) {
    const [appUrl, origin, username, password] = process.argv.slice(2);
    return { appUrl, origin, username, password };
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const config = await readConfig();
const appUrl = config?.appUrl;
const origin = config?.origin;
const username = config?.username;
const password = config?.password;

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/run-live-check.mjs <appUrl> <origin> <username> <password>');
  console.error('or pipe JSON: {"appUrl":"...","origin":"...","username":"...","password":"..."}');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const page = await context.newPage();
const failedRequests = [];
const responseHits = [];
const consoleMessages = [];
const webSocketEvents = [];

await context.addInitScript(() => {
  const rtcEvents = [];
  const wsAttempts = [];
  const signalingFrames = [];
  const workerPosts = [];
  let lastWorkerState = null;
  const push = (kind, payload) => {
    rtcEvents.push({ ts: Date.now(), kind, payload });
  };
  window.__rtcEvents = rtcEvents;
  window.__wsAttempts = wsAttempts;
  window.__signalingFrames = signalingFrames;
  window.__workerPosts = workerPosts;
  window.__lastWorkerState = () => lastWorkerState;
  const NativeWebSocket = window.WebSocket;
  const NativeWorker = window.Worker;
  class DebugWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.addEventListener('message', (event) => {
        const data = event.data;
        if (data && typeof data === 'object' && data.type === 'state' && data.state) {
          lastWorkerState = data.state;
        }
      });
    }

    postMessage(message, transfer) {
      workerPosts.push({
        ts: Date.now(),
        type: message?.type ?? null,
        payload:
          message && typeof message === 'object'
            ? JSON.parse(
                JSON.stringify(message, (_key, value) =>
                  typeof value === 'string' && value.length > 160
                    ? `${value.slice(0, 160)}…`
                    : value,
                ),
              )
            : message,
      });
      return super.postMessage(message, transfer);
    }
  }
  window.Worker = DebugWorker;
  class DebugWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const protocolList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      const signaling = protocolList.includes('webrtc-signaling') || String(url).includes('/proxy/');
      const recordSignalFrame = (kind, payload) => {
        if (!signaling) {
          return;
        }
        signalingFrames.push({
          ts: Date.now(),
          kind,
          url: String(url),
          payload: String(payload).slice(0, 2000),
        });
      };
      wsAttempts.push({
        ts: Date.now(),
        kind: 'construct',
        url: String(url),
        protocols: protocolList,
      });
      this.addEventListener('open', () => {
        wsAttempts.push({ ts: Date.now(), kind: 'open', url: String(url) });
      });
      this.addEventListener('error', () => {
        wsAttempts.push({ ts: Date.now(), kind: 'error', url: String(url) });
      });
      this.addEventListener('close', () => {
        wsAttempts.push({ ts: Date.now(), kind: 'close', url: String(url) });
      });
      this.addEventListener('message', (event) => {
        recordSignalFrame('received', event.data);
      });
      const nativeSend = this.send.bind(this);
      this.send = (payload) => {
        recordSignalFrame('sent', payload);
        return nativeSend(payload);
      };
    }
  }
  window.WebSocket = DebugWebSocket;
  const NativeRTCPeerConnection = window.RTCPeerConnection;
  class DebugRTCPeerConnection extends NativeRTCPeerConnection {
    constructor(config) {
      super(config);
      push('rtc:create', { config });
      this.addEventListener('track', (event) =>
        push('rtc:track', {
          kind: event.track?.kind ?? null,
          streams: event.streams?.map((stream) => stream.id) ?? [],
        }),
      );
      this.addEventListener('connectionstatechange', () =>
        push('rtc:connectionstatechange', { state: this.connectionState }),
      );
      this.addEventListener('iceconnectionstatechange', () =>
        push('rtc:iceconnectionstatechange', { state: this.iceConnectionState }),
      );
      this.addEventListener('signalingstatechange', () =>
        push('rtc:signalingstatechange', { state: this.signalingState }),
      );
    }

    async createOffer(...args) {
      push('rtc:createOffer:start', {});
      const offer = await super.createOffer(...args);
      push('rtc:createOffer:done', {
        type: offer.type,
        sdp: offer.sdp?.slice(0, 400) ?? '',
      });
      return offer;
    }

    async setLocalDescription(description) {
      push('rtc:setLocalDescription', {
        type: description?.type ?? null,
        sdp: description?.sdp?.slice(0, 400) ?? '',
      });
      return super.setLocalDescription(description);
    }

    async setRemoteDescription(description) {
      push('rtc:setRemoteDescription', {
        type: description?.type ?? null,
        sdp: description?.sdp?.slice(0, 400) ?? '',
      });
      return super.setRemoteDescription(description);
    }

    async addIceCandidate(candidate) {
      push('rtc:addIceCandidate', {
        candidate: candidate?.candidate ?? null,
        sdpMLineIndex: candidate?.sdpMLineIndex ?? null,
        sdpMid: candidate?.sdpMid ?? null,
      });
      return super.addIceCandidate(candidate);
    }
  }
  window.RTCPeerConnection = DebugRTCPeerConnection;
});

page.on('requestfailed', (request) => {
  failedRequests.push({
    url: request.url(),
    method: request.method(),
    error: request.failure()?.errorText ?? 'unknown',
  });
});

page.on('response', async (response) => {
  const url = response.url();
  if (!/proxy\/|camimage|rfc6455|getPublicKey|getkey2|getjwt|fenc/.test(url)) {
    return;
  }
  responseHits.push({
    url,
    status: response.status(),
  });
});

page.on('console', (message) => {
  consoleMessages.push({
    type: message.type(),
    text: message.text(),
  });
});

page.on('websocket', (ws) => {
  const url = ws.url();
  webSocketEvents.push({ kind: 'open', url });
  ws.on('framesent', (event) => {
    webSocketEvents.push({
      kind: 'sent',
      url,
      payload: String(event.payload).slice(0, 500),
    });
  });
  ws.on('framereceived', (event) => {
    webSocketEvents.push({
      kind: 'received',
      url,
      payload: String(event.payload).slice(0, 500),
    });
  });
  ws.on('close', () => {
    webSocketEvents.push({ kind: 'close', url });
  });
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const originInput = page.locator('input[name="origin"]');
if (await originInput.count()) {
  const formSnapshotBeforeFill = await page.evaluate(() => {
    const originField = document.querySelector('input[name="origin"]');
    const usernameField = document.querySelector('input[name="username"]');
    const passwordField = document.querySelector('input[name="password"]');
    return {
      originValue: originField instanceof HTMLInputElement ? originField.value : null,
      usernameValue: usernameField instanceof HTMLInputElement ? usernameField.value : null,
      passwordLength: passwordField instanceof HTMLInputElement ? passwordField.value.length : null,
    };
  });
  console.error('formSnapshotBeforeFill', JSON.stringify(formSnapshotBeforeFill));
  await originInput.fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  const formSnapshotAfterFill = await page.evaluate(() => {
    const originField = document.querySelector('input[name="origin"]');
    const usernameField = document.querySelector('input[name="username"]');
    const passwordField = document.querySelector('input[name="password"]');
    return {
      originValue: originField instanceof HTMLInputElement ? originField.value : null,
      usernameValue: usernameField instanceof HTMLInputElement ? usernameField.value : null,
      passwordLength: passwordField instanceof HTMLInputElement ? passwordField.value.length : null,
    };
  });
  console.error('formSnapshotAfterFill', JSON.stringify(formSnapshotAfterFill));
  const submitButton = page.locator('form[data-form="server"] button[type="submit"]');
  if (await submitButton.count()) {
    await submitButton.first().click({ force: true });
  }
}

await page.waitForTimeout(7000);

const addIntercomButton = page.locator('button[data-action="add-intercom-view"]');
if (await addIntercomButton.count()) {
  await addIntercomButton.first().click({ force: true });
  await page.waitForTimeout(2000);
}

const connectButton = page.locator('[data-action="connect-toggle"]');
if (await connectButton.count()) {
  await connectButton.first().click({ force: true });
}

await page.waitForTimeout(12000);

const summary = await page.evaluate(() => {
  const media = document.querySelector('.intercom-media');
  const video = document.querySelector('#intercom-live-media');
  const historyTab = document.querySelector('[data-action="open-side-panel"][data-tab="history"]');
  const connect = document.querySelector('[data-action="connect-toggle"]');
  return {
    bodyText: document.body.innerText,
    mediaTag: media?.tagName ?? null,
    mediaSrc: media instanceof HTMLImageElement || media instanceof HTMLVideoElement ? media.currentSrc || media.getAttribute('src') || '' : '',
    videoSrcObject: Boolean(video && 'srcObject' in video && video.srcObject),
    videoPaused: video instanceof HTMLVideoElement ? video.paused : null,
    videoCurrentTime: video instanceof HTMLVideoElement ? video.currentTime : null,
    videoReadyState: video instanceof HTMLVideoElement ? video.readyState : null,
    videoWidth: video instanceof HTMLVideoElement ? video.videoWidth : null,
    videoHeight: video instanceof HTMLVideoElement ? video.videoHeight : null,
    connectLabel: connect?.textContent?.trim() ?? '',
    connectDisabled: connect instanceof HTMLButtonElement ? connect.disabled : null,
    hasHistoryTab: Boolean(historyTab),
    mediaFrameText: document.querySelector('.media-frame')?.textContent?.trim() ?? '',
    rtcEvents: window.__rtcEvents ?? [],
    wsAttempts: window.__wsAttempts ?? [],
    signalingFrames: window.__signalingFrames ?? [],
    workerPosts: window.__workerPosts ?? [],
    workerIntercom:
      typeof window.__lastWorkerState === 'function'
        ? (() => {
            const state = window.__lastWorkerState();
            const intercom = state?.currentView?.intercom;
            return intercom
              ? {
                  transportMode: intercom.transportMode ?? null,
                  deviceUuid: intercom.deviceUuid ?? null,
                  signalingUrl: intercom.signalingUrl ?? null,
                  snapshotUrl: intercom.snapshotUrl ?? null,
                  streamUrl: intercom.streamUrl ?? null,
                  authToken: intercom.authToken ? 'present' : 'missing',
                  historyCount: Array.isArray(intercom.history) ? intercom.history.length : null,
                }
              : null;
          })()
        : null,
  };
});

const persistedDump = await page.evaluate(async () => {
  const openDb = await new Promise((resolve, reject) => {
    const request = indexedDB.open('custom-loxone-app');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const db = openDb;
  const cache = await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const request = store.get('cache');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ?? null);
  });
  const structure = cache?.structure ?? null;
  const controls = Array.isArray(structure?.controls) ? structure.controls : [];
  const intercomControls = controls
    .filter((control) => String(control?.type ?? '').toLowerCase().includes('intercom'))
    .map((control) => ({
      name: control?.name ?? null,
      type: control?.type ?? null,
      uuidAction: control?.uuidAction ?? null,
      parentUuidAction: control?.parentUuidAction ?? null,
      roomName: control?.roomName ?? null,
      path: control?.path ?? [],
      states: control?.states ?? {},
      detailsKeys: Object.keys(control?.details ?? {}),
      detailsSnippet: JSON.stringify(control?.details ?? {}).slice(0, 2400),
    }));
  const proxyControls = controls
    .filter((control) => JSON.stringify(control?.details ?? {}).includes('/proxy/'))
    .map((control) => ({
      name: control?.name ?? null,
      type: control?.type ?? null,
      uuidAction: control?.uuidAction ?? null,
      parentUuidAction: control?.parentUuidAction ?? null,
      roomName: control?.roomName ?? null,
      path: control?.path ?? [],
      detailsKeys: Object.keys(control?.details ?? {}),
      detailsSnippet: JSON.stringify(control?.details ?? {}).slice(0, 1200),
    }));
  const audioControls = controls
    .filter((control) => {
      const type = String(control?.type ?? '').toLowerCase();
      const name = String(control?.name ?? '').toLowerCase();
      return type.includes('audio') || name.includes('audio');
    })
    .map((control) => ({
      name: control?.name ?? null,
      type: control?.type ?? null,
      uuidAction: control?.uuidAction ?? null,
      parentUuidAction: control?.parentUuidAction ?? null,
      roomName: control?.roomName ?? null,
      path: control?.path ?? [],
      detailsKeys: Object.keys(control?.details ?? {}),
      detailsSnippet: JSON.stringify(control?.details ?? {}).slice(0, 1200),
    }));
  return {
    structureSerial: structure?.serial ?? null,
    controlCount: controls.length,
    intercomControls,
    proxyControls,
    audioControls,
  };
});

const proxyProbe = await page.evaluate(async () => {
  const media = document.querySelector('.intercom-media');
  const mediaSrc =
    media instanceof HTMLImageElement || media instanceof HTMLVideoElement
      ? media.currentSrc || media.getAttribute('src') || ''
      : '';
  if (!mediaSrc || !mediaSrc.includes('/jpg/image.jpg')) {
    return { streamUrl: '', status: null, contentType: '', textSample: '' };
  }
  const streamUrl = mediaSrc.replace('/jpg/image.jpg', '/mjpg/video.mjpg');
  const response = await fetch(streamUrl);
  const reader = response.body?.getReader();
  let textSample = '';
  if (reader) {
    const chunk = await reader.read();
    if (!chunk.done && chunk.value) {
      textSample = new TextDecoder().decode(chunk.value.slice(0, 120));
    }
    await reader.cancel().catch(() => {});
  }
  return {
    streamUrl,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    textSample,
  };
});

await page.screenshot({ path: 'tmp-playwright/live-check.png', fullPage: true });
await browser.close();

const result = { summary, persistedDump, proxyProbe, failedRequests, responseHits, consoleMessages, webSocketEvents };
await writeFile('tmp-playwright/live-check-last.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
