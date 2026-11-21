import './styles.css';
import AppWorker from './app.worker.ts?worker';
import { throwIfAborted } from './abort';
import { parseConnectionAddress, parseMiniserverSerial, remoteConnectSerial, remoteConnectUrl } from './connection-address';
import { canKeepScreenAwake, PanelScreenWakeLock } from './panel-display';
import { applyPwaUpdate, canApplyPwaUpdate, canInstallPwa, installPwa, startPwa } from './pwa';
import { IntercomMediaError, IntercomRtcSession, supportsBrowserRtc } from './intercom-rtc';
import { localeForLanguage, setRuntimeLanguage, t } from './translations';
import type {
  ActivityLogItem,
  AppLanguage,
  AppViewModel,
  IntercomViewConfig,
  IntercomHistoryItem,
  MainToWorkerMessage,
  QuickTtsPhrase,
  WorkerToMainMessage,
} from './types';

const worker = new AppWorker();
const rootElement = document.querySelector<HTMLDivElement>('#app');

if (!rootElement) {
  throw new Error('Missing app root container.');
}

const root = rootElement;
type SidePanelTab = 'history' | 'log';
type BrowserConversationState = 'idle' | 'starting' | 'active' | 'error';
const TRANSPARENT_1PX =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

let state: AppViewModel = {
  screen: 'loading',
  settingsOpen: false,
  settingsMode: null,
  language: 'pl',
  languageOverride: null,
  panelMode: false,
  keepScreenAwake: false,
  connection: { status: 'idle' },
  notice: null,
  serverForm: {
    origin: '',
    serial: null,
    username: '',
    passwordStored: false,
  },
  miniserverName: null,
  lastSyncedAt: null,
  views: [],
  intercoms: [],
  logSources: [],
  activeViewId: null,
  settingsEditorViewId: null,
  currentEditorView: null,
  currentView: null,
};
let sidePanelOpen = false;
let sidePanelTab: SidePanelTab = 'history';
let browserConversationState: BrowserConversationState = 'idle';
let browserConversationMessage = '';
let browserConversationAttempt: AbortController | null = null;
let conversationNegotiation: Promise<void> | null = null;
let endingConversation: Promise<void> | null = null;
let selectedHistoryImage: IntercomHistoryItem | null = null;
let savedMessagesDialogViewId: string | null = null;
let selectedSavedMessageId: string | null = null;
let localMicrophoneStream: MediaStream | null = null;
let localViewDraft: IntercomViewConfig | null = null;
let localServerDraft: {
  origin: string;
  serial: string;
  username: string;
  password: string;
  passwordStored: boolean;
} | null = null;
let browserHistoryByIntercomUuidAction = new Map<string, IntercomHistoryItem[]>();
let historyImageCache = new Map<string, string>();
let failedHistoryImageLoads = new Set<string>();
const requestedHistoryImageKeys = new Set<string>();
const encodingHistoryImageKeys = new Set<string>();
let historyCacheGeneration = 0;
const failedPreviewUrls = new Set<string>();
let activeHistoryIntercomKey: string | null = null;
let rtcPlaybackRetryTimer: number | null = null;
let pendingFrame: number | null = null;
let lastMarkup: string | null = null;
let panelFromUrl = new URL(window.location.href).searchParams.get('panel') === '1';
let wakeLockUnavailable = false;
let updateStatus: 'close-other-tabs' | 'unavailable' | null = null;
let fullscreenFailed = false;
let legacyDialogReturnFocus: HTMLElement | null = null;
const screenWakeLock = new PanelScreenWakeLock((unavailable) => {
  if (unavailable !== wakeLockUnavailable) {
    wakeLockUnavailable = unavailable;
    scheduleRender();
  }
});

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

type CurrentIntercom = NonNullable<NonNullable<AppViewModel['currentView']>['intercom']>;

function tr<Key extends Parameters<typeof t>[1]>(
  key: Key,
  params?: Parameters<typeof t>[2],
): string {
  return t(state.language, key, params);
}

const intercomRtcSession = new IntercomRtcSession({
  post,
  changed: scheduleRender,
  interrupted: () => {
    if (browserConversationState !== 'starting' && browserConversationState !== 'active') {
      return;
    }
    stopBrowserConversation(false);
    browserConversationState = 'error';
    browserConversationMessage = tr('signaling_closed');
  },
  history: (items, intercom) => {
    browserHistoryByIntercomUuidAction.set(intercom.uuidAction,
      items.map(item => ({ ...item, label: formatDate(item.timestamp) })),
    );
    scheduleRender();
  },
});

function syncIntercomMedia(): void {
  const intercom = !document.hidden && state.screen === 'dashboard' && isRealtimeAvailable()
    ? state.currentView?.intercom
    : null;
  intercomRtcSession.sync(intercom ?? null);
}

function suspendIntercomMedia(): void {
  stopBrowserConversation(false);
  intercomRtcSession.sync(null);
}

function isPanelMode(): boolean {
  return panelFromUrl || state.panelMode;
}

function syncPanelScreen(): void {
  screenWakeLock.sync(isPanelMode() && state.keepScreenAwake);
}

function resumeVisibleApp(): void {
  if (document.hidden) {
    return;
  }
  post({ type: 'resume' });
  syncPanelScreen();
  syncIntercomMedia();
  scheduleRender();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    screenWakeLock.sync(false);
    suspendIntercomMedia();
  } else {
    resumeVisibleApp();
  }
});
window.addEventListener('pagehide', () => {
  screenWakeLock.sync(false);
  suspendIntercomMedia();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    resumeVisibleApp();
  }
});
window.addEventListener('online', resumeVisibleApp);
document.addEventListener('fullscreenchange', scheduleRender);
window.addEventListener('popstate', () => {
  panelFromUrl = new URL(window.location.href).searchParams.get('panel') === '1';
  syncPanelScreen();
  scheduleRender();
});

worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
  if (event.data.type === 'historyImageCache') {
    if (event.data.requestId === historyCacheGeneration) {
      let changed = false;
      for (const [key, url] of event.data.entries) {
        if (!historyImageCache.has(key)) {
          historyImageCache.set(key, url);
          changed = true;
        }
      }
      if (changed) {
        scheduleRender();
      }
    }
    return;
  }
  if (event.data.type !== 'state') {
    intercomRtcSession.handle(event.data);
    return;
  }
  const previousIntercom = state.currentView?.intercom;
  const previousViewId = state.currentView?.config.id;
  const previousServer = state.serverForm;
  const previousConnection = state.connection.status;
  state = event.data.state;
  setRuntimeLanguage(state.language);
  document.documentElement.lang = state.language;
  syncLocalViewDraft();
  if (previousViewId !== state.currentView?.config.id) {
    closeSavedMessagesDialog();
    selectedHistoryImage = null;
  }
  const intercom = state.currentView?.intercom;
  const accountChanged = previousServer.origin !== state.serverForm.origin ||
    previousServer.serial !== state.serverForm.serial ||
    previousServer.username !== state.serverForm.username;
  if (accountChanged) {
    browserHistoryByIntercomUuidAction.clear();
  }
  if (accountChanged || previousViewId !== state.currentView?.config.id || previousConnection !== state.connection.status) {
    failedPreviewUrls.clear();
  }
  if (accountChanged || previousIntercom?.uuidAction !== intercom?.uuidAction ||
      previousIntercom?.signalingUrl !== intercom?.signalingUrl ||
      (previousConnection === 'online' && !isRealtimeAvailable())) {
    suspendIntercomMedia();
    selectedHistoryImage = null;
  }
  const nextIntercomKey = intercom?.uuidAction ?? null;
  if (accountChanged || nextIntercomKey !== activeHistoryIntercomKey) {
    activeHistoryIntercomKey = nextIntercomKey;
    historyImageCache = new Map();
    failedHistoryImageLoads = new Set();
    requestedHistoryImageKeys.clear();
    encodingHistoryImageKeys.clear();
    historyCacheGeneration += 1;
  }
  if (!intercom) {
    sidePanelOpen = false;
  }
  if (!intercom?.activityLogSourceName) {
    sidePanelTab = 'history';
  }
  syncPanelScreen();
  syncIntercomMedia();
  scheduleRender();
};

worker.onerror = () => {
  suspendIntercomMedia();
  cancelScheduledRender();
  renderMarkup(
    `<main class="shell"><section class="panel error-card" role="alert"><h1>${escapeHtml(tr('worker_start_failed'))}</h1></section></main>`,
  );
};

root.addEventListener('click', (event) => {
  const action = event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-action]')
    : null;
  if (action && !action.matches(':disabled')) {
    handleUiAction(action);
  }
});

root.addEventListener('cancel', (event) => {
  const dialog = event.target;
  if (!(dialog instanceof HTMLElement) || dialog.tagName !== 'DIALOG') {
    return;
  }
  event.preventDefault();
  dialog.querySelector<HTMLButtonElement>('[data-dialog-close]')?.click();
}, true);

root.addEventListener('keydown', (event) => {
  if (handleLegacyDialogKeys(event)) {
    return;
  }
  if (!selectedHistoryImage || !(event.target instanceof Element) || !event.target.closest('.history-lightbox')) {
    return;
  }
  const action = event.key === 'ArrowLeft' ? 'history-image-prev' : event.key === 'ArrowRight' ? 'history-image-next' : null;
  if (action) {
    event.preventDefault();
    root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click();
  }
});

function handleUiAction(actionElement: HTMLElement): void {
  switch (actionElement.dataset.action) {
    case 'install-pwa':
      void installPwa().then(render, render);
      return;
    case 'apply-pwa-update':
      updateStatus = null;
      void applyPwaUpdate().then((status) => {
        if (status !== 'reloading') {
          updateStatus = status;
          render();
        }
      });
      return;
    case 'panel-fullscreen':
      void togglePanelFullscreen();
      return;
    case 'show-app-settings':
      updateStatus = null;
      post({ type: 'showAppSettings' });
      return;
    case 'show-view-settings':
      post({ type: 'showViewSettings', viewId: actionElement.dataset.viewId });
      return;
    case 'close-settings':
      localServerDraft = null;
      post({ type: 'closeSettings' });
      return;
    case 'open-side-panel': {
      const tab = actionElement.dataset.tab === 'log' ? 'log' : 'history';
      sidePanelOpen = !sidePanelOpen || sidePanelTab !== tab;
      sidePanelTab = tab;
      render();
      return;
    }
    case 'open-history-image': {
      const timestamp = actionElement.dataset.timestamp ?? '';
      const intercom = state.currentView?.intercom;
      if (!intercom) {
        return;
      }
      const historyItems = viewHistory(intercom);
      selectedHistoryImage = historyItems.find((item) => item.timestamp === timestamp) ?? null;
      render();
      return;
    }
    case 'close-history-image':
      selectedHistoryImage = null;
      render();
      return;
    case 'history-image-prev': {
      const adjacent = getAdjacentHistoryImage(-1);
      if (adjacent) {
        selectedHistoryImage = adjacent;
        render();
      }
      return;
    }
    case 'history-image-next': {
      const adjacent = getAdjacentHistoryImage(1);
      if (adjacent) {
        selectedHistoryImage = adjacent;
        render();
      }
      return;
    }


    case 'select-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'selectView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'add-intercom-view':
      post({ type: 'addIntercomView' });
      return;
    case 'configure-intercom-view':
      post({ type: 'configureIntercomView' });
      return;
    case 'edit-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'editView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'delete-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'deleteView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'set-default-view':
      if (actionElement.dataset.viewId) {
        post({ type: 'setDefaultView', viewId: actionElement.dataset.viewId });
      }
      return;
    case 'run-child-function':
      if (actionElement.dataset.viewId && actionElement.dataset.functionUuidAction) {
        post({
          type: 'sendChildFunction',
          viewId: actionElement.dataset.viewId,
          functionUuidAction: actionElement.dataset.functionUuidAction,
        });
      }
      return;
    case 'connect-toggle':
      if (actionElement.dataset.viewId) {
        void handleConnect(actionElement.dataset.viewId);
      }
      return;
    case 'mute':
    case 'unmute':
      if (actionElement.dataset.viewId) {
        post({
          type: 'runBuiltInAction',
          viewId: actionElement.dataset.viewId,
          action: actionElement.dataset.action as 'mute' | 'unmute',
        });
      }
      return;
    case 'dismiss-notice':
      post({ type: 'dismissNotice' });
      return;
    case 'open-saved-messages':
      if (actionElement.dataset.viewId) {
        openSavedMessagesDialog(actionElement.dataset.viewId);
      }
      return;
    case 'close-saved-messages':
      closeSavedMessagesDialog();
      render();
      return;
    case 'select-saved-message':
      selectedSavedMessageId = actionElement.dataset.phraseId ?? null;
      render();
      return;
    case 'send-quick-message':
    case 'confirm-saved-message':
      if (actionElement.dataset.viewId) {
        sendSavedMessage(actionElement.dataset.viewId, actionElement.dataset.phraseId ?? '');
      }
      return;
    case 'add-tts-row':
      appendTtsRow();
      return;
    case 'remove-tts-row':
      removeTtsRow(actionElement.closest<HTMLElement>('.tts-row')?.dataset.phraseId ?? null);
      return;
    default:
      return;
  }
}

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (form.dataset.form === 'server') {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && form.contains(activeElement)) {
      activeElement.blur();
    }
    const formData = new FormData(form);
    const serialField = form.querySelector<HTMLInputElement>('input[name="serial"]');
    syncDraftFromServerForm(form);
    if (localServerDraft) {
      localServerDraft.password = '';
    }
    const passwordInput = form.querySelector<HTMLInputElement>('[name="password"]');
    if (passwordInput) {
      passwordInput.value = '';
    }
    post({
      type: 'saveServer',
      payload: {
        origin: String(formData.get('origin') ?? ''),
        serial: serialField ? String(formData.get('serial') ?? '') : '',
        username: String(formData.get('username') ?? ''),
        password: String(formData.get('password') ?? ''),
      },
    });
    return;
  }

  if (form.dataset.form === 'view') {
    syncDraftFromViewForm(form);
    const payload: IntercomViewConfig = {
      ...(localViewDraft ?? state.currentEditorView ?? {
        id: String(new FormData(form).get('viewId') ?? ''),
        type: 'intercom' as const,
        title: tr('intercom_label'),
        intercomUuidAction: null,
        activityLogControlUuidAction: null,
        historyLimit: 8,
        quickTts: [],
      }),
      quickTts: collectQuickTts(form),
    };
    post({ type: 'saveView', payload });
    return;
  }

  if (form.dataset.form === 'tts') {
    const formData = new FormData(form);
    const message = String(formData.get('message') ?? '').trim();
    if (!message) {
      return;
    }
    post({ type: 'sendTts', viewId: String(formData.get('viewId') ?? ''), message });
    form.reset();
  }
});

root.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && (target.name === 'panelMode' || target.name === 'keepScreenAwake')) {
    const name = target.name;
    if (name === 'panelMode' && !target.checked && panelFromUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete('panel');
      history.replaceState(history.state, '', url);
      panelFromUrl = false;
    }
    state = { ...state, [name]: target.checked };
    syncPanelScreen();
    post({ type: 'saveAppSettings', payload: { [name]: target.checked } });
    render();
    return;
  }
  if (!(target instanceof HTMLSelectElement) || target.name !== 'languageOverride') {
    return;
  }
  const nextLanguageOverride = normalizeLanguage(target.value);
  const nextLanguage = nextLanguageOverride ?? normalizeLanguage(navigator.language.slice(0, 2)) ?? 'pl';
  state = {
    ...state,
    languageOverride: nextLanguageOverride,
    language: nextLanguage,
  };
  setRuntimeLanguage(nextLanguage);
  document.documentElement.lang = nextLanguage;
  render();
  post({
    type: 'saveAppSettings',
    payload: {
      languageOverride: nextLanguageOverride,
    },
  });
});

root.addEventListener(
  'load',
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
      return;
    }
    const sourceUrl = target.dataset.historySourceUrl;
    if (!sourceUrl || target.currentSrc.startsWith('data:')) {
      return;
    }
    cacheHistoryImageFromElement(target, sourceUrl);
  },
  true,
);

root.addEventListener('error', (event) => {
  const media = event.target;
  if (!(media instanceof HTMLElement) || media.id !== 'intercom-live-media') {
    return;
  }
  const src = media.getAttribute('src');
  if (src && !failedPreviewUrls.has(src)) {
    failedPreviewUrls.add(src);
    render();
  }
}, true);

startPwa(scheduleRender);
post({ type: 'bootstrap', browserLanguage: navigator.language });
render();

function scheduleRender(): void {
  if (pendingFrame === null) {
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null;
      render();
    });
  }
}

function cancelScheduledRender(): void {
  if (pendingFrame !== null) {
    window.cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
}

function render(): void {
  cancelScheduledRender();
  renderMarkup(`
    <main class="shell ${state.screen === 'loading' ? 'shell-loading' : ''} ${isPanelMode() ? 'shell-panel' : ''}">
      <div class="shell-content">
        ${state.screen === 'loading' ? renderLoadingScreen() : renderAppShell()}
      </div>
      ${state.settingsOpen ? renderSettingsOverlay() : ''}
      ${selectedHistoryImage ? renderHistoryImageOverlay(selectedHistoryImage) : ''}
      ${renderSavedMessagesOverlay()}
      ${state.notice && !state.settingsOpen ? renderNotice() : ''}
    </main>
  `);
  syncModalDialogs();
  attachRtcStreamToDom();
  const intercom = state.currentView?.intercom;
  if (intercom) {
    requestVisibleHistoryCache(intercom);
  }
}

function syncModalDialogs(): void {
  for (const dialog of Array.from(root.querySelectorAll<HTMLDialogElement>('dialog:not([open])'))) {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      const active = document.activeElement;
      legacyDialogReturnFocus = active instanceof HTMLElement ? active : null;
      dialog.setAttribute('data-legacy-modal', '');
      dialog.setAttribute('open', '');
      const initialFocus = dialog.querySelector<HTMLElement>('[autofocus]') ?? dialog.querySelector<HTMLElement>('[data-dialog-close]');
      initialFocus?.focus();
      root.querySelector('.shell-content')?.setAttribute('aria-hidden', 'true');
    }
  }
  document.body.classList.toggle('modal-open', Boolean(root.querySelector('dialog[open]')));
}

function handleLegacyDialogKeys(event: KeyboardEvent): boolean {
  const dialog = root.querySelector<HTMLElement>('dialog[data-legacy-modal][open]');
  if (!dialog) {
    return false;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close]')?.click();
    return true;
  }
  if (event.key !== 'Tab') {
    return false;
  }
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href]',
  ));
  const current = focusable.indexOf(document.activeElement as HTMLElement);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (current === -1 || (event.shiftKey && current === 0) || (!event.shiftKey && current === focusable.length - 1)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
    return true;
  }
  return false;
}

function renderMarkup(markup: string): void {
  if (markup === lastMarkup) {
    return;
  }
  lastMarkup = markup;
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  const nextDialogs = new Set(Array.from(template.content.querySelectorAll('dialog'), (dialog) => dialog.id));
  let restoreFocus: HTMLElement | null = null;
  for (const dialog of Array.from(root.querySelectorAll<HTMLDialogElement>('dialog[open]'))) {
    if (!nextDialogs.has(dialog.id)) {
      if (typeof dialog.close === 'function' && !dialog.hasAttribute('data-legacy-modal')) {
        dialog.close();
      } else {
        restoreFocus = legacyDialogReturnFocus;
        legacyDialogReturnFocus = null;
      }
    }
  }
  morphChildren(root, template.content);
  if (root.querySelector('dialog[data-legacy-modal][open]')) {
    root.querySelector('.shell-content')?.setAttribute('aria-hidden', 'true');
  } else if (restoreFocus && root.contains(restoreFocus)) {
    restoreFocus.focus();
  }
}

function morphChildren(targetParent: Node, sourceParent: Node): void {
  const sourceChildren = Array.from(sourceParent.childNodes);
  let targetChild = targetParent.firstChild;

  for (const sourceChild of sourceChildren) {
    if (!targetChild) {
      targetParent.appendChild(sourceChild.cloneNode(true));
      continue;
    }

    const nextTarget = targetChild.nextSibling;
    const updatedNode = morphNode(targetChild, sourceChild);
    if (updatedNode === targetChild) {
      targetChild = nextTarget;
    } else {
      targetChild = updatedNode.nextSibling;
    }
  }

  while (targetChild) {
    const nextTarget = targetChild.nextSibling;
    targetParent.removeChild(targetChild);
    targetChild = nextTarget;
  }
}

function morphNode(targetNode: Node, sourceNode: Node): Node {
  if (
    targetNode.nodeType !== sourceNode.nodeType ||
    (targetNode instanceof Element &&
      sourceNode instanceof Element &&
      (targetNode.tagName !== sourceNode.tagName ||
        (sourceNode.hasAttribute('data-render-key') &&
         targetNode.getAttribute('data-render-key') !== sourceNode.getAttribute('data-render-key'))))
  ) {
    const replacement = sourceNode.cloneNode(true);
    targetNode.parentNode?.replaceChild(replacement, targetNode);
    return replacement;
  }

  if (targetNode.nodeType === Node.TEXT_NODE || targetNode.nodeType === Node.COMMENT_NODE) {
    if (targetNode.nodeValue !== sourceNode.nodeValue) {
      targetNode.nodeValue = sourceNode.nodeValue;
    }
    return targetNode;
  }

  if (!(targetNode instanceof HTMLElement) || !(sourceNode instanceof HTMLElement)) {
    return targetNode;
  }

  syncAttributes(targetNode, sourceNode);
  if (!(targetNode instanceof HTMLTextAreaElement)) {
    morphChildren(targetNode, sourceNode);
    syncElementState(targetNode, sourceNode);
  }
  return targetNode;
}

function syncAttributes(target: HTMLElement, source: HTMLElement): void {
  const sourceAttributes = new Map(Array.from(source.attributes).map((attribute) => [attribute.name, attribute.value]));
  for (const attribute of Array.from(target.attributes)) {
    const userDisclosure = attribute.name === 'open' && (target.tagName === 'DIALOG' || target.tagName === 'DETAILS');
    if (!sourceAttributes.has(attribute.name) && !userDisclosure && attribute.name !== 'data-legacy-modal') {
      target.removeAttribute(attribute.name);
    }
  }
  for (const [name, value] of sourceAttributes) {
    if (target.getAttribute(name) !== value) {
      target.setAttribute(name, value);
    }
  }
}

function syncElementState(target: HTMLElement, source: HTMLElement): void {
  const activeElement = document.activeElement;
  const isFocused = activeElement === target;

  if (target instanceof HTMLInputElement && source instanceof HTMLInputElement) {
    if (!isFocused && target.value !== source.value) {
      target.value = source.value;
    }
    if (target.checked !== source.checked) {
      target.checked = source.checked;
    }
    return;
  }

  if (target instanceof HTMLSelectElement && source instanceof HTMLSelectElement) {
    if (!isFocused && target.value !== source.value) {
      target.value = source.value;
    }
  }
}

function renderLoadingScreen(): string {
  const hasSavedServerConfiguration =
    Boolean(state.serverForm.origin.trim()) &&
    Boolean(state.serverForm.username.trim()) &&
    state.serverForm.passwordStored;
  const connecting = state.connection.status === 'connecting' ||
    (hasSavedServerConfiguration && state.connection.status === 'idle');

  return `
    <section class="splash-screen">
      <div class="splash-art" aria-hidden="true">
        <div class="door-station">
          <span class="door-station-lens"></span>
          <span class="door-station-grille"></span>
          <span class="door-station-button"></span>
        </div>
      </div>
      <div class="splash-content">
        ${renderBrand()}
        <h1>${escapeHtml(tr('connection_title'))}</h1>
        ${connecting
          ? `<p class="loading-status" role="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(tr('connecting_miniserver'))}</p>`
          : `${renderServerForm()}<p class="connection-copy">${escapeHtml(tr('connection_helper'))}</p>`}
      </div>
    </section>
  `;
}

function renderBrand(): string {
  return '<div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Custom Loxone App</span></div>';
}

function renderAppShell(): string {
  const options = {
    idle: 'configure_miniserver',
    connecting: 'connecting_miniserver',
    online: 'status_online',
    offline: 'status_offline',
    error: 'status_offline',
  } as const;
  const { status } = state.connection;
  const syncedAt = state.lastSyncedAt ? formatDate(state.lastSyncedAt) : null;

  return `
    <header class="topbar">
      ${renderBrand()}
      <div class="topbar-actions">
        <span class="status-pill status-${status}" role="status"${syncedAt ? ` title="${escapeAttribute(syncedAt)}"` : ''}>
          ${escapeHtml(tr(options[status]))}
        </span>
        <button class="icon-button" data-action="show-app-settings" aria-label="${escapeAttribute(tr('app_settings_aria'))}">⚙</button>
        ${isPanelMode() && canUseFullscreen() ? renderFullscreenButton() : ''}
      </div>
    </header>
    ${state.screen === 'picker' ? renderViewPicker() : renderDashboard()}
  `;
}

function renderViewPicker(): string {
  const hasIntercom = state.intercoms.length > 0;
  return `
    <section class="picker-screen">
      <div class="picker-heading">
        <p class="eyebrow">${escapeHtml(state.miniserverName ?? tr('topbar_fallback_name'))}</p>
        <h1>${escapeHtml(tr('picker_title'))}</h1>
      </div>
      <article class="panel picker-card">
        <div class="picker-card-head">
          <span class="picker-icon" aria-hidden="true"></span>
          <div>
            <h2>${escapeHtml(tr('picker_intercom'))}</h2>
            <p class="subtle">${escapeHtml(hasIntercom
              ? tr('picker_detected_intercoms', { count: state.intercoms.length })
              : tr('picker_no_intercom'))}</p>
          </div>
        </div>
        <div class="inline-actions">
          <button class="action-button" data-action="add-intercom-view" ${hasIntercom ? '' : 'disabled'}>
            ${escapeHtml(tr('picker_add_intercom'))}
          </button>
          <button class="ghost-button" data-action="configure-intercom-view" ${hasIntercom ? '' : 'disabled'}>
            ${escapeHtml(tr('configure_now'))}
          </button>
        </div>
      </article>
    </section>
  `;
}

function renderDashboard(): string {
  return `
    <section class="dashboard-screen">
      ${state.views.length > 1 ? renderViewTabs() : ''}
      ${state.currentView ? renderIntercomStage() : renderEmptyDashboard()}
    </section>
  `;
}

function renderViewTabs(): string {
  return `
    <nav class="view-tabs" aria-label="${escapeAttribute(tr('views_section'))}">
      ${state.views
        .map(
          (view) => `
            <button
              class="view-chip ${view.id === state.activeViewId ? 'view-chip-active' : ''}"
              data-action="select-view"
              aria-current="${view.id === state.activeViewId ? 'true' : 'false'}"
              data-view-id="${escapeAttribute(view.id)}"
            >
              ${escapeHtml(view.title)}
            </button>
          `,
        )
        .join('')}
    </nav>
  `;
}

function renderEmptyDashboard(): string {
  return `
    <section class="panel">
      <h2>${escapeHtml(tr('dashboard_no_view_title'))}</h2>
      <p class="empty-copy">${escapeHtml(tr('dashboard_no_view_copy'))}</p>
    </section>
  `;
}

function renderIntercomStage(): string {
  const currentView = state.currentView;
  if (!currentView) {
    return renderEmptyDashboard();
  }
  const { intercom, config } = currentView;
  const viewId = escapeAttribute(config.id);
  if (!intercom) {
    return `
      <section class="panel">
        <h1>${escapeHtml(config.title)}</h1>
        <p class="empty-copy">${escapeHtml(tr('view_needs_config'))}</p>
        <button class="ghost-button" data-action="show-view-settings" data-view-id="${viewId}">${escapeHtml(tr('configure_now'))}</button>
      </section>
    `;
  }

  const realtimeAvailable = isRealtimeAvailable();
  const controlsDisabled = realtimeAvailable ? '' : 'disabled';
  const conversationPending = browserConversationState === 'starting';
  const conversationActive = isIntercomConversationActive();
  const hasRtcMedia = intercomRtcSession.hasRemoteStreamFor(intercom.uuidAction);
  const fallbackMediaUrl = resolveFallbackMediaUrl(intercom);
  const hasVisualMedia = hasRtcMedia || Boolean(fallbackMediaUrl);
  const canPreview = realtimeAvailable && canUseRtcPreview(intercom);
  const connectLabel = conversationPending ? tr('cancel_connection')
    : conversationActive ? tr('disconnect')
    : intercom.doorbellActive ? tr('answer')
    : tr('connect');
  const canConnect = conversationActive || (realtimeAvailable &&
    ((intercom.doorbellActive && intercom.supportsAnswer) || canStartBrowserConversation(intercom)));
  const location = [state.miniserverName, intercom.roomName].filter(Boolean).join(' / ');
  const mediaLabel = intercom.doorbellActive ? tr('doorbell_ringing')
    : conversationActive && !conversationPending ? tr('conversation_active')
    : hasRtcMedia ? tr('camera_live')
    : tr('camera_preview');

  return `
    <article class="intercom-layout">
      <header class="media-header">
        <div>
          ${location ? `<p class="eyebrow">${escapeHtml(location)}</p>` : ''}
          <h1>${escapeHtml(config.title || intercom.name)}</h1>
          ${config.title && config.title !== intercom.name ? `<p class="subtle intercom-name">${escapeHtml(intercom.name)}</p>` : ''}
        </div>
        <button class="icon-button" data-action="show-view-settings" data-view-id="${viewId}" aria-label="${escapeAttribute(tr('view_settings_aria'))}">✎</button>
      </header>
      <section class="panel media-panel">
        <div class="media-frame ${intercom.doorbellActive ? 'media-frame-bell-active' : ''} ${conversationActive ? 'media-frame-conversation-active' : ''}">
          ${renderMedia(intercom, fallbackMediaUrl)}
          ${!hasVisualMedia ? `
            <div class="media-frame-status-overlay">
              <span class="camera-reticle" aria-hidden="true"></span>
              <span>${escapeHtml(tr(!realtimeAvailable ? 'offline_intercom' : canPreview && !failedPreviewUrls.size ? 'rtc_connecting' : 'media_empty'))}</span>
            </div>
          ` : ''}
          <span class="media-label ${hasRtcMedia ? 'media-label-live' : ''}" role="status">${escapeHtml(mediaLabel)}</span>
        </div>
        <div class="media-overlay-controls">
          <button class="action-button call-button ${conversationActive ? 'call-button-active' : ''}"
            data-action="connect-toggle" data-view-id="${viewId}" ${canConnect ? '' : 'disabled'}>
            <span class="call-symbol" aria-hidden="true"></span>
            ${escapeHtml(connectLabel)}
          </button>
          ${intercom.supportsMute ? `
            <button class="ghost-button" data-action="${intercom.doorbellMuted ? 'unmute' : 'mute'}"
              data-view-id="${viewId}" ${controlsDisabled}>
              ${escapeHtml(tr(intercom.doorbellMuted ? 'unmute_bell' : 'mute_bell'))}
            </button>
          ` : ''}
        </div>
        ${renderBrowserConversationStatus()}
      </section>
      <div class="intercom-side">
        ${renderIntercomTools(intercom, config, controlsDisabled)}
        ${renderInsightRail(intercom)}
      </div>
    </article>
  `;
}

function renderIntercomTools(intercom: CurrentIntercom, config: IntercomViewConfig, controlsDisabled: string): string {
  const viewId = escapeAttribute(config.id);
  const panelMode = isPanelMode();
  const phrases = config.quickTts.filter((phrase) => phrase.message.trim());
  const shortcuts = panelMode ? phrases.slice(0, 3) : [];
  const writtenMessage = `
    <form class="tts-form" data-form="tts" data-render-key="${viewId}">
      <input type="hidden" name="viewId" value="${viewId}" />
      <textarea id="tts-message" name="message" rows="2" required maxlength="300" aria-label="${escapeAttribute(tr('voice_message'))}"
        placeholder="${escapeAttribute(tr('tts_placeholder'))}" ${controlsDisabled}></textarea>
      <div class="tts-controls">
        <button class="action-button" type="submit" ${controlsDisabled}>${escapeHtml(tr('tts_read'))}</button>
        ${!panelMode && phrases.length ? renderSavedMessagesButton(viewId, controlsDisabled) : ''}
      </div>
    </form>
  `;
  return `
    ${intercom.functions.length ? `
      <section class="panel action-panel">
        <h2 class="panel-title">${escapeHtml(tr('actions'))}</h2>
        <div class="secondary-action-grid">
          ${intercom.functions.map((item) => `
            <button class="ghost-button function-button" data-action="run-child-function" data-view-id="${viewId}"
              data-function-uuid-action="${escapeAttribute(item.uuidAction)}" ${controlsDisabled}>
              ${escapeHtml(item.name)}
            </button>
          `).join('')}
        </div>
      </section>
    ` : ''}
    <section class="panel action-panel voice-panel">
      <h2 class="panel-title">${escapeHtml(tr('voice_message'))}</h2>
      ${shortcuts.length ? `
        <div class="panel-voice-shortcuts">
          ${shortcuts.map((phrase) => `
            <button type="button" class="ghost-button" data-action="send-quick-message"
              data-view-id="${viewId}" data-phrase-id="${escapeAttribute(phrase.id)}" ${controlsDisabled}>
              ${escapeHtml(phrase.label || phrase.message)}
            </button>
          `).join('')}
          ${phrases.length > shortcuts.length ? renderSavedMessagesButton(viewId, controlsDisabled) : ''}
        </div>
        <details class="panel-voice-compose" data-render-key="${viewId}">
          <summary>${escapeHtml(tr('compose_voice_message'))}</summary>
          ${writtenMessage}
        </details>
      ` : writtenMessage}
    </section>
  `;
}

function renderSavedMessagesButton(viewId: string, controlsDisabled: string): string {
  return `<button type="button" class="ghost-button saved-messages-button" data-action="open-saved-messages"
    data-view-id="${viewId}" ${controlsDisabled}>${escapeHtml(tr('saved_messages'))}</button>`;
}

function renderInsightRail(intercom: CurrentIntercom): string {
  const hasActivityLog = Boolean(intercom.activityLogSourceName);
  const selectedTab = sidePanelTab === 'log' && hasActivityLog ? 'log' : 'history';
  const historyActive = selectedTab === 'history';
  return `
    <section class="panel insight-rail">
      <div class="insight-rail-handles">
        <button class="rail-tab-button" data-action="open-side-panel" data-tab="history"
          aria-controls="insight-drawer" aria-expanded="${sidePanelOpen && historyActive}">
          ${escapeHtml(tr('photos'))}
        </button>
        ${hasActivityLog ? `
          <button class="rail-tab-button" data-action="open-side-panel" data-tab="log"
            aria-controls="insight-drawer" aria-expanded="${sidePanelOpen && !historyActive}">
            ${escapeHtml(tr('log'))}
          </button>
        ` : ''}
      </div>
      <div class="insight-drawer" id="insight-drawer" ${sidePanelOpen ? '' : 'hidden'}>
        ${sidePanelOpen ? historyActive ? renderHistoryPanel(intercom) : renderActivityLogPanel(intercom) : ''}
      </div>
    </section>
  `;
}

function renderHistoryPanel(intercom: CurrentIntercom): string {
  const items = viewHistory(intercom);
  if (!items.length) {
    return `<p class="empty-copy">${escapeHtml(tr('no_photos'))}</p>`;
  }
  return `
    <div class="history-grid">
      ${items.map((item) => `
        <button class="history-card" type="button" data-action="open-history-image"
          data-timestamp="${escapeAttribute(item.timestamp)}"
          aria-label="${escapeAttribute(tr('open_photo_aria', { label: item.label }))}">
          <img src="${escapeAttribute(resolveHistoryImageDisplayUrl(item.imageUrl, intercom))}"
            alt="" loading="lazy" decoding="async" data-history-source-url="${escapeAttribute(item.imageUrl)}" />
          <span>${escapeHtml(item.label)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function renderActivityLogPanel(intercom: NonNullable<AppViewModel['currentView']>['intercom']): string {
  if (!intercom) {
    return '';
  }
  const groupedEntries = groupActivityLogEntries(intercom.activityLog);
  return `
    <div class="drawer-section">
      <div class="section-head compact">
        <p class="eyebrow">${escapeHtml(intercom.activityLogSourceName ?? tr('event_log_source_fallback'))}</p>
      </div>
      ${
        intercom.activityLogSourceName
          ? intercom.activityLog.length > 0
            ? `
              <div class="activity-log activity-log-drawer">
                ${groupedEntries
                  .map(
                    (group) => `
                      <section class="activity-log-group">
                        <header class="activity-log-date">${escapeHtml(group.dateLabel)}</header>
                        <div class="activity-log-group-items">
                          ${group.items
                            .map(
                              (item) => `
                                <article class="activity-log-item">
                                  ${item.timeLabel ? `<span class="activity-log-time">${escapeHtml(item.timeLabel)}</span>` : ''}
                                  <p>${escapeHtml(item.message)}</p>
                                </article>
                              `,
                            )
                            .join('')}
                        </div>
                      </section>
                    `,
                  )
                  .join('')}
              </div>
            `
            : intercom.activityLogWarning
              ? `<p class="empty-copy">${escapeHtml(intercom.activityLogWarning)}</p>`
              : `<p class="empty-copy">${escapeHtml(tr('log_not_published'))}</p>`
          : `<p class="empty-copy">${escapeHtml(tr('log_attach_source'))}</p>`
      }
    </div>
  `;
}

function renderSettingsOverlay(): string {
  const isAppSettings = state.settingsMode === 'app';
  const isViewSettings = state.settingsMode === 'view';
  return `
    <dialog id="settings-dialog" role="dialog" aria-modal="true" data-render-key="settings-dialog" class="overlay-panel" aria-labelledby="settings-title">
        <div class="section-head">
          <h2 id="settings-title">${escapeHtml(isAppSettings ? tr('app_settings') : tr('view_settings'))}</h2>
          <button class="icon-button" data-action="close-settings" data-dialog-close autofocus aria-label="${escapeAttribute(tr('close_settings_aria'))}">×</button>
        </div>
        ${isAppSettings ? renderAppSettingsContent() : ''}
        ${isViewSettings ? renderViewSettingsContent() : ''}
        ${state.notice ? renderNotice(true) : ''}
    </dialog>
  `;
}

function renderSavedMessagesOverlay(): string {
  const currentView = state.currentView;
  if (!savedMessagesDialogViewId || !currentView || currentView.config.id !== savedMessagesDialogViewId) {
    return '';
  }
  const phrases = currentView.config.quickTts.filter((phrase) => phrase.message.trim());
  if (phrases.length === 0) {
    return '';
  }
  const selectedPhrase = phrases.find((phrase) => phrase.id === selectedSavedMessageId) ?? phrases[0] ?? null;
  return `
    <dialog id="messages-dialog" role="dialog" aria-modal="true" data-render-key="messages-dialog" class="overlay-panel saved-messages-panel" aria-labelledby="messages-title">
        <div class="section-head">
          <h2 id="messages-title">${escapeHtml(tr('saved_messages'))}</h2>
          <button class="icon-button" data-action="close-saved-messages" data-dialog-close aria-label="${escapeAttribute(tr('close_saved_messages_aria'))}">×</button>
        </div>
        <div class="saved-messages-list" role="group" aria-label="${escapeAttribute(tr('saved_messages'))}">
          ${phrases
            .map(
              (phrase) => `
                <button
                  type="button"
                  class="saved-message-item ${selectedPhrase?.id === phrase.id ? 'saved-message-item-active' : ''}"
                  data-action="select-saved-message"
                  data-phrase-id="${escapeAttribute(phrase.id)}"
                  aria-pressed="${selectedPhrase?.id === phrase.id}"
                  ${selectedPhrase?.id === phrase.id ? 'autofocus' : ''}
                >
                  <strong>${escapeHtml(phrase.label || phrase.message)}</strong>
                  ${phrase.label && phrase.label !== phrase.message ? `<span>${escapeHtml(phrase.message)}</span>` : ''}
                </button>
              `,
            )
            .join('')}
        </div>
        <div class="saved-messages-actions">
          <button type="button" class="ghost-button" data-action="close-saved-messages">${escapeHtml(tr('cancel'))}</button>
          <button
            type="button"
            class="action-button"
            data-action="confirm-saved-message"
            data-view-id="${escapeAttribute(savedMessagesDialogViewId)}"
            data-phrase-id="${escapeAttribute(selectedPhrase?.id ?? '')}"
          >
            ${escapeHtml(tr('send_selected_message'))}
          </button>
        </div>
    </dialog>
  `;
}

function renderHistoryImageOverlay(item: IntercomHistoryItem): string {
  const intercom = state.currentView?.intercom ?? null;
  const imageSrc = intercom ? resolveHistoryImageDisplayUrl(item.imageUrl, intercom) : TRANSPARENT_1PX;
  const previous = getAdjacentHistoryImage(-1);
  const next = getAdjacentHistoryImage(1);
  return `
    <dialog id="history-dialog" role="dialog" aria-modal="true" data-render-key="history-dialog" class="overlay-panel history-lightbox history-lightbox-panel" aria-labelledby="history-title">
        <div class="section-head history-lightbox-head">
          <h2 id="history-title">${escapeHtml(item.label || tr('photo_title'))}</h2>
          <div class="inline-actions">
            <button
              class="icon-button"
              data-action="history-image-prev"
              aria-label="${escapeAttribute(tr('previous_photo_aria'))}"
              ${previous ? '' : 'disabled'}
            >
              ‹
            </button>
            <button
              class="icon-button"
              data-action="history-image-next"
              aria-label="${escapeAttribute(tr('next_photo_aria'))}"
              ${next ? '' : 'disabled'}
            >
              ›
            </button>
            <button class="icon-button" data-action="close-history-image" data-dialog-close autofocus aria-label="${escapeAttribute(tr('close_photo_aria'))}">×</button>
          </div>
        </div>
        <div class="history-lightbox-body">
          <img
            class="history-lightbox-image"
            src="${escapeAttribute(imageSrc)}"
            alt="${escapeAttribute(item.label)}"
            loading="eager"
            decoding="async"
            data-history-source-url="${escapeAttribute(item.imageUrl)}"
          />
        </div>
    </dialog>
  `;
}

function getAdjacentHistoryImage(offset: -1 | 1): IntercomHistoryItem | null {
  if (!selectedHistoryImage) {
    return null;
  }
  const intercom = state.currentView?.intercom;
  if (!intercom) {
    return null;
  }
  const historyItems = viewHistory(intercom);
  const currentIndex = historyItems.findIndex((item) => item.timestamp === selectedHistoryImage?.timestamp);
  if (currentIndex === -1) {
    return null;
  }
  return historyItems[currentIndex + offset] ?? null;
}

function renderAppSettingsContent(): string {
  return `
    <div class="settings-grid">
      <article class="panel settings-panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('server_section'))}</p>
        </div>
        ${renderServerForm('settings')}
        ${renderLanguageForm()}
        ${renderPanelSettings()}
        <div class="settings-panel-footer">
          <a
            class="support-link"
            href="https://buymeacoffee.com/szymonrybka"
            target="_blank"
            rel="noreferrer noopener"
          >
            buy me a coffee
          </a>
        </div>
      </article>
      <article class="panel settings-panel">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('views_section'))}</p>
          <button class="ghost-button mini-button" data-action="configure-intercom-view">${escapeHtml(tr('new_intercom'))}</button>
        </div>
        ${state.views.length > 0 ? renderViewList() : `<p class="empty-copy">${escapeHtml(tr('no_saved_views'))}</p>`}
      </article>
    </div>
  `;
}

function renderLanguageForm(): string {
  return `
    <div class="server-form server-form-secondary">
      <label>
        <span>${escapeHtml(tr('language_label'))}</span>
        <select name="languageOverride">
          <option value="" ${state.languageOverride === null ? 'selected' : ''}>${escapeHtml(tr('language_browser_default', { language: describeLanguage(state.language) }))}</option>
          <option value="pl" ${state.languageOverride === 'pl' ? 'selected' : ''}>${escapeHtml(tr('language_polish'))}</option>
          <option value="en" ${state.languageOverride === 'en' ? 'selected' : ''}>${escapeHtml(tr('language_english'))}</option>
          <option value="de" ${state.languageOverride === 'de' ? 'selected' : ''}>${escapeHtml(tr('language_german'))}</option>
        </select>
      </label>
    </div>
  `;
}

function renderPanelSettings(): string {
  return `
    <div class="display-settings">
      <label class="toggle-row">
        <span>${escapeHtml(tr('panel_mode'))}</span>
        <input type="checkbox" name="panelMode" ${isPanelMode() ? 'checked' : ''} />
      </label>
      ${isPanelMode() && canKeepScreenAwake() ? `
        <label class="toggle-row">
          <span>${escapeHtml(tr('keep_awake'))}</span>
          <input type="checkbox" name="keepScreenAwake" ${state.keepScreenAwake ? 'checked' : ''} />
        </label>
        ${wakeLockUnavailable ? `<p class="empty-copy" role="status">${escapeHtml(tr('wake_lock_unavailable'))}</p>` : ''}
      ` : ''}
      ${canInstallPwa() ? `<button type="button" class="ghost-button" data-action="install-pwa">${escapeHtml(tr('install_app'))}</button>` : ''}
      ${canApplyPwaUpdate() ? `<button type="button" class="ghost-button" data-action="apply-pwa-update">${escapeHtml(tr('update_app'))}</button>` : ''}
      ${updateStatus ? `<p class="empty-copy" role="status">${escapeHtml(tr(updateStatus === 'close-other-tabs' ? 'update_close_tabs' : 'update_unavailable'))}</p>` : ''}
    </div>
  `;
}

function canUseFullscreen(): boolean {
  return Boolean(document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function');
}

function renderFullscreenButton(): string {
  const fullscreen = Boolean(document.fullscreenElement);
  const label = tr(fullscreen ? 'exit_fullscreen' : 'enter_fullscreen');
  return `
    <button type="button" class="icon-button" data-action="panel-fullscreen"
      aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}"><span class="fullscreen-icon" aria-hidden="true"></span></button>
    ${fullscreenFailed ? `<span class="fullscreen-feedback" role="status">${escapeHtml(tr('fullscreen_unavailable'))}</span>` : ''}
  `;
}

async function togglePanelFullscreen(): Promise<void> {
  fullscreenFailed = false;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    fullscreenFailed = true;
  }
  render();
}

function renderViewSettingsContent(): string {
  const editorView = localViewDraft ?? state.currentEditorView;
  return `
    <div class="settings-grid settings-grid-single">
      <article class="panel">
        ${editorView ? renderViewEditor(editorView) : `<p class="empty-copy">${escapeHtml(tr('no_editor_view'))}</p>`}
      </article>
    </div>
  `;
}

function renderServerForm(section: 'setup' | 'settings' = 'setup'): string {
  const serverForm = localServerDraft ?? state.serverForm;
  const connecting = state.connection.status === 'connecting';
  const address = parseConnectionAddress(serverForm.origin);
  const showSerial = needsConnectionSerial(address);
  const hintId = `connection-address-hint-${section}`;
  const serial = showSerial ? parseMiniserverSerial(serverForm.serial ?? '') : remoteConnectSerial(address);
  return `
    <form class="server-form" data-form="server">
      <label>
        <span>${escapeHtml(tr('connection_address_or_serial'))}</span>
        <input name="origin" required autocapitalize="none" spellcheck="false" aria-describedby="${hintId}"
          placeholder="https://connect.loxonecloud.com/…" value="${escapeAttribute(serverForm.origin)}" />
      </label>
      <div class="server-connection-help">
        ${showSerial ? `
          <label>
            <span>${escapeHtml(tr('miniserver_serial'))}</span>
            <input name="serial" required autocapitalize="characters" spellcheck="false"
              aria-describedby="${hintId}" value="${escapeAttribute(serverForm.serial ?? '')}" />
          </label>
        ` : ''}
        <p id="${hintId}" class="field-hint">${escapeHtml(tr(showSerial ? 'local_http_needs_serial' : 'connection_serial_hint'))}</p>
        ${serial ? `
          <a class="support-link" href="${escapeAttribute(remoteConnectUrl(serial))}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(tr('open_remote_connect'))}
          </a>
          ${state.connection.status === 'error' ? `<p class="field-hint">${escapeHtml(tr('remote_connect_manual_hint'))}</p>` : ''}
        ` : ''}
      </div>
      <label>
        <span>${escapeHtml(tr('login'))}</span>
        <input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeAttribute(serverForm.username)}" />
      </label>
      <label>
        <span>${escapeHtml(tr('password'))}</span>
        <input name="password" type="password" autocomplete="current-password" ${serverForm.passwordStored ? '' : 'required'} placeholder="${escapeAttribute(serverForm.passwordStored ? tr('password_keep') : tr('password_placeholder'))}" value="${escapeAttribute(localServerDraft?.password ?? '')}" />
      </label>
      <button class="action-button action-button-wide" type="submit" ${connecting ? 'disabled' : ''}>
        ${escapeHtml(tr(connecting ? 'rtc_connecting' : 'save_and_connect'))}
      </button>
    </form>
  `;
}

function needsConnectionSerial(address: URL | null): boolean {
  return window.location.protocol === 'https:' && address?.protocol === 'http:';
}

function renderViewList(): string {
  return `
    <div class="view-list">
      ${state.views
        .map(
          (view) => {
            const deviceName = resolveIntercomName(view.intercomUuidAction);
            return `
            <article class="view-list-item ${view.id === state.settingsEditorViewId ? 'view-list-item-active' : ''}">
              <div>
                <strong>${escapeHtml(view.title)}</strong>
                ${deviceName !== view.title ? `<p>${escapeHtml(deviceName)}</p>` : ''}
              </div>
              <div class="inline-actions">
                <button class="ghost-button mini-button" data-action="edit-view" data-view-id="${escapeAttribute(view.id)}">${escapeHtml(tr('edit'))}</button>
                <button class="ghost-button mini-button" data-action="set-default-view" data-view-id="${escapeAttribute(view.id)}">${escapeHtml(tr('default'))}</button>
                <button class="ghost-button mini-button" data-action="delete-view" data-view-id="${escapeAttribute(view.id)}">${escapeHtml(tr('delete'))}</button>
              </div>
            </article>
            `;
          },
        )
        .join('')}
    </div>
  `;
}

function renderViewEditor(view: IntercomViewConfig): string {
  return `
    <form class="view-form" data-form="view">
      <input type="hidden" name="viewId" value="${escapeAttribute(view.id)}" />
      <label>
        <span>${escapeHtml(tr('view_name'))}</span>
        <input name="title" required value="${escapeAttribute(view.title)}" />
      </label>
      <label>
        <span>${escapeHtml(tr('intercom_label'))}</span>
        <select name="intercomUuidAction">
          <option value="">${escapeHtml(tr('first_found_intercom'))}</option>
          ${state.intercoms
            .map(
              (intercom) => `
                <option value="${escapeAttribute(intercom.uuidAction)}" ${view.intercomUuidAction === intercom.uuidAction ? 'selected' : ''}>
                  ${escapeHtml(intercom.name)}${intercom.roomName ? ` · ${escapeHtml(intercom.roomName)}` : ''}
                </option>
              `,
            )
            .join('')}
        </select>
      </label>
      <label>
        <span>${escapeHtml(tr('optional_log_source'))}</span>
        <select name="activityLogControlUuidAction">
          <option value="">${escapeHtml(tr('no_extra_log'))}</option>
          ${state.logSources
            .map(
              (source) => `
                <option value="${escapeAttribute(source.uuidAction)}" ${view.activityLogControlUuidAction === source.uuidAction ? 'selected' : ''}>
                  ${escapeHtml(source.name)}${source.roomName ? ` · ${escapeHtml(source.roomName)}` : ''} (${escapeHtml(source.type)})
                </option>
              `,
            )
            .join('')}
        </select>
      </label>
      <label>
        <span>${escapeHtml(tr('history_limit'))}</span>
        <input name="historyLimit" type="number" min="3" max="20" value="${escapeAttribute(String(view.historyLimit))}" />
      </label>
      <div class="tts-editor">
        <div class="section-head compact">
          <p class="eyebrow">${escapeHtml(tr('quick_tts'))}</p>
          <button class="ghost-button mini-button" type="button" data-action="add-tts-row">${escapeHtml(tr('add_phrase'))}</button>
        </div>
        <div id="tts-editor-rows">
          ${view.quickTts.map(renderTtsRow).join('')}
        </div>
      </div>
      <button class="action-button action-button-wide" type="submit">${escapeHtml(tr('save_view'))}</button>
    </form>
  `;
}

function renderTtsRow(phrase: QuickTtsPhrase): string {
  return `
    <div class="tts-row" data-phrase-id="${escapeAttribute(phrase.id)}">
      <input name="phraseMessage" maxlength="300" aria-label="${escapeAttribute(tr('phrase_placeholder'))}" placeholder="${escapeAttribute(tr('phrase_placeholder'))}" value="${escapeAttribute(phrase.message ?? phrase.label ?? '')}" />
      <button class="icon-button tts-row-remove" type="button" data-action="remove-tts-row" aria-label="${escapeAttribute(tr('remove_phrase_aria'))}">×</button>
    </div>
  `;
}

function renderNotice(inDialog = false): string {
  if (!state.notice) {
    return '';
  }
  const label =
    state.notice.kind === 'error' ? tr('app_warning') : state.notice.kind === 'success' ? tr('app_ok') : tr('app_info');
  return `
    <section class="notice notice-${state.notice.kind} toast-notice ${inDialog ? 'dialog-notice' : ''}" role="${state.notice.kind === 'error' ? 'alert' : 'status'}">
      <span class="toast-dot toast-dot-${state.notice.kind}" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <p>${escapeHtml(state.notice.message)}</p>
      </div>
      <button class="icon-button" data-action="dismiss-notice" aria-label="${escapeAttribute(tr('dismiss_notice_aria'))}">×</button>
    </section>
  `;
}

function renderBrowserConversationStatus(): string {
  if (browserConversationState !== 'error') {
    return '';
  }
  const tone = 'empty-copy';
  return `
    <div class="conversation-status" role="status">
      <p class="${tone}">${escapeHtml(browserConversationMessage)}</p>
    </div>
  `;
}

function isRealtimeAvailable(): boolean {
  return state.connection.status === 'online';
}

function canStartBrowserConversation(intercom: CurrentIntercom): boolean {
  return canUseRtcPreview(intercom) && Boolean(navigator.mediaDevices?.getUserMedia);
}

async function handleConnect(viewId: string): Promise<void> {
  const currentView = state.currentView;
  const intercom = currentView?.intercom;
  if (!intercom || currentView.config.id !== viewId) {
    return;
  }
  if (isIntercomConversationActive()) {
    stopBrowserConversation();
    return;
  }
  if (!isRealtimeAvailable()) {
    return;
  }
  if (intercom.doorbellActive && intercom.supportsAnswer) {
    post({ type: 'runBuiltInAction', viewId, action: 'answer' });
    if (!canStartBrowserConversation(intercom)) {
      browserConversationState = 'idle';
      browserConversationMessage = '';
      render();
      return;
    }
  }
  if (canUseRtcPreview(intercom)) {
    await startBrowserConversation();
  }
}

async function startBrowserConversation(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    browserConversationState = 'error';
    browserConversationMessage = tr('rtc_browser_unsupported');
    render();
    return;
  }

  const attempt = new AbortController();
  browserConversationAttempt = attempt;
  browserConversationState = 'starting';
  browserConversationMessage = '';
  render();

  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    throwIfAborted(attempt.signal);
    localMicrophoneStream = stream;
    await endingConversation;
    throwIfAborted(attempt.signal);

    const track = stream.getAudioTracks()[0];
    if (!track) {
      throw new IntercomMediaError('audio-unsupported');
    }
    const operation = intercomRtcSession.startConversation(track, attempt.signal);
    conversationNegotiation = operation;
    try {
      await operation;
    } finally {
      if (conversationNegotiation === operation) {
        conversationNegotiation = null;
      }
    }
    throwIfAborted(attempt.signal);

    browserConversationState = 'active';
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (localMicrophoneStream === stream) {
      localMicrophoneStream = null;
    }
    if (browserConversationAttempt !== attempt) {
      return;
    }
    browserConversationAttempt = null;
    browserConversationState = 'error';
    browserConversationMessage = describeConversationError(error);
  }
  render();
}

function describeConversationError(error: unknown): string {
  if (!(error instanceof IntercomMediaError)) {
    return tr('rtc_audio_failed', { message: toErrorMessage(error) });
  }
  switch (error.reason) {
    case 'timeout':
      return error.method === 'call' ? tr('intercom_call_timeout') : tr('signaling_open_failed');
    case 'response':
    case 'no-sdp':
    case 'audio-unsupported':
      return tr('intercom_audio_not_supported');
    case 'closed':
      return tr('signaling_closed');
    case 'auth':
      return tr('intercom_challenge_encrypt_failed');
    case 'transport':
      return tr('intercom_call_timeout');
    case 'open':
      return tr('signaling_open_failed');
  }
}

function stopBrowserConversation(renderAfter = true): void {
  browserConversationAttempt?.abort();
  browserConversationAttempt = null;
  if (localMicrophoneStream) {
    localMicrophoneStream.getTracks().forEach(track => track.stop());
    localMicrophoneStream = null;
  }
  const media = document.querySelector('#intercom-live-media');
  if (media instanceof HTMLVideoElement) {
    media.muted = true;
  }
  if (!endingConversation && (browserConversationState === 'active' || browserConversationState === 'starting')) {
    endingConversation = Promise.resolve(conversationNegotiation)
      .catch(() => undefined)
      .then(() => intercomRtcSession.endConversation())
      .finally(() => { endingConversation = null; });
  }
  browserConversationState = 'idle';
  browserConversationMessage = '';
  if (renderAfter) {
    render();
  }
}

function renderMedia(intercom: CurrentIntercom, fallbackUrl: string | null): string {
  if (intercomRtcSession.hasRemoteTrackFor(intercom.uuidAction)) {
    return `<video id="intercom-live-media" class="intercom-media" autoplay ${browserConversationState === 'active' ? '' : 'muted'} playsinline></video>`;
  }
  if (!fallbackUrl) {
    return '';
  }
  const src = escapeAttribute(fallbackUrl);
  if (isVideoLikeUrl(fallbackUrl)) {
    return `<video id="intercom-live-media" class="intercom-media" src="${src}" controls autoplay muted playsinline></video>`;
  }
  return `<img id="intercom-live-media" class="intercom-media" src="${src}" alt="${escapeAttribute(intercom.name)}" decoding="async" />`;
}

function isIntercomConversationActive(): boolean {
  return browserConversationState === 'active' || browserConversationState === 'starting';
}

function resolveFallbackMediaUrl(intercom: CurrentIntercom): string | null {
  const candidates = canUseRtcPreview(intercom)
    ? [intercom.snapshotUrl, resolveProxySnapshotUrl(intercom), intercom.streamUrl]
    : [intercom.streamUrl, intercom.snapshotUrl];
  for (const candidate of candidates) {
    if (candidate) {
      const url = resolveRenderableMediaUrl(candidate, intercom);
      if (url && !failedPreviewUrls.has(url)) {
        return url;
      }
    }
  }
  return null;
}

function requestVisibleHistoryCache(intercom: CurrentIntercom): void {
  const keys = [];
  for (const item of collectVisibleHistoryItems(intercom)) {
    const key = normalizeHistoryImageCacheKey(item.imageUrl);
    if (key && !historyImageCache.has(key) && !requestedHistoryImageKeys.has(key)) {
      keys.push(key);
      requestedHistoryImageKeys.add(key);
    }
  }
  if (keys.length) {
    post({ type: 'loadHistoryImageCache', requestId: historyCacheGeneration, keys });
  }
}

function viewHistory(intercom: CurrentIntercom): IntercomHistoryItem[] {
  const items = browserHistoryByIntercomUuidAction.get(intercom.uuidAction) ?? intercom.history;
  return items.slice(0, state.currentView?.config.historyLimit ?? 8);
}

function collectVisibleHistoryItems(intercom: CurrentIntercom): IntercomHistoryItem[] {
  if (!sidePanelOpen && !selectedHistoryImage) {
    return [];
  }

  const historyItems = viewHistory(intercom);
  const items = new Map<string, IntercomHistoryItem>();

  if (sidePanelOpen && sidePanelTab === 'history') {
    for (const item of historyItems) {
      items.set(item.timestamp, item);
    }
  }

  if (selectedHistoryImage) {
    items.set(selectedHistoryImage.timestamp, selectedHistoryImage);
  }

  return Array.from(items.values());
}

function resolveHistoryImageDisplayUrl(sourceUrl: string, intercom: CurrentIntercom): string {
  const key = normalizeHistoryImageCacheKey(sourceUrl);
  return (key ? historyImageCache.get(key) : null) || resolveRenderableMediaUrl(sourceUrl, intercom) || TRANSPARENT_1PX;
}

function normalizeHistoryImageCacheKey(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    url.username = '';
    url.password = '';
    url.searchParams.delete('auth');
    url.searchParams.delete('autht');
    url.searchParams.delete('cacheBuster');
    return JSON.stringify([state.serverForm.origin, state.serverForm.username, url.toString()]);
  } catch {
    return null;
  }
}

function cacheHistoryImageFromElement(image: HTMLImageElement, sourceUrl: string): void {
  const key = normalizeHistoryImageCacheKey(sourceUrl);
  if (!key || historyImageCache.has(key) || failedHistoryImageLoads.has(key) ||
      encodingHistoryImageKeys.has(key) || !image.naturalWidth || !image.naturalHeight) {
    return;
  }

  const generation = historyCacheGeneration;
  encodingHistoryImageKeys.add(key);
  const finish = (dataUrl: string | null) => {
    if (generation !== historyCacheGeneration) {
      return;
    }
    encodingHistoryImageKeys.delete(key);
    if (dataUrl) {
      historyImageCache.set(key, dataUrl);
      post({ type: 'saveHistoryImageCache', key, dataUrl });
    } else {
      failedHistoryImageLoads.add(key);
    }
  };

  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context || typeof canvas.toBlob !== 'function') {
      finish(null);
      return;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (generation !== historyCacheGeneration) {
        return;
      }
      if (!blob) {
        finish(null);
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => finish(typeof reader.result === 'string' ? reader.result : null);
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.86);
  } catch {
    // Cross-origin images can still be viewed when the browser disallows canvas export.
    finish(null);
  }
}

function resolveIntercomName(uuidAction: string | null): string {
  if (!uuidAction) {
    return tr('auto_first_intercom');
  }
  return state.intercoms.find((item) => item.uuidAction === uuidAction)?.name ?? tr('misc_other');
}

function newPhraseId(): string {
  // Keep editing available when the app runs over plain HTTP on a LAN.
  return crypto.getRandomValues(new Uint32Array(4)).join('-');
}

function appendTtsRow(): void {
  if (!ensureLocalViewDraft()) {
    return;
  }
  syncDraftFromViewForm();
  localViewDraft = {
    ...localViewDraft!,
    quickTts: [
      ...localViewDraft!.quickTts,
      { id: newPhraseId(), label: '', message: '' },
    ],
  };
  render();
}

function removeTtsRow(phraseId: string | null): void {
  if (!phraseId || !ensureLocalViewDraft()) {
    return;
  }
  syncDraftFromViewForm();
  localViewDraft = {
    ...localViewDraft!,
    quickTts: localViewDraft!.quickTts.filter((item) => item.id !== phraseId),
  };
  render();
}

function openSavedMessagesDialog(viewId: string): void {
  const view = state.views.find((item) => item.id === viewId);
  const phrases = view?.quickTts.filter((phrase) => phrase.message.trim()) ?? [];
  if (phrases.length === 0) {
    return;
  }
  savedMessagesDialogViewId = viewId;
  selectedSavedMessageId = phrases[0]?.id ?? null;
  render();
}

function closeSavedMessagesDialog(): void {
  savedMessagesDialogViewId = null;
  selectedSavedMessageId = null;
}

function sendSavedMessage(viewId: string, phraseId: string): void {
  const view = state.currentView?.config;
  if (view?.id !== viewId || !isRealtimeAvailable()) {
    return;
  }
  const phrase = view.quickTts.find((item) => item.id === phraseId && item.message.trim());
  if (!phrase) {
    return;
  }
  post({
    type: 'sendTts',
    viewId,
    message: phrase.message,
  });
  closeSavedMessagesDialog();
  render();
}

function collectQuickTts(form: HTMLFormElement, includeEmpty = false): QuickTtsPhrase[] {
  return Array.from(form.querySelectorAll<HTMLElement>('.tts-row'))
    .map((row) => ({
      id: row.dataset.phraseId || newPhraseId(),
      label: row.querySelector<HTMLInputElement>('input[name="phraseMessage"]')?.value.trim() ?? '',
      message: row.querySelector<HTMLInputElement>('input[name="phraseMessage"]')?.value.trim() ?? '',
    }))
    .filter((item) => includeEmpty || item.label || item.message);
}

root.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const serverForm = target.closest<HTMLFormElement>('form[data-form="server"]');
  if (serverForm) {
    const previousAddress = parseConnectionAddress(localServerDraft?.origin ?? state.serverForm.origin);
    const previousSerial = localServerDraft?.serial ?? state.serverForm.serial ?? '';
    syncDraftFromServerForm(serverForm);
    const address = parseConnectionAddress(localServerDraft?.origin ?? '');
    if (needsConnectionSerial(previousAddress) !== needsConnectionSerial(address) ||
        remoteConnectSerial(previousAddress) !== remoteConnectSerial(address) ||
        parseMiniserverSerial(previousSerial) !== parseMiniserverSerial(localServerDraft?.serial ?? '')) {
      render();
    }
    return;
  }
  const form = target.closest<HTMLFormElement>('form[data-form="view"]');
  if (!form) {
    return;
  }
  syncDraftFromViewForm(form);
});

root.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const serverForm = target.closest<HTMLFormElement>('form[data-form="server"]');
  if (serverForm) {
    syncDraftFromServerForm(serverForm);
    return;
  }
  const form = target.closest<HTMLFormElement>('form[data-form="view"]');
  if (!form) {
    return;
  }
  syncDraftFromViewForm(form);
});

function syncLocalViewDraft(): void {
  if (localServerDraft) {
    if (state.screen === 'loading' || state.settingsMode === 'app') {
      localServerDraft.passwordStored = state.serverForm.passwordStored;
    } else {
      localServerDraft = null;
    }
  }
  if (state.settingsMode !== 'view' || !state.currentEditorView) {
    localViewDraft = null;
    return;
  }
  if (!localViewDraft || localViewDraft.id !== state.currentEditorView.id) {
    localViewDraft = {
      ...state.currentEditorView,
      quickTts: state.currentEditorView.quickTts.map((phrase) => ({ ...phrase })),
    };
  }
}

function syncDraftFromServerForm(form?: HTMLFormElement | null): void {
  const sourceForm = form ?? document.querySelector<HTMLFormElement>('form[data-form="server"]');
  if (!sourceForm) {
    return;
  }
  const formData = new FormData(sourceForm);
  const serialField = sourceForm.querySelector<HTMLInputElement>('input[name="serial"]');
  localServerDraft = {
    origin: String(formData.get('origin') ?? '').trim(),
    serial: serialField
      ? String(formData.get('serial') ?? '').trim().toUpperCase()
      : (localServerDraft?.serial ?? state.serverForm.serial ?? ''),
    username: String(formData.get('username') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
    passwordStored: state.serverForm.passwordStored,
  };
}

function ensureLocalViewDraft(): boolean {
  if (localViewDraft) {
    return true;
  }
  if (!state.currentEditorView) {
    return false;
  }
  syncLocalViewDraft();
  return Boolean(localViewDraft);
}

function syncDraftFromViewForm(form?: HTMLFormElement | null): void {
  if (!ensureLocalViewDraft()) {
    return;
  }
  const sourceForm = form ?? document.querySelector<HTMLFormElement>('form[data-form="view"]');
  if (!sourceForm) {
    return;
  }
  const formData = new FormData(sourceForm);
  localViewDraft = {
    id: String(formData.get('viewId') ?? localViewDraft!.id),
    type: 'intercom',
    title: String(formData.get('title') ?? '').trim() || 'Interkom',
    intercomUuidAction: normalizeNullable(String(formData.get('intercomUuidAction') ?? '')),
    activityLogControlUuidAction: normalizeNullable(
      String(formData.get('activityLogControlUuidAction') ?? ''),
    ),
    historyLimit: Number(formData.get('historyLimit') ?? 8),
    quickTts: collectQuickTts(sourceForm, true),
  };
}

function post(message: MainToWorkerMessage): void {
  worker.postMessage(message);
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(localeForLanguage(state.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function normalizeNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function describeLanguage(value: AppLanguage): string {
  switch (value) {
    case 'en':
      return tr('language_english');
    case 'de':
      return tr('language_german');
    default:
      return tr('language_polish');
  }
}

function normalizeLanguage(value: string): AppLanguage | null {
  return value === 'en' ? 'en' : value === 'de' ? 'de' : value === 'pl' ? 'pl' : null;
}

function groupActivityLogEntries(items: ActivityLogItem[]): Array<{
  dateLabel: string;
  items: Array<{ timeLabel: string | null; message: string }>;
}> {
  const parsedItems = items
    .map((item, index) => parseActivityLogLabel(item.label, index))
    .sort((left, right) => right.sortKey - left.sortKey);

  const groups: Array<{
    dateLabel: string;
    items: Array<{ timeLabel: string | null; message: string }>;
  }> = [];

  for (const item of parsedItems) {
    const currentGroup = groups[groups.length - 1];
    if (!currentGroup || currentGroup.dateLabel !== item.dateLabel) {
      groups.push({
        dateLabel: item.dateLabel,
        items: [{ timeLabel: item.timeLabel, message: item.message }],
      });
      continue;
    }
    currentGroup.items.push({ timeLabel: item.timeLabel, message: item.message });
  }

  return groups;
}

function parseActivityLogLabel(
  label: string,
  fallbackIndex: number,
): {
  dateLabel: string;
  timeLabel: string | null;
  message: string;
  sortKey: number;
} {
  const isoMatch = label.match(
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[ T](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?\s+(?<message>.+)$/u,
  );
  if (isoMatch?.groups) {
    const second = isoMatch.groups.second ?? '00';
    const sortValue = Date.parse(
      `${isoMatch.groups.year}-${isoMatch.groups.month}-${isoMatch.groups.day}T${isoMatch.groups.hour}:${isoMatch.groups.minute}:${second}`,
    );
    return {
      dateLabel: `${isoMatch.groups.year}-${isoMatch.groups.month}-${isoMatch.groups.day}`,
      timeLabel: `${isoMatch.groups.hour}:${isoMatch.groups.minute}${isoMatch.groups.second ? `:${isoMatch.groups.second}` : ''}`,
      message: isoMatch.groups.message.trim(),
      sortKey: Number.isNaN(sortValue) ? Number.MAX_SAFE_INTEGER - fallbackIndex : sortValue,
    };
  }

  const europeanMatch = label.match(
    /^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})[ T](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?\s+(?<message>.+)$/u,
  );
  if (europeanMatch?.groups) {
    const second = europeanMatch.groups.second ?? '00';
    const sortValue = Date.parse(
      `${europeanMatch.groups.year}-${europeanMatch.groups.month}-${europeanMatch.groups.day}T${europeanMatch.groups.hour}:${europeanMatch.groups.minute}:${second}`,
    );
    return {
      dateLabel: `${europeanMatch.groups.day}.${europeanMatch.groups.month}.${europeanMatch.groups.year}`,
      timeLabel: `${europeanMatch.groups.hour}:${europeanMatch.groups.minute}${europeanMatch.groups.second ? `:${europeanMatch.groups.second}` : ''}`,
      message: europeanMatch.groups.message.trim(),
      sortKey: Number.isNaN(sortValue) ? Number.MAX_SAFE_INTEGER - fallbackIndex : sortValue,
    };
  }

  return {
    dateLabel: tr('misc_other'),
    timeLabel: null,
    message: label,
    sortKey: Number.MAX_SAFE_INTEGER - fallbackIndex,
  };
}

function isVideoLikeUrl(value: string): boolean {
  if (/\.(jpg|jpeg|png|gif|bmp|webp|mjpg|mjpeg)(\?|$)/i.test(value)) {
    return false;
  }
  if (/(?:^|\/)(?:mjpg|mjpeg)\//i.test(value) || /image\.jpg(\?|$)/i.test(value)) {
    return false;
  }
  if (/\.(mp4|webm|ogg|m3u8|mpd)(\?|$)/i.test(value)) {
    return true;
  }
  return false;
}

function canUseRtcPreview(intercom: CurrentIntercom): boolean {
  return supportsBrowserRtc() && Boolean(intercom.deviceUuid && intercom.authToken && intercom.signalingUrl);
}

function resolveProxyMediaBase(intercom: CurrentIntercom): string | null {
  if (!intercom.origin || !intercom.deviceUuid) {
    return null;
  }
  return `${intercom.origin.replace(/\/$/, '')}/proxy/${encodeURIComponent(intercom.deviceUuid)}/`;
}

function resolveProxySnapshotUrl(intercom: CurrentIntercom): string | null {
  const proxyBase = resolveProxyMediaBase(intercom);
  return proxyBase ? new URL('jpg/image.jpg', proxyBase).toString() : null;
}

function resolveRenderableMediaUrl(sourceUrl: string, intercom: CurrentIntercom): string {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '';
    }
    const serverOrigin = intercom.origin ? new URL(intercom.origin).origin : null;
    const mediaBase = intercom.mediaBaseUrl ? new URL(intercom.mediaBaseUrl) : null;
    if (intercom.authToken && url.origin === serverOrigin) {
      url.username = '';
      url.password = '';
      url.searchParams.delete('auth');
      // An archive URL built by the signaling worker already carries the
      // per-session token needed to read the private photo.
      if (!url.searchParams.has('autht')) {
        url.searchParams.set('autht', intercom.authToken);
      }
    } else if (intercom.mediaAuthMode === 'basic' && mediaBase?.origin === url.origin) {
      url.username = mediaBase.username;
      url.password = mediaBase.password;
      url.searchParams.delete('auth');
      url.searchParams.delete('autht');
    } else {
      url.username = '';
      url.password = '';
    }
    url.searchParams.delete('cacheBuster');
    return url.toString();
  } catch {
    return '';
  }
}

function attachRtcStreamToDom(): void {
  const media = document.querySelector('#intercom-live-media');
  const stream = intercomRtcSession.getRemoteStream();
  if (!(media instanceof HTMLVideoElement) || !stream) {
    return;
  }
  const markFrameVisible = () => {
    if (intercomRtcSession.noteRenderedVideoFrame(stream)) {
      render();
    }
  };
  const isNewStream = media.srcObject !== stream;
  if (isNewStream) {
    media.srcObject = stream;
    media.addEventListener('loadedmetadata', () => {
      void ensureRtcVideoPlayback(media, true);
    }, { once: true });
    media.addEventListener('canplay', () => {
      void ensureRtcVideoPlayback(media, true);
    }, { once: true });
    media.addEventListener('loadeddata', markFrameVisible, { once: true });
    media.addEventListener('playing', markFrameVisible, { once: true });
    media.addEventListener('timeupdate', markFrameVisible, { once: true });
    if ('requestVideoFrameCallback' in media) {
      (media as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      }).requestVideoFrameCallback?.(() => {
        markFrameVisible();
      });
    }
  }
  const mute = browserConversationState !== 'active';
  const muteChanged = media.muted !== mute;
  media.muted = mute;
  if (isNewStream || muteChanged || (media.paused && rtcPlaybackRetryTimer === null)) {
    void ensureRtcVideoPlayback(media, isNewStream);
  }
}

async function ensureRtcVideoPlayback(media: HTMLVideoElement, forceRetry = false): Promise<void> {
  media.autoplay = true;
  media.playsInline = true;
  try {
    await media.play();
  } catch {
    // Some browsers need another kick after metadata/canplay or after a
    // render-driven element replacement.
  }

  if (rtcPlaybackRetryTimer !== null) {
    window.clearTimeout(rtcPlaybackRetryTimer);
    rtcPlaybackRetryTimer = null;
  }

  const needsRetry =
    forceRetry ||
    media.paused ||
    media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    media.currentTime === 0;

  if (!needsRetry) {
    return;
  }

  rtcPlaybackRetryTimer = window.setTimeout(() => {
    rtcPlaybackRetryTimer = null;
    const liveMedia = document.querySelector('#intercom-live-media');
    if (!(liveMedia instanceof HTMLVideoElement) || !liveMedia.srcObject) {
      return;
    }
    void liveMedia.play().catch(() => {
      // Keep the RTC preview best-effort; some kiosk browsers still require
      // a later retry once the frame pipeline is warm.
    });
  }, 750);
}
