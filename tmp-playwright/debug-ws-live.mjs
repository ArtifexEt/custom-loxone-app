import { chromium } from 'playwright';

const appUrl = process.argv[2];
const origin = process.argv[3];
const username = process.argv[4];
const password = process.argv[5];

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/debug-ws-live.mjs <appUrl> <origin> <username> <password>');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

const webSocketEvents = [];
page.on('websocket', (ws) => {
  const url = ws.url();
  webSocketEvents.push({ kind: 'ws:open-seen', url });
  ws.on('framesent', (event) => {
    webSocketEvents.push({
      kind: 'ws:sent',
      url,
      payload: String(event.payload).slice(0, 1000),
    });
  });
  ws.on('framereceived', (event) => {
    webSocketEvents.push({
      kind: 'ws:received',
      url,
      payload: String(event.payload).slice(0, 1000),
    });
  });
  ws.on('close', () => {
    webSocketEvents.push({ kind: 'ws:close', url });
  });
});

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
  await page.waitForTimeout(1500);
}

await page.waitForTimeout(8000);

const summary = await page.evaluate(() => ({
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
}));

await browser.close();
console.log(JSON.stringify({ summary, webSocketEvents }, null, 2));
