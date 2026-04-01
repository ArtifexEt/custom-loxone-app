import { chromium } from 'playwright';

const [appUrl, username, password] = process.argv.slice(2);

if (!appUrl || !username || !password) {
  console.error('usage: node tmp-playwright/probe-official-connect.mjs <appUrl> <username> <password>');
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
    webSocketEvents.push({
      kind: 'sent',
      url,
      payload: String(event.payload).slice(0, 1200),
    });
  });
  ws.on('framereceived', (event) => {
    webSocketEvents.push({
      kind: 'received',
      url,
      payload: String(event.payload).slice(0, 1200),
    });
  });
  ws.on('close', () => {
    webSocketEvents.push({ kind: 'close', url });
  });
});

await page.addInitScript(() => {
  const rtcDescriptions = [];
  const rtcEvents = [];
  window.__rtcDescriptions = rtcDescriptions;
  window.__rtcEvents = rtcEvents;
  const NativeRTCPeerConnection = window.RTCPeerConnection;
  class DebugRTCPeerConnection extends NativeRTCPeerConnection {
    async createOffer(...args) {
      const offer = await super.createOffer(...args);
      rtcDescriptions.push({ kind: 'offer', type: offer.type, sdp: offer.sdp });
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
      this.addEventListener('track', (event) => {
        rtcEvents.push({
          kind: 'track',
          track: event.track?.kind ?? null,
          streams: event.streams?.map((stream) => stream.id) ?? [],
        });
      });
      this.addEventListener('connectionstatechange', () => {
        rtcEvents.push({ kind: 'connectionstatechange', state: this.connectionState });
      });
      this.addEventListener('iceconnectionstatechange', () => {
        rtcEvents.push({ kind: 'iceconnectionstatechange', state: this.iceConnectionState });
      });
    }
  }
  window.RTCPeerConnection = DebugRTCPeerConnection;
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const inputs = page.locator('input');
if (await inputs.count()) {
  await inputs.first().fill(username);
  const passwordField = page.locator('input[type="password"]').first();
  if (await passwordField.count()) {
    await passwordField.fill(password);
  }
  const loginButton = page.locator('button').filter({ hasText: /Połącz|Connect|Login|Zaloguj/i }).first();
  if (await loginButton.count()) {
    await loginButton.click({ force: true });
  }
}

await page.waitForTimeout(10000);

const before = await page.evaluate(() => ({
  bodyText: document.body.innerText,
  buttonTexts: Array.from(document.querySelectorAll('button')).map((button) => button.textContent?.trim() ?? ''),
}));

const connectButton = page.locator('button').filter({ hasText: /Połącz|Connect|Odbierz|Answer|Rozłącz|Disconnect/i }).first();
if (await connectButton.count()) {
  await connectButton.click({ force: true });
}

await page.waitForTimeout(8000);

const after = await page.evaluate(() => ({
  bodyText: document.body.innerText,
  buttonTexts: Array.from(document.querySelectorAll('button')).map((button) => button.textContent?.trim() ?? ''),
  rtcDescriptions: window.__rtcDescriptions ?? [],
  rtcEvents: window.__rtcEvents ?? [],
}));

await browser.close();

console.log(JSON.stringify({
  before,
  after,
  consoleMessages,
  pageErrors,
  failedRequests,
  webSocketEvents,
}, null, 2));
