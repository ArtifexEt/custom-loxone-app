interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

export type PwaUpdateResult = 'reloading' | 'close-other-tabs' | 'unavailable';

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
const UPDATE_TIMEOUT = 10_000;

let installPrompt: InstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
let updateAttempt: Promise<PwaUpdateResult> | null = null;
let lastCheck = 0;

export function startPwa(onChange: () => void): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    const prompt = event as InstallPromptEvent;
    if (typeof prompt.prompt !== 'function') return;
    event.preventDefault();
    installPrompt = prompt;
    onChange();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    onChange();
  });

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const start = () => {
    // Let the initial UI load before precaching the app on a cold visit.
    window.setTimeout(() => {
      void register(onChange);
    }, 0);
  };
  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('load', start, { once: true });
  }
}

export function canInstallPwa(): boolean {
  return installPrompt !== null;
}

export async function installPwa(): Promise<void> {
  const event = installPrompt;
  if (!event) return;
  installPrompt = null;
  try {
    await event.prompt();
  } catch {
    // The browser can revoke a pending install prompt.
  }
}

export function canApplyPwaUpdate(): boolean {
  return Boolean(registration && registration.waiting && navigator.serviceWorker.controller);
}

export function applyPwaUpdate(): Promise<PwaUpdateResult> {
  if (updateAttempt) return updateAttempt;

  const worker = registration?.waiting;
  if (!worker || !navigator.serviceWorker.controller) {
    return Promise.resolve('unavailable');
  }
  updateAttempt = new Promise<PwaUpdateResult>((resolve) => {
    const channel = new MessageChannel();
    const serviceWorkers = navigator.serviceWorker;
    const cleanUp = () => {
      window.clearTimeout(timer);
      serviceWorkers.removeEventListener('controllerchange', onControllerChange);
      channel.port1.close();
    };
    const finish = (result: PwaUpdateResult) => {
      cleanUp();
      resolve(result);
    };
    const onControllerChange = () => {
      if (serviceWorkers.controller !== worker) return;
      finish('reloading');
      window.location.reload();
    };
    const timer = window.setTimeout(() => finish('unavailable'), UPDATE_TIMEOUT);

    serviceWorkers.addEventListener('controllerchange', onControllerChange);
    channel.port1.onmessage = (event: MessageEvent) => {
      if (event.data === 'close-other-tabs' || event.data === 'unavailable') {
        finish(event.data);
      }
    };

    try {
      worker.postMessage({ type: 'APPLY_UPDATE' }, [channel.port2]);
    } catch {
      finish('unavailable');
    }
  }).finally(() => { updateAttempt = null; });
  return updateAttempt;
}

async function register(onChange: () => void): Promise<void> {
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  } catch {
    return;
  }
  const activeRegistration = registration;
  if (!activeRegistration) return;

  lastCheck = Date.now();

  const observe = (worker: ServiceWorker | null) => {
    worker?.addEventListener('statechange', onChange);
  };
  observe(activeRegistration.installing);
  observe(activeRegistration.waiting);
  activeRegistration.addEventListener('updatefound', () => observe(activeRegistration.installing));
  navigator.serviceWorker.addEventListener('controllerchange', onChange);
  onChange();

  function checkForUpdates() {
    const now = Date.now();
    if (document.hidden || navigator.onLine === false || now - lastCheck < UPDATE_CHECK_INTERVAL) return;
    lastCheck = now;
    void activeRegistration.update().catch(() => undefined);
  }

  document.addEventListener('visibilitychange', checkForUpdates);
  window.addEventListener('online', checkForUpdates);
  window.setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
}
