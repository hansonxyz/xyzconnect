<script lang="ts">
  import { onMount } from 'svelte'
  import { initConnectionStore, effectiveState } from './stores/connection.svelte'
  import { initDeviceStore, refreshDevices } from './stores/devices.svelte'
  import { initContactsStore, refreshContacts } from './stores/contacts.svelte'
  import {
    initConversationsStore,
    refreshConversations,
    conversations,
    selectConversation,
    startCompose,
    exitCompose,
    setSearchQuery,
  } from './stores/conversations.svelte'
  import { initMessagesStore, messages, loadThread } from './stores/messages.svelte'
  import { lightbox, closeLightbox } from './stores/lightbox.svelte'
  import { initSendQueueStore } from './stores/send-queue.svelte'
  import { settings, initSettingsStore } from './stores/settings.svelte'
  import { t } from './stores/i18n.svelte'
  import StatusIndicator from './components/StatusIndicator.svelte'
  import ConversationList from './components/ConversationList.svelte'
  import MessageThread from './components/MessageThread.svelte'
  import NewConversation from './components/NewConversation.svelte'
  import FindMyPhone from './components/FindMyPhone.svelte'
  import SettingsPanel from './components/SettingsPanel.svelte'
  import ResizeHandle from './components/ResizeHandle.svelte'
  import UpdateBanner from './components/UpdateBanner.svelte'
  import Lightbox from './components/Lightbox.svelte'
  import AboutDialog from './components/AboutDialog.svelte'
  import PairingPage from './pages/PairingPage.svelte'

  const CONVERSATION_STATES: Set<EffectiveState> = new Set([
    'connected',
    'syncing',
    'ready',
  ])

  // Once we've been in a messaging state, stay on conversation view
  // even during brief disconnections (phone reconnects every ~5s)
  let hasBeenConnected = $state(false)

  $effect(() => {
    if (CONVERSATION_STATES.has(effectiveState.current)) {
      hasBeenConnected = true
    }
  })

  // Auto-sync on reconnect after a meaningful disconnect (>30s).
  // Brief disconnect/reconnect cycles (~25s) happen normally and don't need a sync.
  // Only when the phone has been gone long enough for the UI to show "disconnected"
  // do we re-sync to pick up messages received while offline.
  const RECONNECT_SYNC_THRESHOLD = 30_000
  let needsSyncOnReconnect = $state(false)
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    const state = effectiveState.current
    if (CONVERSATION_STATES.has(state)) {
      if (disconnectTimer !== undefined) {
        clearTimeout(disconnectTimer)
        disconnectTimer = undefined
      }
      if (needsSyncOnReconnect) {
        needsSyncOnReconnect = false
        triggerSync()
      }
    } else if (hasBeenConnected && disconnectTimer === undefined) {
      disconnectTimer = setTimeout(() => {
        disconnectTimer = undefined
        needsSyncOnReconnect = true
      }, RECONNECT_SYNC_THRESHOLD)
    }
  })

  function triggerSync(): void {
    void window.api.invoke('sms.request_sync').catch(() => {})
  }

  const showConversations = $derived(
    CONVERSATION_STATES.has(effectiveState.current) || hasBeenConnected,
  )
  const showPairing = $derived(!showConversations)

  let showSettings = $state(false)
  let showFindPhone = $state(false)
  let showAbout = $state(false)

  // Close overlays when user selects a conversation
  $effect(() => {
    if (conversations.selectedThreadId !== null) {
      showSettings = false
      showFindPhone = false
    }
  })

  function handleUnpaired(): void {
    showSettings = false
    showFindPhone = false
    hasBeenConnected = false
    selectConversation(null)
    loadThread(null)
    conversations.raw.length = 0
  }

  const MIN_SIDEBAR = 200
  const MAX_SIDEBAR = 480

  function handleResize(deltaX: number): void {
    settings.sidebarWidth = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, settings.sidebarWidth + deltaX))
  }

  // Sync persisted showSpam setting into conversations store
  conversations.showSpam = settings.showSpam
  $effect(() => {
    settings.showSpam = conversations.showSpam
  })

  onMount(() => {
    initSettingsStore()
    const cleanupConnection = initConnectionStore()
    const cleanupDevices = initDeviceStore()
    const cleanupContacts = initContactsStore()
    const cleanupConversations = initConversationsStore()
    const cleanupMessages = initMessagesStore()
    const cleanupSendQueue = initSendQueueStore()

    // Auto-check for updates on startup if enabled
    if (settings.autoCheckUpdates) {
      setTimeout(() => {
        void window.api.checkForUpdates().catch(() => {})
      }, 5000)
    }

    return () => {
      cleanupConnection()
      cleanupDevices()
      cleanupContacts()
      cleanupConversations()
      cleanupMessages()
      cleanupSendQueue()
      clearTimeout(disconnectTimer)
    }
  })

  // Global keyboard shortcuts
  function handleKeydown(e: KeyboardEvent): void {
    // Don't intercept when typing in an input/textarea
    const tag = (e.target as HTMLElement).tagName
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA'

    if (e.key === 'Escape') {
      if (lightbox.current) { closeLightbox(); return }
      if (showAbout) { showAbout = false; return }
      if (showSettings) { showSettings = false; return }
      if (showFindPhone) { showFindPhone = false; return }
      if (conversations.composingNew) { exitCompose(); return }
      if (conversations.selectedThreadId !== null) {
        selectConversation(null)
        loadThread(null)
        return
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault()
      startCompose()
      return
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      // Focus the search input in the sidebar
      const searchInput = document.querySelector('.search-bar__input') as HTMLInputElement | null
      if (searchInput) searchInput.focus()
      return
    }
  }

  // Refresh device lists when entering discovery-related states
  $effect(() => {
    const state = effectiveState.current
    if (state === 'disconnected' || state === 'discovering') {
      refreshDevices()
    }
  })

  // Fetch conversations + contacts when entering messaging states
  $effect(() => {
    const state = effectiveState.current
    if (state === 'connected' || state === 'syncing' || state === 'ready') {
      void refreshContacts()
      void refreshConversations()
    }
  })
</script>

<svelte:window onkeydown={handleKeydown} />
<div class="layout">
  <aside class="sidebar" style:width="{settings.sidebarWidth}px">
    <div class="sidebar__header">
      <div class="sidebar__title-row">
        <button class="sidebar__title" onclick={() => (showAbout = true)} title={t('app.about')}>{t('app.title')}</button>
        <div class="sidebar__actions">
          <button
            class="sidebar__icon-btn"
            class:sidebar__icon-btn--active={conversations.composingNew}
            onclick={() => startCompose()}
            title={t('app.newMessage')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                fill="currentColor"
                d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 000-1.42l-2.34-2.34a1.003 1.003 0 00-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
              />
            </svg>
          </button>
          <button
            class="sidebar__icon-btn"
            class:sidebar__icon-btn--active={showFindPhone}
            onclick={() => { showFindPhone = !showFindPhone; if (showFindPhone) { showSettings = false; exitCompose() } }}
            title={t('app.findPhone')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                fill="currentColor"
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
              />
            </svg>
          </button>
          <button
            class="sidebar__icon-btn"
            onclick={() => triggerSync()}
            title={t('app.syncMessages')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                fill="currentColor"
                d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
              />
            </svg>
          </button>
          <button
            class="sidebar__icon-btn"
            class:sidebar__icon-btn--active={showSettings}
            onclick={() => { showSettings = !showSettings; if (showSettings) { showFindPhone = false; exitCompose() } }}
            title={t('app.settings')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"
              />
            </svg>
          </button>
        </div>
      </div>
      <StatusIndicator />
    </div>
    <div class="sidebar__content">
      {#if showConversations}
        <ConversationList />
      {:else if showPairing}
        <p class="sidebar__placeholder">{t('app.sidebarPlaceholder')}</p>
      {:else}
        <p class="sidebar__placeholder">{t('app.sidebarPlaceholderAlt')}</p>
      {/if}
    </div>
  </aside>
  <ResizeHandle onResize={handleResize} />
  <main class="main-panel">
    <UpdateBanner />
    {#if showSettings}
      <SettingsPanel onClose={() => (showSettings = false)} onUnpaired={handleUnpaired} onAbout={() => (showAbout = true)} />
    {:else if showFindPhone}
      <FindMyPhone onClose={() => (showFindPhone = false)} />
    {:else if showPairing}
      <PairingPage />
    {:else if conversations.composingNew}
      <NewConversation />
    {:else if conversations.selectedThreadId !== null}
      <MessageThread />
    {:else}
      <div class="main-panel__empty">
        <p class="main-panel__empty-text">{t('app.emptyState')}</p>
      </div>
    {/if}
  </main>
  <Lightbox />
  {#if showAbout}
    <AboutDialog onClose={() => (showAbout = false)} />
  {/if}
</div>

<style>
  .layout {
    display: flex;
    width: 100%;
    height: 100%;
  }

  .sidebar {
    min-width: 200px;
    max-width: 480px;
    background-color: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }

  .sidebar__header {
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .sidebar__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }

  .sidebar__title {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    background: none;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    padding: 0;
    font-family: inherit;
    transition: color 0.15s;
  }

  .sidebar__title:hover {
    color: var(--accent-primary);
  }

  .sidebar__actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .sidebar__icon-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    transition: color 0.15s, background-color 0.15s;
  }

  .sidebar__icon-btn:hover {
    color: var(--text-secondary);
    background-color: var(--bg-hover);
  }

  .sidebar__icon-btn--active {
    color: var(--accent-primary);
  }


  .sidebar__content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .sidebar__placeholder {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    padding: var(--space-4);
    text-align: center;
    margin: auto;
  }

  .main-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background-color: var(--bg-primary);
  }

  .main-panel__empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .main-panel__empty-text {
    color: var(--text-muted);
    font-size: var(--font-size-lg);
  }
</style>
