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
  console.error('usage: node tmp-playwright/test-info-injection.mjs <appUrl> <origin> <username> <password>');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const page = await context.newPage();

await context.addInitScript(() => {
  const events = [];
  const OriginalWebSocket = window.WebSocket;
  let nextId = 9000;

  class DebugWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const isProxySocket = typeof url === 'string' && url.includes('/proxy/');
      events.push({ kind: 'socket:new', url: String(url), isProxySocket });
      if (isProxySocket) {
        this.addEventListener('message', (event) => {
          const text = String(event.data);
          events.push({ kind: 'socket:recv', url: String(url), text });
          try {
            const message = JSON.parse(text);
            if (message?.method === 'ready') {
              const payload = { jsonrpc: '2.0', method: 'info', id: nextId++ };
              events.push({ kind: 'socket:send:inject', url: String(url), payload });
              this.send(JSON.stringify(payload));
            }
          } catch {
            // Ignore non-JSON frames.
          }
        });
      }
    }
  }

  window.__proxyInfoEvents = events;
  window.WebSocket = DebugWebSocket;
});

page.on('console', (message) => {
  console.log(`[console:${message.type()}] ${message.text()}`);
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const originInput = page.locator('input[name="origin"]');
if (await originInput.count()) {
  await originInput.fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[data-form="server"] button[type="submit"]').first().click({ force: true });
}

await page.waitForTimeout(7000);

const addIntercomButton = page.locator('button[data-action="add-intercom-view"]');
if (await addIntercomButton.count()) {
  await addIntercomButton.first().click({ force: true });
  await page.waitForTimeout(1500);
}

await page.waitForTimeout(9000);

const summary = await page.evaluate(() => {
  const media = document.querySelector('.intercom-media');
  return {
    bodyText: document.body.innerText,
    mediaTag: media?.tagName ?? null,
    mediaSrc:
      media instanceof HTMLImageElement || media instanceof HTMLVideoElement
        ? media.currentSrc || media.getAttribute('src') || ''
        : '',
    connectLabel: document.querySelector('[data-action="connect-toggle"]')?.textContent?.trim() ?? '',
    proxyInfoEvents: window.__proxyInfoEvents ?? [],
  };
});

console.log(JSON.stringify(summary, null, 2));

await browser.close();
