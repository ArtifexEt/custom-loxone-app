import { chromium } from 'playwright';

const [appUrl, origin, username, password] = process.argv.slice(2);

if (!appUrl || !origin || !username || !password) {
  console.error('usage: node tmp-playwright/probe-connect-sdp.mjs <appUrl> <origin> <username> <password>');
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

await context.addInitScript(() => {
  const rtcDebug = {
    offers: [],
    answers: [],
    errors: [],
  };

  window.__rtcSdpDebug = rtcDebug;

  const NativeRTCPeerConnection = window.RTCPeerConnection;

  class DebugRTCPeerConnection extends NativeRTCPeerConnection {
    async createOffer(...args) {
      const offer = await super.createOffer(...args);
      rtcDebug.offers.push({
        type: offer.type,
        sdp: offer.sdp,
      });
      return offer;
    }

    async setRemoteDescription(description) {
      rtcDebug.answers.push({
        type: description?.type ?? null,
        sdp: description?.sdp ?? null,
      });
      try {
        return await super.setRemoteDescription(description);
      } catch (error) {
        rtcDebug.errors.push({
          message: error instanceof Error ? error.message : String(error),
          answerType: description?.type ?? null,
          answerSdp: description?.sdp ?? null,
        });
        throw error;
      }
    }
  }

  window.RTCPeerConnection = DebugRTCPeerConnection;
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

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
  await page.waitForTimeout(2000);
}

const connectButton = page.locator('[data-action="connect-toggle"]').first();
if (await connectButton.count()) {
  await connectButton.click({ force: true });
}

await page.waitForTimeout(6000);

const result = await page.evaluate(() => window.__rtcSdpDebug ?? null);
console.log(JSON.stringify(result, null, 2));

await browser.close();
