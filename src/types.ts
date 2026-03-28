export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'error';
export type AppLanguage = 'pl' | 'en' | 'de';

export interface StoredCredentials {
  origin: string;
  serial: string | null;
  resolvedOrigin: string | null;
  username: string;
  password: string;
  intercomUsername: string;
  intercomPassword: string;
  token: string | null;
  tokenValidUntil: string | null;
}

export interface QuickTtsPhrase {
  id: string;
  label: string;
  message: string;
}

export interface IntercomViewConfig {
  id: string;
  type: 'intercom';
  title: string;
  intercomUuidAction: string | null;
  activityLogControlUuidAction: string | null;
  historyLimit: number;
  quickTts: QuickTtsPhrase[];
}

export interface AppConfig {
  credentials: StoredCredentials | null;
  languageOverride: AppLanguage | null;
  defaultViewId: string | null;
  lastViewId: string | null;
  views: IntercomViewConfig[];
}

export type LoxoneStateValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface LoxoneControl {
  uuid: string;
  uuidAction: string;
  name: string;
  type: string;
  roomName: string | null;
  categoryName: string | null;
  states: Record<string, string>;
  details: Record<string, unknown>;
  parentUuidAction: string | null;
  path: string[];
}

export interface LoxoneStructure {
  miniserverName: string;
  serverModel: string;
  serial: string;
  loxappVersion: string;
  controls: LoxoneControl[];
  controlsByAction: Record<string, LoxoneControl>;
  stateOwnerByUuid: Record<
    string,
    {
      controlUuidAction: string;
      stateName: string;
    }
  >;
}

export interface CachedRuntime {
  structure: LoxoneStructure | null;
  stateValues: Record<string, LoxoneStateValue>;
  intercomHistoryByUuidAction: Record<string, string[]>;
  intercomPreviewByUuidAction: Record<string, string>;
  updatedAt: string | null;
}

export interface PersistedState {
  config: AppConfig;
  cache: CachedRuntime;
}

export interface FormState {
  origin: string;
  serial: string | null;
  username: string;
  passwordStored: boolean;
}

export interface AppNotice {
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface IntercomSummary {
  uuidAction: string;
  name: string;
  roomName: string | null;
}

export interface IntercomFunction {
  uuidAction: string;
  name: string;
}

export interface IntercomHistoryItem {
  timestamp: string;
  label: string;
  imageUrl: string;
}

export interface ActivityLogSourceSummary {
  uuidAction: string;
  name: string;
  type: string;
  roomName: string | null;
}

export interface ActivityLogItem {
  id: string;
  label: string;
}

export type IntercomTransportMode = 'secure-proxy' | 'lan-direct' | 'none';
export type IntercomMediaAuthMode = 'token' | 'basic' | 'none';

export interface IntercomViewModel {
  uuidAction: string;
  name: string;
  roomName: string | null;
  deviceUuid: string | null;
  address: string | null;
  origin: string | null;
  authToken: string | null;
  transportMode: IntercomTransportMode;
  mediaAuthMode: IntercomMediaAuthMode;
  signalingUrl: string | null;
  mediaBaseUrl: string | null;
  historyBaseUrl: string | null;
  mediaRootPath: string | null;
  doorbellActive: boolean;
  microphoneMuted: boolean;
  supportsAnswer: boolean;
  supportsMute: boolean;
  snapshotUrl: string | null;
  streamUrl: string | null;
  cachedPreviewUrl: string | null;
  history: IntercomHistoryItem[];
  functions: IntercomFunction[];
  activityLogSourceName: string | null;
  activityLogWarning: string | null;
  activityLog: ActivityLogItem[];
}

export interface AppViewModel {
  screen: 'loading' | 'picker' | 'dashboard';
  settingsOpen: boolean;
  settingsMode: 'app' | 'view' | null;
  language: AppLanguage;
  languageOverride: AppLanguage | null;
  connection: {
    status: ConnectionStatus;
  };
  notice: AppNotice | null;
  serverForm: FormState;
  miniserverName: string | null;
  lastSyncedAt: string | null;
  views: IntercomViewConfig[];
  intercoms: IntercomSummary[];
  logSources: ActivityLogSourceSummary[];
  activeViewId: string | null;
  settingsEditorViewId: string | null;
  currentEditorView: IntercomViewConfig | null;
  currentView: {
    config: IntercomViewConfig;
    intercom: IntercomViewModel | null;
  } | null;
}

export interface SaveServerPayload {
  origin: string;
  serial: string;
  username: string;
  password: string;
}

export interface SaveAppSettingsPayload {
  languageOverride: AppLanguage | null;
}

export type MainToWorkerMessage =
  | { type: 'bootstrap'; browserLanguage?: string }
  | { type: 'showAppSettings' }
  | { type: 'showViewSettings'; viewId?: string }
  | { type: 'closeSettings' }
  | { type: 'saveAppSettings'; payload: SaveAppSettingsPayload }
  | { type: 'saveServer'; payload: SaveServerPayload }
  | { type: 'selectView'; viewId: string }
  | { type: 'addIntercomView' }
  | { type: 'configureIntercomView' }
  | { type: 'editView'; viewId: string }
  | { type: 'saveView'; payload: IntercomViewConfig }
  | { type: 'deleteView'; viewId: string }
  | { type: 'setDefaultView'; viewId: string }
  | { type: 'sendChildFunction'; viewId: string; functionUuidAction: string }
  | { type: 'sendTts'; viewId: string; message: string }
  | { type: 'runBuiltInAction'; viewId: string; action: 'connect' | 'answer' | 'mute' | 'unmute' }
  | { type: 'cacheIntercomPreview'; uuidAction: string; url: string | null }
  | { type: 'dismissNotice' };

export type WorkerToMainMessage = { type: 'state'; state: AppViewModel };
