/* eslint-env node */
const { contextBridge, ipcRenderer } = require('electron')

/** Renderer-side surface exposed to the React app. */
contextBridge.exposeInMainWorld('cumora', {
  isElectron: true,
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },

  /**
   * Native OS-level focus state of the MAIN window. Reliable substitute
   * for `document.hasFocus()`, which can mis-report on Electron/macOS.
   */
  app: {
    isFocused: () => ipcRenderer.invoke('app:is-focused'),
    onFocusChange: (handler) => {
      const wrapped = (_evt, focused) => handler(!!focused)
      ipcRenderer.on('app:focus-state', wrapped)
      return () => ipcRenderer.removeListener('app:focus-state', wrapped)
    },
  },

  window: {
    showMenu: (options) => ipcRenderer.invoke('window:show-menu', options),
  },

  /** OS clipboard write, independent of Chromium document focus. */
  clipboard: {
    writeText: (value) => ipcRenderer.invoke('clipboard:write-text', value),
  },

  /** Native Dock affordances. macOS-only in main; no-op elsewhere. */
  dock: {
    setUnreadDot: (visible) => ipcRenderer.send('dock:set-unread-dot', !!visible),
  },

  /**
   * Notification window plumbing. Two consumers:
   *  - the MAIN window's React app calls `notify.push(payload)` when a
   *    new message arrives AND the window is unfocused. The Electron
   *    main process forwards it to the dedicated notification
   *    BrowserWindow that lives top-right on the primary display.
   *  - the NOTIFICATION window's React app calls `notify.focusConvo(id)`
   *    when the user clicks a toast — main process focuses the main
   *    window and sends `focus-convo` so the React app selects the
   *    conversation.
   */
  notify: {
    push: (payload) => ipcRenderer.send('notification:push', payload),
    dismiss: (id) => ipcRenderer.send('notification:dismiss', id),
    focusConvo: (conversationId) => ipcRenderer.send('notification:focus-convo', conversationId),
    /** Notification renderer → main: I have mounted, flush queued pushes. */
    ready: () => ipcRenderer.send('notification:ready'),
    /** Notification renderer → main: first toast has painted, show me. */
    painted: () => ipcRenderer.send('notification:painted'),
    /** Notification renderer → main: resize panel to fit content height. */
    setHeight: (h) => ipcRenderer.send('notification:set-height', h),
    /** MAIN window subscribes — fires when notif panel is now on-screen. */
    onVisible: (handler) => {
      const wrapped = () => handler()
      ipcRenderer.on('notification:visible', wrapped)
      return () => ipcRenderer.removeListener('notification:visible', wrapped)
    },
    /** True → window accepts clicks (toast visible); False → destroy. */
    setInteractive: (interactive) => ipcRenderer.send('notification:set-interactive', !!interactive),
    /** Subscribed from the notification window — fires when main forwards a new toast. */
    onPush: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('notification:push', wrapped)
      return () => ipcRenderer.removeListener('notification:push', wrapped)
    },
    /** Subscribed from the MAIN window — fires when notification window asks to focus a conversation. */
    onFocusConvo: (handler) => {
      const wrapped = (_evt, conversationId) => handler(conversationId)
      ipcRenderer.on('notification:focus-convo', wrapped)
      return () => ipcRenderer.removeListener('notification:focus-convo', wrapped)
    },
  },

  /**
   * Local server bridge (personal build). The packaged app forks its own
   * bundled API server + in-process database; the renderer uses this to
   * read readiness, write the OpenAI key on first run, restart the server,
   * and reveal the on-disk data directory.
   */
  localServer: {
    status: () => ipcRenderer.invoke('local-server:status'),
    setOpenAIKey: (key) => ipcRenderer.invoke('local-server:set-openai-key', key),
    restart: () => ipcRenderer.invoke('local-server:restart'),
    /** 'safe' (flush every commit) or 'fast' (may lose the last commits on a crash). */
    setDurability: (mode) => ipcRenderer.invoke('local-server:set-durability', mode),
    setLlmConfig: (config) => ipcRenderer.invoke('local-server:set-llm-config', config),
    /** Ask where to save, then archive the data directory (server pauses). */
    backup: () => ipcRenderer.invoke('local-server:backup'),
    /** Pair this Mac: runs the daemon CLI with the code the app minted. */
    pairThisMac: (options) => ipcRenderer.invoke('local-server:pair-this-mac', options),
    /** Streaming output lines from that install. */
    onPairOutput: (handler) => {
      const wrapped = (_evt, line) => handler(String(line ?? ''))
      ipcRenderer.on('local-server:pair-output', wrapped)
      return () => ipcRenderer.removeListener('local-server:pair-output', wrapped)
    },
    openDataDir: () => ipcRenderer.invoke('local-server:open-data-dir'),
    onStatus: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('local-server:status', wrapped)
      return () => ipcRenderer.removeListener('local-server:status', wrapped)
    },
  },

  /**
   * Appearance preference. Mirrors the renderer's `system | light | dark`
   * so Chromium's `prefers-color-scheme` (and the traffic lights) stay
   * honest. Previously main forced `light` because the UI had no dark
   * palette.
   */
  theme: {
    set: (source) => ipcRenderer.send('theme:set', source),
  },
})
