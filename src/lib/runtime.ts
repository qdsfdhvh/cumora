/** Runtime detection — is this Cumora running inside Electron, mobile webview, or browser? */

export interface NotificationPushPayload {
  id: string
  /** Underlying message id — used by the notification renderer to
   *  dedupe identical pushes (e.g. if the WS bus delivers the same
   *  message.new twice during a flaky reconnect). The toast `id`
   *  carries a timestamp suffix so React keys stay unique across
   *  re-pushes, but `messageId` is the actual identity. */
  messageId: string
  conversationId: string
  authorId: string
  authorName: string
  authorAvatarUrl?: string | null
  /** Single uppercase letter used in the avatar fallback when no
   *  portrait URL is available — mirrors the convo-list avatar style. */
  authorInitial?: string
  /** CSS background (color or gradient) for the avatar fallback —
   *  pulled from `participant.avatarBg`. Each agent has a stable color
   *  so the fallback always reads as "Bram's avatar", not a blank disc. */
  authorAvatarBg?: string
  conversationTitle: string
  body: string
  at: number
  /** Conversation-level unread count snapshot at push time. Shown on
   *  the toast only when > 1 — single new messages don't get decorated
   *  with a redundant "1". */
  unreadCount?: number
}

interface CumoraBridge {
  isElectron: boolean
  platform: string
  versions: { chrome: string; electron: string; node: string }
  /** Main-window focus state, sourced from native OS events. */
  app?: {
    isFocused: () => Promise<boolean>
    onFocusChange: (handler: (focused: boolean) => void) => () => void
  }
  window?: {
    showMenu: (options: { menu: 'app' | 'edit'; locale: string; x: number; y: number }) => Promise<void>
  }
  /** Native clipboard write for desktop commands; works while the renderer is unfocused. */
  clipboard?: {
    writeText: (value: string) => Promise<void>
  }
  /** Native Dock affordances. Currently only meaningful on macOS. */
  dock?: {
    setUnreadDot: (visible: boolean) => void
  }
  notify?: {
    /** Main → notification window: show this toast. */
    push: (p: NotificationPushPayload) => void
    /** Main / notification → notification window: remove a toast id. */
    dismiss: (id: string) => void
    /** Notification → main: bring main window forward + select convo. */
    focusConvo: (conversationId: string) => void
    /** Notification → main: renderer is mounted; flush queued pushes. */
    ready: () => void
    /** Notification → main: first toast painted, OK to show the window. */
    painted: () => void
    /** Notification → main: resize the panel to fit content height. */
    setHeight: (h: number) => void
    /** Main window subscribes — fires when the notif panel becomes
     *  visible. Lets the always-loaded main window play the chime in
     *  sync with the on-screen appearance instead of pre-loading audio
     *  in the just-spawned notification renderer. */
    onVisible: (handler: () => void) => () => void
    /** Notification → main: toggle click-through. True while a toast is on
     *  screen so it can be clicked; false destroys the window so nothing
     *  sits invisibly on top of the desktop. */
    setInteractive: (interactive: boolean) => void
    /** Notification window subscribes — fires on each push from main. */
    onPush: (handler: (p: NotificationPushPayload) => void) => () => void
    /** Main window subscribes — fires when notif window asks to focus a convo. */
    onFocusConvo: (handler: (conversationId: string) => void) => () => void
  }
  /** Appearance preference → Electron `nativeTheme.themeSource` so
   *  `prefers-color-scheme` in the renderer matches the user's pick. */
  theme?: {
    set: (source: 'system' | 'light' | 'dark') => void
  }
  /**
   * Local server bridge (personal build). The packaged app forks its own
   * bundled API server + in-process Postgres; the renderer reads readiness
   * from here, writes the OpenAI key on first run, and can restart the
   * server or reveal its data directory.
   */
  localServer?: {
    status: () => Promise<LocalServerStatus>
    setOpenAIKey: (key: string) => Promise<LocalServerStatus>
    restart: () => Promise<LocalServerStatus>
    /** Switch write durability and restart the server. */
    setDurability: (mode: 'safe' | 'fast') => Promise<LocalServerStatus>
    /** Point the server's own LLM calls at another OpenAI-compatible endpoint. */
    setLlmConfig: (config: LocalLlmConfig) => Promise<LocalServerStatus | LocalServerError>
    /** Automatic backup cadence + retention (off by default). */
    setBackupConfig: (config: LocalBackupConfig) => Promise<LocalServerStatus>
    /** Ask where to save, then archive the data directory. */
    backup: () => Promise<{ cancelled?: boolean; ok?: boolean; path?: string; bytes?: number; error?: string }>
    /** Run the daemon CLI against the local server with a freshly minted code
     *  (no terminal, no copy-paste). `installService` also registers it to
     *  start at login. */
    pairThisMac: (options: {
      code: string
      engine?: string | null
      installService?: boolean
      allowUnsandboxed?: boolean
    }) => Promise<{ ok: boolean; log?: string; error?: string; hint?: string; exitCode?: number; command?: string }>
    /** Output lines from that install, streamed while it runs. */
    onPairOutput: (handler: (line: string) => void) => () => void
    openDataDir: () => Promise<boolean>
    onStatus: (handler: (status: LocalServerStatus) => void) => () => void
  }
}

/** Snapshot of the embedded server + database the desktop app runs.
 *  `state` is 'stopped' before boot, 'starting' while the database opens and
 *  migrations run, 'ready' once /api/health answers, 'error' on failure. */
/** What the 模型服务 panel sends down. `apiKey` is optional: leaving it empty
 *  keeps whatever is stored. */
export interface LocalLlmConfig {
  baseUrl: string
  model: string
  modelSupport: string
  apiKey?: string
}

/** `setLlmConfig` reports validation failures as data (with the status). */
export interface LocalServerError {
  error: string
}

export type LocalBackupCadence = 'off' | 'daily' | 'weekly'

/** Automatic backups are off unless the owner turns them on: they write files
 *  on a schedule, which is not something to enable on someone's behalf. */
export interface LocalBackupConfig {
  auto: LocalBackupCadence
  keep: number
}

export interface LocalServerStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error'
  detail: string
  port: number
  /** False until the user enters an OpenAI key on first run. */
  hasApiKey: boolean
  /** True while a backup is in flight (the server pauses for a few seconds). */
  backingUp?: boolean
  /** Write durability: 'safe' (default) or 'fast'. */
  durability?: 'safe' | 'fast'
  /** Automatic backups written by the app into <data>/backups. */
  backups?: {
    auto: LocalBackupCadence
    keep: number
    lastAt: string | null
    lastPath: string | null
    lastBytes: number
    lastError: string | null
  }
  /** Model service the server's own LLM calls use (empty ⇒ OpenAI defaults). */
  llm?: {
    baseUrl: string
    model: string
    modelSupport: string
    /** True when a key is available — the custom one, else the OpenAI one. */
    hasKey: boolean
  }
  /** On-disk directory holding the database, uploads, and server.env. */
  dataDir: string
  isDev: boolean
  /** Recent server log lines, oldest first. */
  log: string[]
}

declare global {
  interface Window {
    cumora?: CumoraBridge
  }
}

export const isElectron: boolean = typeof window !== 'undefined' && window.cumora?.isElectron === true

/** True when this renderer is the public web client (e.g. app.cumora.ai).
 *  Cumora is a desktop-only product on the web side — when this is true
 *  we skip the full chat shell and only surface sign-in, waitlist, and a
 *  desktop hand-off. The `?webonly=1` escape exists so localhost dev can
 *  preview the trimmed shell without /etc/hosts trickery. */
export const isWebAppHost: boolean = false

export const platform: string = (typeof window !== 'undefined' && window.cumora?.platform) || (typeof navigator !== 'undefined' ? navigator.platform.toLowerCase() : 'web')

export const isMac = platform === 'darwin' || platform.includes('mac')
// NB: use startsWith, not includes — `'darwin'.includes('win')` is true.
export const isWindows = platform === 'win32' || platform.startsWith('win')

/** macOS native traffic-light width when titleBarStyle is 'hidden' — leave room for them */
export const trafficLightInset = isElectron && isMac ? 84 : 0

/** True when this renderer is the dedicated notification window
 *  (loaded with the `#notifications` hash). The App component branches
 *  on this to render only the toast stack. */
export const isNotificationWindow: boolean =
  typeof window !== 'undefined' && window.location.hash === '#notifications'

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}
declare global {
  interface Window {
    Capacitor?: CapacitorGlobal
  }
}

/** True when running inside a Capacitor-wrapped native shell (iOS / Android).
 *  Electron is a separate path — `isElectron` above. The Capacitor bridge
 *  injects `window.Capacitor` at first paint; the browser build doesn't
 *  ship it. */
export const isCapacitor: boolean =
  typeof window !== 'undefined' && typeof window.Capacitor?.isNativePlatform === 'function'
    ? window.Capacitor.isNativePlatform()
    : false

export const isCapacitorIOS: boolean = isCapacitor && window.Capacitor?.getPlatform?.() === 'ios'

export const isCapacitorAndroid: boolean = isCapacitor && window.Capacitor?.getPlatform?.() === 'android'

/** True inside either native shell (iOS or Android) — both run real push
 *  via @capacitor/push-notifications (APNs on iOS, FCM on Android). */
export const isCapacitorNative: boolean = isCapacitorIOS || isCapacitorAndroid
