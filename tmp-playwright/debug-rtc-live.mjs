import { chromium } from 'playwright';

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
  console.error('usage: node tmp-playwright/debug-rtc-live.mjs <appUrl> <origin> <username> <password>');
  console.error('or pipe JSON: {"appUrl":"...","origin":"...","username":"...","password":"..."}');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});

await context.addInitScript(() => {
  const events = [];
  const push = (kind, payload) => {
    events.push({
      ts: Date.now(),
      kind,
      payload,
    });
  };
  window.__rtcDebug = events;

  const NativeWebSocket = window.WebSocket;
  class DebugWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      push('ws:create', { url: String(url), protocols });
      this.addEventListener('open', () => push('ws:open', { url: this.url }));
      this.addEventListener('close', (event) =>
        push('ws:close', { url: this.url, code: event.code, reason: event.reason }),
      );
      this.addEventListener('error', () => push('ws:error', { url: this.url }));
      this.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          push('ws:message', { url: this.url, data: event.data.slice(0, 1000) });
        }
      });
    }

    send(data) {
      push('ws:send', {
        url: this.url,
        data: typeof data === 'string' ? data.slice(0, 1000) : '[binary]',
      });
      return super.send(data);
    }
  }
  window.WebSocket = DebugWebSocket;

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  class DebugRTCPeerConnection extends NativeRTCPeerConnection {
    constructor(config) {
      super(config);
      push('rtc:create', { config });
      this.addEventListener('iceconnectionstatechange', () =>
        push('rtc:iceconnectionstatechange', { state: this.iceConnectionState }),
      );
      this.addEventListener('connectionstatechange', () =>
        push('rtc:connectionstatechange', { state: this.connectionState }),
      );
      this.addEventListener('signalingstatechange', () =>
        push('rtc:signalingstatechange', { state: this.signalingState }),
      );
      this.addEventListener('track', (event) =>
        push('rtc:track', {
          kind: event.track?.kind,
          streams: event.streams?.map((stream) => stream.id) ?? [],
        }),
      );
      this.addEventListener('icecandidate', (event) =>
        push('rtc:icecandidate', {
          candidate: event.candidate?.candidate ?? null,
        }),
      );
    }

    async createOffer(...args) {
      push('rtc:createOffer:start', {});
      const offer = await super.createOffer(...args);
      push('rtc:createOffer:done', {
        type: offer.type,
        sdp: offer.sdp?.slice(0, 1000) ?? '',
      });
      return offer;
    }

    async setLocalDescription(description) {
      push('rtc:setLocalDescription', {
        type: description?.type ?? null,
        sdp: description?.sdp?.slice(0, 1000) ?? '',
      });
      return super.setLocalDescription(description);
    }

    async setRemoteDescription(description) {
      push('rtc:setRemoteDescription', {
        type: description?.type ?? null,
        sdp: description?.sdp?.slice(0, 1000) ?? '',
      });
      return super.setRemoteDescription(description);
    }

    addTransceiver(...args) {
      push('rtc:addTransceiver', { args });
      return super.addTransceiver(...args);
    }
  }
  window.RTCPeerConnection = DebugRTCPeerConnection;
});

const page = await context.newPage();
await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);

if (await page.locator('input[name="origin"]').count()) {
  await page.locator('input[name="origin"]').fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[data-form="server"] button[type="submit"]').click({ force: true });
}

await page.waitForTimeout(7000);

const addIntercomButton = page.locator('button[data-action="add-intercom-view"]');
if (await addIntercomButton.count()) {
  await addIntercomButton.first().click({ force: true });
}

await page.waitForTimeout(8000);

const debug = await page.evaluate(() => ({
  bodyText: document.body.innerText,
  mediaTag: document.querySelector('.intercom-media')?.tagName ?? null,
  mediaSrc:
    document.querySelector('.intercom-media') instanceof HTMLImageElement ||
    document.querySelector('.intercom-media') instanceof HTMLVideoElement
      ? document.querySelector('.intercom-media').currentSrc ||
        document.querySelector('.intercom-media').getAttribute('src') ||
        ''
      : '',
  connectLabel:
    document.querySelector('[data-action="connect-toggle"]')?.textContent?.trim() ?? '',
  rtcEvents: window.__rtcDebug ?? [],
}));

await browser.close();
console.log(JSON.stringify(debug, null, 2));
