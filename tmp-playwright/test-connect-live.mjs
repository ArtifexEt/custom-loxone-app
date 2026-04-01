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
const mode = config?.mode ?? 'custom';

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/test-connect-live.mjs <appUrl> <origin> <username> <password>');
  console.error('or pipe JSON: {"appUrl":"...","origin":"...","username":"...","password":"..."}');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
const webSocketEvents = [];

page.on('console', (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() });
});

page.on('pageerror', (error) => {
  pageErrors.push({ message: error.message, stack: error.stack ?? '' });
});

page.on('requestfailed', (request) => {
  failedRequests.push({
    url: request.url(),
    method: request.method(),
    error: request.failure()?.errorText ?? 'unknown',
  });
});

page.on('websocket', (ws) => {
  const url = ws.url();
  webSocketEvents.push({ kind: 'open', url });
  ws.on('framesent', (event) => {
    const payload = event.payload;
    webSocketEvents.push({
      kind: 'sent',
      url,
      payloadType:
        typeof payload === 'string'
          ? 'string'
          : payload instanceof Buffer
            ? 'buffer'
            : payload instanceof ArrayBuffer
              ? 'arraybuffer'
              : ArrayBuffer.isView(payload)
                ? 'typedarray'
                : typeof payload,
      payloadBase64:
        payload instanceof Buffer
          ? payload.toString('base64')
          : payload instanceof ArrayBuffer
            ? Buffer.from(payload).toString('base64')
            : ArrayBuffer.isView(payload)
              ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('base64')
              : null,
      payload: String(payload).slice(0, 800),
    });
  });
  ws.on('framereceived', (event) => {
    const payload = event.payload;
    webSocketEvents.push({
      kind: 'received',
      url,
      payloadType:
        typeof payload === 'string'
          ? 'string'
          : payload instanceof Buffer
            ? 'buffer'
            : payload instanceof ArrayBuffer
              ? 'arraybuffer'
              : ArrayBuffer.isView(payload)
                ? 'typedarray'
                : typeof payload,
      payloadBase64:
        payload instanceof Buffer
          ? payload.toString('base64')
          : payload instanceof ArrayBuffer
            ? Buffer.from(payload).toString('base64')
            : ArrayBuffer.isView(payload)
              ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('base64')
              : null,
      payload: String(payload).slice(0, 800),
    });
  });
  ws.on('close', () => {
    webSocketEvents.push({ kind: 'close', url });
  });
});

await context.addInitScript(() => {
  const rtcEvents = [];
  const rtcDescriptions = [];
  const workerPosts = [];
  let lastWorkerState = null;
  const actionEvents = [];
  const workerStates = [];
  const authFetches = [];

  const pushRtc = (kind, payload) => {
    rtcEvents.push({ ts: Date.now(), kind, payload });
  };

  window.__rtcConnectDebug = rtcEvents;
  window.__rtcDescriptions = rtcDescriptions;
  window.__workerPosts = workerPosts;
  window.__lastWorkerState = () => lastWorkerState;
  window.__actionEvents = actionEvents;
  window.__workerStates = workerStates;
  window.__authFetches = authFetches;

  const recordActionEvent = (type, event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    actionEvents.push({
      ts: Date.now(),
      type,
      action: target.dataset.action ?? null,
      viewId: target.dataset.viewId ?? null,
      disabled:
        target instanceof HTMLButtonElement ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
          ? target.disabled
          : target.getAttribute('disabled') !== null,
      text: target.textContent?.trim() ?? '',
    });
  };

  document.addEventListener('pointerdown', (event) => recordActionEvent('pointerdown', event), true);
  document.addEventListener('click', (event) => recordActionEvent('click', event), true);

  const NativeWorker = window.Worker;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const input = args[0];
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url ?? '';
    const response = await nativeFetch(...args);
    if (/getPublicKey|getkey2|getjwt|gettoken|fenc/i.test(requestUrl) || /getPublicKey|getkey2|getjwt|gettoken|fenc/i.test(response.url)) {
      let bodySnippet = '';
      try {
        bodySnippet = (await response.clone().text()).slice(0, 400);
      } catch {
        bodySnippet = '<unreadable>';
      }
      authFetches.push({
        ts: Date.now(),
        requestUrl,
        responseUrl: response.url,
        status: response.status,
        redirected: response.redirected,
        bodySnippet,
      });
    }
    return response;
  };
  class DebugWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.addEventListener('message', (event) => {
        const data = event.data;
        if (data && typeof data === 'object' && data.type === 'state' && data.state) {
          lastWorkerState = data.state;
          workerStates.push({
            ts: Date.now(),
            screen: data.state.screen ?? null,
            connectionStatus: data.state.connection?.status ?? null,
            notice: data.state.notice?.message ?? null,
            miniserverName: data.state.miniserverName ?? null,
            hasStructure: Array.isArray(data.state.intercoms) ? data.state.intercoms.length > 0 : false,
            activeViewId: data.state.activeViewId ?? null,
          });
        }
      });
    }

    postMessage(message, transfer) {
      workerPosts.push({
        ts: Date.now(),
        type: message?.type ?? null,
      });
      return super.postMessage(message, transfer);
    }
  }
  window.Worker = DebugWorker;

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  class DebugRTCPeerConnection extends NativeRTCPeerConnection {
    async createOffer(...args) {
      const offer = await super.createOffer(...args);
      rtcDescriptions.push({
        kind: 'offer',
        type: offer.type,
        sdp: offer.sdp,
      });
      return offer;
    }

    async setRemoteDescription(description) {
      rtcDescriptions.push({
        kind: 'answer',
        type: description?.type ?? null,
        sdp: description?.sdp ?? null,
      });
      return super.setRemoteDescription(description);
    }

    constructor(config) {
      super(config);
      pushRtc('rtc:create', { config });
      this.addEventListener('track', (event) => {
        pushRtc('rtc:track', {
          kind: event.track?.kind ?? null,
          streams: event.streams?.map((stream) => stream.id) ?? [],
        });
      });
      this.addEventListener('connectionstatechange', () => {
        pushRtc('rtc:connectionstatechange', { state: this.connectionState });
      });
      this.addEventListener('iceconnectionstatechange', () => {
        pushRtc('rtc:iceconnectionstatechange', { state: this.iceConnectionState });
      });
      this.addEventListener('signalingstatechange', () => {
        pushRtc('rtc:signalingstatechange', { state: this.signalingState });
      });
    }
  }
  window.RTCPeerConnection = DebugRTCPeerConnection;
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

if (mode === 'official') {
  const userField = page.locator('input').first();
  const passwordField = page.locator('input[type="password"], input').nth(1);
  await userField.waitFor({ state: 'visible', timeout: 15000 });
  await userField.fill(username);
  await passwordField.fill(password);
  const loginButton = page.locator('button').filter({ hasText: /Połącz|Connect|Login|Zaloguj/i }).first();
  await loginButton.click({ force: true });
  await page.waitForTimeout(15000);
  await page.waitForLoadState('networkidle').catch(() => {});
} else if (await page.locator('input[name="origin"]').count()) {
  await page.locator('input[name="origin"]').fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[data-form="server"] button[type="submit"]').click({ force: true });
  await page.waitForLoadState('networkidle').catch(() => {});
}

if (mode !== 'official') {
  const addIntercomButton = page.locator('button[data-action="add-intercom-view"]');
  await addIntercomButton.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  if (await addIntercomButton.count()) {
    await addIntercomButton.first().click({ force: true });
    await page.waitForTimeout(3000);
  }
}

const connectButtonReady =
  mode === 'official'
    ? page.locator('button').filter({ hasText: /Połącz|Connect|Answer|Odbierz/i }).first()
    : page.locator('[data-action="connect-toggle"]').first();
await connectButtonReady.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

const beforeClick = await page.evaluate(() => {
  const media = document.querySelector('.intercom-media');
  const connect =
    document.querySelector('[data-action="connect-toggle"]') ??
    Array.from(document.querySelectorAll('button')).find((button) =>
      /Połącz|Connect|Answer|Odbierz/i.test(button.textContent ?? ''),
    ) ??
    null;
  return {
    bodyText: document.body.innerText,
    connectLabel: connect?.textContent?.trim() ?? '',
    connectDisabled: connect instanceof HTMLButtonElement ? connect.disabled : null,
    mediaTag: media?.tagName ?? null,
    mediaCurrentSrc:
      media instanceof HTMLImageElement || media instanceof HTMLVideoElement
        ? media.currentSrc || media.getAttribute('src') || ''
        : '',
    videoSrcObject: media instanceof HTMLVideoElement ? Boolean(media.srcObject) : false,
    videoPaused: media instanceof HTMLVideoElement ? media.paused : null,
    videoCurrentTime: media instanceof HTMLVideoElement ? media.currentTime : null,
  };
});

const connectButton =
  mode === 'official'
    ? page.locator('button').filter({ hasText: /Połącz|Connect|Answer|Odbierz/i }).first()
    : page.locator('[data-action="connect-toggle"]').first();
let connectDispatch = null;
if (await connectButton.count()) {
  await connectButton.click({ force: true });
  connectDispatch = await page.evaluate(() => {
    const button =
      document.querySelector('[data-action="connect-toggle"]') ??
      Array.from(document.querySelectorAll('button')).find((candidate) =>
        /Połącz|Connect|Answer|Odbierz/i.test(candidate.textContent ?? ''),
      ) ??
      null;
    if (!(button instanceof HTMLElement)) {
      return { found: false };
    }
    return {
      found: true,
      disabled: button instanceof HTMLButtonElement ? button.disabled : null,
      text: button.textContent?.trim() ?? '',
    };
  });
}

await page.waitForTimeout(6000);

const afterClick = await page.evaluate(() => {
  const media = document.querySelector('.intercom-media');
  const live = document.querySelector('#intercom-live-media');
  const connect =
    document.querySelector('[data-action="connect-toggle"]') ??
    Array.from(document.querySelectorAll('button')).find((button) =>
      /Połącz|Connect|Answer|Odbierz|Rozłącz|Disconnect/i.test(button.textContent ?? ''),
    ) ??
    null;
  return {
    bodyText: document.body.innerText,
    connectLabel: connect?.textContent?.trim() ?? '',
    connectDisabled: connect instanceof HTMLButtonElement ? connect.disabled : null,
    mediaTag: media?.tagName ?? null,
    mediaCurrentSrc:
      media instanceof HTMLImageElement || media instanceof HTMLVideoElement
        ? media.currentSrc || media.getAttribute('src') || ''
        : '',
    videoSrcObject: media instanceof HTMLVideoElement ? Boolean(media.srcObject) : false,
    videoPaused: media instanceof HTMLVideoElement ? media.paused : null,
    videoCurrentTime: media instanceof HTMLVideoElement ? media.currentTime : null,
    liveMediaTag: live?.tagName ?? null,
    liveVideoSrcObject: live instanceof HTMLVideoElement ? Boolean(live.srcObject) : false,
    liveVideoPaused: live instanceof HTMLVideoElement ? live.paused : null,
    liveVideoCurrentTime: live instanceof HTMLVideoElement ? live.currentTime : null,
  };
});

const debug = await page.evaluate(() => ({
  rtcEvents: window.__rtcConnectDebug ?? [],
  rtcDescriptions: window.__rtcDescriptions ?? [],
  workerPosts: window.__workerPosts ?? [],
  workerState: window.__lastWorkerState?.() ?? null,
  actionEvents: window.__actionEvents ?? [],
  workerStates: window.__workerStates ?? [],
  authFetches: window.__authFetches ?? [],
}));

await browser.close();

const result = {
  beforeClick,
  afterClick,
  connectDispatch,
  consoleMessages,
  pageErrors,
  failedRequests,
  webSocketEvents,
  debug,
};

await writeFile('tmp-playwright/live-current.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
