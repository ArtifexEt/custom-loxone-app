import { webkit } from 'playwright';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:4173/';
const origin = process.env.LOXONE_ORIGIN || '';
const username = process.env.LOXONE_USERNAME || '';
const password = process.env.LOXONE_PASSWORD || '';

if (!origin || !username || !password) {
  console.error('Missing Loxone credentials');
  process.exit(2);
}

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
});
await context.addInitScript(() => {
  const OriginalWorker = window.Worker;
  const workerMessages = [];
  const workerResponses = [];
  const workerInstances = [];
  class TrackingWorker extends OriginalWorker {
    constructor(...args) {
      super(...args);
      workerInstances.push(this);
      super.addEventListener('message', (event) => {
        workerResponses.push(event.data);
      });
    }
    postMessage(message, transfer) {
      workerMessages.push(message);
      return super.postMessage(message, transfer);
    }
  }
  Object.defineProperty(window, '__workerMessages', {
    value: workerMessages,
    configurable: true,
  });
  Object.defineProperty(window, '__workerResponses', {
    value: workerResponses,
    configurable: true,
  });
  Object.defineProperty(window, '__workers', {
    value: workerInstances,
    configurable: true,
  });
  window.Worker = TrackingWorker;
});
const page = await context.newPage();
const consoleMessages = [];
const failedRequests = [];
const interestingResponses = [];

page.on('console', (message) => {
  consoleMessages.push({
    type: message.type(),
    text: message.text(),
  });
});

page.on('requestfailed', (request) => {
  failedRequests.push({
    url: request.url(),
    method: request.method(),
    errorText: request.failure()?.errorText ?? 'unknown',
  });
});

page.on('response', async (response) => {
  const url = response.url();
  if (!/getPublicKey|getkey2|getjwt|gettoken|fenc|rfc6455/.test(url)) {
    return;
  }
  interestingResponses.push({
    url,
    status: response.status(),
    ok: response.ok(),
  });
});

try {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const originInput = page.locator('input[name="origin"]');
  if (await originInput.count()) {
    await originInput.fill(origin);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    const formSnapshot = await page.locator('form[data-form="server"]').evaluate((form) => {
      if (!(form instanceof HTMLFormElement)) {
        return null;
      }
      const data = new FormData(form);
      return {
        origin: String(data.get('origin') ?? ''),
        username: String(data.get('username') ?? ''),
        passwordLength: String(data.get('password') ?? '').length,
      };
    });
    console.log(JSON.stringify({ beforeSubmit: formSnapshot }, null, 2));
    await page.locator('form[data-form="server"]').evaluate((form) => {
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
      }
    });
  }

  const addIntercomButton = page.locator('button[data-action="add-intercom-view"]');
  if (await addIntercomButton.count()) {
    await addIntercomButton.waitFor({ state: 'visible', timeout: 15000 });
    await addIntercomButton.click({ force: true });
  } else {
    const workerState = await page.evaluate(() => {
      const responses = Array.isArray(window.__workerResponses) ? window.__workerResponses : [];
      return responses.at(-1)?.state ?? null;
    });
    if (workerState?.screen === 'picker') {
      await page.evaluate(() => {
        const workers = Array.isArray(window.__workers) ? window.__workers : [];
        const worker = workers[0];
        if (worker) {
          worker.postMessage({ type: 'addIntercomView' });
        }
      });
    }
  }

  await page.waitForTimeout(4000);

  const connectButton = page.locator('[data-action="connect-toggle"]');
  if (await connectButton.count()) {
    await connectButton.first().click({ force: true });
    await page.waitForTimeout(4000);
  }

  const metrics = await page.evaluate(() => {
    const mediaFrame = document.querySelector('.media-frame');
    const video = document.querySelector('#intercom-live-media');
    const image = document.querySelector('.intercom-media');
    const connectButton = document.querySelector('[data-action="connect-toggle"]');
    const workerMessages = Array.isArray(window.__workerMessages) ? window.__workerMessages : [];
    const workerResponses = Array.isArray(window.__workerResponses) ? window.__workerResponses : [];
    return {
      mediaFrameClass: mediaFrame?.className ?? null,
      videoTag: video?.tagName ?? null,
      videoSrcObject: Boolean(video && video.srcObject),
      videoCurrentSrc: video?.currentSrc ?? '',
      imageTag: image?.tagName ?? null,
      imageSrc: image?.getAttribute('src') ?? '',
      connectLabel: connectButton?.textContent?.trim() ?? '',
      addViewButtons: Array.from(document.querySelectorAll('button[data-action="add-intercom-view"]')).map((button) => ({
        text: button.textContent?.trim() ?? '',
        disabled: button.hasAttribute('disabled'),
      })),
      workerMessages,
      workerResponses,
      bodyText: document.body.innerText,
    };
  });

  console.log(JSON.stringify({ metrics, consoleMessages, failedRequests, interestingResponses }, null, 2));
  await page.screenshot({ path: 'tmp-playwright/preview-smoke.png', fullPage: true });
} finally {
  await context.close();
  await browser.close();
}
