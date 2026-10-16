import { useEffect, useRef, useState } from 'react'
import { useIsMobile } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { isWindowAttentive, subscribeWindowAttention } from '@/lib/windowAttention'
import { isWatchingConversation } from '@/lib/watching'
import { useAuth } from '@/stores/auth'
import { useMessages, bootMessagesStream } from '@/stores/messages'
import { bootParticipants, useParticipants } from '@/stores/participants'
import { bootConversations, isMuted, useConversations } from '@/stores/conversations'
import { bootWhispers, useWhispers } from '@/stores/whispers'
import { bootComputers, useComputers } from '@/stores/computers'
import { Onboarding } from '@/desktop/Onboarding'
import { usePrefs } from '@/stores/preferences'
import { api } from '@/api/client'
import { DesktopApp } from '@/desktop/DesktopApp'
import { MobileApp } from '@/mobile/MobileApp'
import { AuthGate } from '@/components/AuthGate'
import { NotificationToasts } from '@/components/NotificationToasts'
import { NotificationWindow } from '@/components/NotificationWindow'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { isNotificationWindow } from '@/lib/runtime'
import {
  InviteAcceptScreen, consumeInviteFromUrl,
  getPendingInvite, clearPendingInvite,
} from '@/components/InviteAcceptScreen'
import { NoWorkspaceScreen } from '@/components/NoWorkspaceScreen'
import { WorkspaceSessionBridge } from '@/components/WorkspaceSessionBridge'

function AuthedApp() {
  const isMobile = useIsMobile()
  const convoId = useApp((s) => s.selectedConversationId)
  const view = useApp((s) => s.view)
  // Free tier is BYOA-only: gate the app behind pairing a computer until one
  // exists. The gate clears automatically when a non-cloud computer comes
  // online (WS computers.status → store → re-render). Wait for the computers
  // list to load before deciding, to avoid a flash of onboarding.
  const activeTier = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.tier)
  const computersLoaded = useComputers((s) => s.loaded)
  const hasOwnComputer = useComputers((s) => Object.values(s.byId).some((c) => c.kind !== 'cloud'))
  const ownComputerCount = useComputers((s) => Object.values(s.byId).filter((c) => c.kind !== 'cloud').length)
  // Free tier is BYOA-only: gate the app into onboarding whenever a free
  // workspace has no paired (non-cloud) computer — pairing a machine is how a
  // free user activates their agents. We previously ALSO required
  // agentCount === 0, to avoid disrupting "grandfathered" free users who ran on
  // Cumora Cloud with no paired machine. That state has been eliminated (free
  // agents no longer run on managed cloud), so the guard is removed: any unpaired
  // free workspace — even one with existing (now-dormant) agents — is sent to
  // pair. `hasOwnComputer` checks existence not online status, so a
  // paired-but-asleep machine never re-triggers onboarding.
  const needsOnboarding = activeTier === 'free'
    && computersLoaded && !hasOwnComputer
  const hasDockUnread = useConversations((s) =>
    s.list.some((c) => !isMuted(c) && (c.unread ?? 0) > 0),
  )
  const selectedConvoExists = useConversations((s) =>
    convoId ? s.list.some((c) => c.id === convoId) : false,
  )
  // Dev shortcut to preview the onboarding screen on demand (⌘/Ctrl+Shift+O),
  // regardless of tier/computer state. Toggle again to exit. The preview also
  // auto-clears once a NEW computer pairs while you're previewing, so you can
  // test the real "pair → advance into the app" behavior. baselineRef captures
  // the own-computer count at the moment you toggle the preview on.
  const [forceOnboarding, setForceOnboarding] = useState(false)
  const baselineRef = useRef(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setForceOnboarding((v) => {
          if (!v) baselineRef.current = Object.values(useComputers.getState().byId).filter((c) => c.kind !== 'cloud').length
          return !v
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (forceOnboarding && ownComputerCount > baselineRef.current) {
      setForceOnboarding(false)
      useApp.getState().setView('agents')
    }
  }, [forceOnboarding, ownComputerCount])
  // When real onboarding completes (a computer connected → the gate flips
  // off), land the user on the Agents view to meet / add to their team.
  const wasOnboarding = useRef(needsOnboarding)
  useEffect(() => {
    if (wasOnboarding.current && !needsOnboarding) {
      // Onboarding just completed: the pair flow seeded the starter team +
      // "Everyone" group server-side (and only broadcasts the computer online
      // once that's done). Pull both lists in now so the Conversations/Agents
      // views are populated immediately, instead of waiting for WS events to
      // trickle in and leaving the user staring at an empty list.
      void useParticipants.getState().load()
      void useConversations.getState().reload()
      useApp.getState().setView('agents')
    }
    wasOnboarding.current = needsOnboarding
  }, [needsOnboarding])

  useEffect(() => {
    bootMessagesStream()
    bootParticipants()
    bootConversations()
    bootWhispers()
    bootComputers()
    void usePrefs.getState().load()
  }, [])

  useEffect(() => {
    window.cumora?.dock?.setUnreadDot(hasDockUnread)
  }, [hasDockUnread])

  useEffect(() => {
    return () => window.cumora?.dock?.setUnreadDot(false)
  }, [])

  // Attention is a live value: the window can go behind another app at any
  // moment, and the read decision has to follow it.
  const mobileStack = useApp((s) => s.mobileStack)
  const [attentive, setAttentive] = useState(() => isWindowAttentive())
  useEffect(() => subscribeWindowAttention(setAttentive), [])
  const watching = convoId != null && isWatchingConversation({
    conversationId: convoId,
    selectedConversationId: convoId,
    view,
    mobileStack,
    attentive,
  })

  // Lazy-load messages when a conversation is selected. Loading is not reading:
  // this still runs while the thread is off screen, so coming back is instant.
  useEffect(() => {
    if (!convoId || !selectedConvoExists) return
    void useMessages.getState().loadConversation(convoId)
  }, [convoId, selectedConvoExists])

  // Mark read exactly when the user starts watching — by any route: selecting
  // the conversation, returning to the conversations view, swiping back to the
  // chat screen, or bringing the window to the front. Keying this on `watching`
  // rather than on `convoId` is what keeps a badge earned off screen from
  // sticking once the user is actually looking at the messages.
  //
  // Clear the badge locally, then persist. The server response tells us nothing
  // the client doesn't already know, so refetching the whole list to learn that
  // one count went to zero is pure waste.
  useEffect(() => {
    if (!convoId || !selectedConvoExists || !watching) return
    useConversations.getState().markLocallyRead(convoId)
    void api.markRead(convoId).catch(() => { /* swallow */ })
  }, [convoId, selectedConvoExists, watching])

  // Lazy-refresh whisper list when entering whispers view
  useEffect(() => {
    if (view === 'whispers') useWhispers.getState().loadList()
  }, [view])

  return (
    <>
      {(needsOnboarding || forceOnboarding) ? <Onboarding /> : (isMobile ? <MobileApp /> : <DesktopApp />)}
      {/* In-app message toasts (window-blur / different-convo only) —
          rendered at the AuthedApp level so they share auth context and
          unmount cleanly on sign-out. */}
      <NotificationToasts />
    </>
  )
}

export function App() {
  // The Electron notification BrowserWindow loads this same React bundle
  // with a `#notifications` hash. Bypass everything else (auth, stores,
  // routing) and just render the toast stack — it receives payloads over
  // IPC from the main window.
  //
  // This lives in its own component rather than as an early return inside
  // `MainApp` so the bypass stays a *total* bypass: none of MainApp's hooks
  // or its three URL-consuming state initializers run in the notification
  // window, and neither shell can inherit the other's hook sequence.
  return isNotificationWindow ? <NotificationWindow /> : <MainApp />
}

function MainApp() {
  // Force AuthedApp to remount when the user logs in/out OR switches between
  // companies — every store keys off the active tenant, so a clean remount is
  // the simplest way to reload all data without stale rows leaking across.
  const userId = useAuth((s) => s.user?.id ?? null)
  const companyId = useAuth((s) => s.activeCompanyId)

  // Invite-link handling — runs BEFORE the rest of the shell so the
  // accept page is the user's first impression when they open a link. The
  // token can ride in via URL (fresh click) or localStorage (resumed
  // after an OAuth round-trip). The state is unset on done so the user
  // lands in the freshly-joined workspace. We do NOT support cumora://
  // deep links: invite URLs are always https://<web>/invite/<token>, so
  // the OS hands them to the default browser — Electron picks up the new
  // workspace on its next /auth/me refresh.
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    const fromUrl = consumeInviteFromUrl()
    if (fromUrl) {
      // Scrub the URL immediately so a refresh doesn't re-fire the same
      // flow; the token stays in component state.
      fromUrl.clear()
      return fromUrl.token
    }
    return getPendingInvite()
  })

  if (inviteToken) {
    const screen = (
      <InviteAcceptScreen
        token={inviteToken}
        onDone={() => { clearPendingInvite(); setInviteToken(null) }}
      />
    )
    return (
      <AuthGate unauthFallback={screen}>
        {screen}
      </AuthGate>
    )
  }

  return (
    <AuthGate>
      <ErrorBoundary>
        <WorkspaceSessionBridge />
        {userId && !companyId
          ? <NoWorkspaceScreen />
          : <AuthedApp key={`${userId ?? 'anon'}::${companyId ?? 'none'}`} />}
      </ErrorBoundary>
    </AuthGate>
  )
}
