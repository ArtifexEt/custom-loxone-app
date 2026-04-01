import { chromium } from 'playwright';

const appUrl = process.argv[2];
const origin = process.argv[3];
const username = process.argv[4];
const password = process.argv[5];

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/check-reload-no-form.mjs <appUrl> <origin> <username> <password>');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const page = await context.newPage();

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

if (await page.locator('input[name="origin"]').count()) {
  await page.locator('input[name="origin"]').fill(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[data-form="server"] button[type="submit"]').click({ force: true });
}

await page.waitForTimeout(7000);
await page.reload({ waitUntil: 'domcontentloaded' });

const checks = [];
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(300);
  checks.push(
    await page.evaluate(() => ({
      text: document.body.innerText,
      hasOriginField: Boolean(document.querySelector('input[name="origin"]')),
      screen: document.querySelector('.splash-screen') ? 'loading' : 'app',
    })),
  );
}

await browser.close();
console.log(JSON.stringify({ checks }, null, 2));
