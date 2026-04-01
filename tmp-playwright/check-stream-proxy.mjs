import { chromium } from 'playwright';

const appUrl = process.argv[2];
const origin = process.argv[3];
const username = process.argv[4];
const password = process.argv[5];

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/check-stream-proxy.mjs <appUrl> <origin> <username> <password>');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

if (await page.locator('input[name="origin"]').count()) {
  await page.locator('input[name="origin"]').fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[data-form="server"] button[type="submit"]').click({ force: true });
}

await page.waitForTimeout(7000);

const info = await page.evaluate(async () => {
  const img = document.querySelector('#intercom-live-media');
  const currentSrc =
    img instanceof HTMLImageElement || img instanceof HTMLVideoElement
      ? img.currentSrc || img.getAttribute('src') || ''
      : '';
  if (!currentSrc) {
    return { currentSrc: '', streamUrl: '', status: null, textSample: '' };
  }
  const streamUrl = currentSrc.replace('/jpg/image.jpg', '/mjpg/video.mjpg');
  const response = await fetch(streamUrl, { method: 'GET' });
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
    currentSrc,
    streamUrl,
    status: response.status,
    textSample,
    contentType: response.headers.get('content-type'),
  };
});

await browser.close();
console.log(JSON.stringify(info, null, 2));
