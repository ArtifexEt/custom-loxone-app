import { chromium } from 'playwright';

const appUrl = process.argv[2];
const origin = process.argv[3];
const username = process.argv[4];
const password = process.argv[5];

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/probe-public-retry.mjs <appUrl> <origin> <username> <password>');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const responseHits = [];
page.on('response', async (response) => {
  const url = response.url();
  if (/getPublicKey|getkey2|getjwt|gettoken|fenc/.test(url)) {
    responseHits.push({ url, status: response.status() });
  }
});

async function submitForm() {
  await page.locator('input[name="origin"]').fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /save and connect|zapisz i połącz/i }).click();
}

await page.goto(appUrl, { waitUntil: 'networkidle' });
await submitForm();
await page.waitForTimeout(4000);
const afterFirst = await page.locator('input[name="origin"]').count();

if (afterFirst > 0) {
  await submitForm();
  await page.waitForTimeout(4000);
}

console.log(JSON.stringify({
  afterFirst,
  finalHasForm: await page.locator('input[name="origin"]').count(),
  bodyText: await page.locator('body').innerText(),
  responseHits,
}, null, 2));

await browser.close();
