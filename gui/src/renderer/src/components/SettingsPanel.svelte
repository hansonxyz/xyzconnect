<script lang="ts">
  import { onMount } from 'svelte'
  import { connection } from '../stores/connection.svelte'
  import { devices, unpairDevice } from '../stores/devices.svelte'
  import { settings } from '../stores/settings.svelte'
  import { t } from '../stores/i18n.svelte'
  import { locales, localeOrder } from '../lib/locales'

  interface Props {
    onClose: () => void
    onUnpaired: () => void
    onAbout: () => void
  }

  const { onClose, onUnpaired, onAbout }: Props = $props()

  let confirmingUnpair = $state(false)
  let unpairing = $state(false)

  // Update section state
  let appVersion = $state('...')
  let updateStatus = $state<UpdateStatus>({ state: 'idle' })

  onMount(() => {
    void window.api.getAppVersion().then((v) => { appVersion = v })
    void window.api.getUpdateStatus().then((s) => { updateStatus = s })

    const handleStatus = (status: UpdateStatus): void => {
      updateStatus = status
    }

    window.api.onUpdateStatus(handleStatus)
    return () => window.api.offUpdateStatus(handleStatus)
  })

  async function checkForUpdates(): Promise<void> {
    try {
      await window.api.checkForUpdates()
    } catch {
      // Error will come through the status event
    }
  }

  function openReleasePage(): void {
    if (updateStatus.state === 'available') {
      window.api.openExternal(`https://github.com/hansonxyz/xyzconnect/releases/tag/v${updateStatus.version}`)
    }
  }

  function installUpdate(): void {
    void window.api.installUpdate()
  }

  function updateStatusText(status: UpdateStatus): string {
    switch (status.state) {
      case 'idle': return ''
      case 'checking': return t('updates.checking')
      case 'available': return t('updates.available', { version: status.version })
      case 'not-available': return t('updates.upToDate')
      case 'downloading': return t('updates.downloading', { percent: String(status.percent) })
      case 'downloaded': return t('updates.ready', { version: status.version })
      case 'error': return t('updates.error', { message: status.message })
    }
  }

  // Cache device info — phone cycles on/off network every ~5s,
  // so we latch the best-known info and never clear it
  let cachedName = $state<string | null>(null)
  let cachedAddress = $state<string | null>(null)
  let cachedType = $state<string | null>(null)
  let hasEverConnected = $state(false)

  const hasPairedDevice = $derived(devices.pairedIds.length > 0)

  // Update cache whenever device info becomes available
  $effect(() => {
    const disc = devices.discovered.find((d) => devices.pairedIds.includes(d.deviceId))
    if (disc) {
      cachedName = disc.deviceName
      cachedAddress = disc.address
      cachedType = disc.deviceType
      hasEverConnected = true
    }
    // Also grab name from stateContext if discovered list is empty
    const ctxName = connection.stateContext?.deviceName
    if (ctxName && !cachedName) {
      cachedName = ctxName
      hasEverConnected = true
    }
  })

  const stateLabel = $derived(
    hasEverConnected ? t('settings.statusConnected') : hasPairedDevice ? t('settings.statusReconnecting') : t('settings.statusDisconnected'),
  )

  async function handleUnpair(): Promise<void> {
    const deviceId = devices.pairedIds[0]
    if (!deviceId) return
    unpairing = true
    await unpairDevice(deviceId)
    unpairing = false
    confirmingUnpair = false
    onUnpaired()
  }
</script>

<div class="settings-panel">
  <div class="settings-panel__header">
    <h2 class="settings-panel__title">{t('settings.title')}</h2>
    <button class="settings-panel__close" onclick={onClose} title={t('settings.close')}>
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          fill="currentColor"
          d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
        />
      </svg>
    </button>
  </div>

  <div class="settings-panel__content">
    <div class="settings-panel__section">
      <h3 class="settings-panel__section-title">{t('settings.connection')}</h3>

      <div class="settings-panel__row">
        <span class="settings-panel__label">{t('settings.status')}</span>
        <span class="settings-panel__value">{stateLabel}</span>
      </div>

      {#if cachedName}
        <div class="settings-panel__row">
          <span class="settings-panel__label">{t('settings.device')}</span>
          <span class="settings-panel__value">{cachedName}</span>
        </div>
        {#if cachedAddress}
          <div class="settings-panel__row">
            <span class="settings-panel__label">{t('settings.ipAddress')}</span>
            <span class="settings-panel__value settings-panel__value--mono">{cachedAddress}</span>
          </div>
        {/if}
        {#if cachedType}
          <div class="settings-panel__row">
            <span class="settings-panel__label">{t('settings.type')}</span>
            <span class="settings-panel__value">{cachedType}</span>
          </div>
        {/if}
      {:else if hasPairedDevice}
        <div class="settings-panel__row">
          <span class="settings-panel__label">{t('settings.device')}</span>
          <span class="settings-panel__value settings-panel__value--muted">{t('settings.waitingDevice')}</span>
        </div>
      {/if}
    </div>

    <div class="settings-panel__section">
      <h3 class="settings-panel__section-title">{t('settings.notifications')}</h3>
      <div class="settings-panel__row">
        <span class="settings-panel__label">{t('settings.desktopNotifications')}</span>
        <label class="settings-panel__toggle">
          <input
            type="checkbox"
            bind:checked={settings.notificationsEnabled}
          />
          <span class="settings-panel__toggle-track"></span>
        </label>
      </div>
      <div class="settings-panel__row">
        <span class="settings-panel__label">{t('settings.flashTaskbar')} <span class="settings-panel__hint">{t('settings.flashTaskbarHint')}</span></span>
        <label class="settings-panel__toggle">
          <input
            type="checkbox"
            bind:checked={settings.flashTaskbar}
          />
          <span class="settings-panel__toggle-track"></span>
        </label>
      </div>
    </div>

    <div class="settings-panel__section">
      <h3 class="settings-panel__section-title">{t('settings.language')}</h3>
      <div class="settings-panel__row">
        <select
          class="settings-panel__select"
          bind:value={settings.locale}
        >
          <option value="auto">{t('settings.languageAuto')}</option>
          {#each localeOrder as code}
            <option value={code}>{locales[code].name}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="settings-panel__section">
      <h3 class="settings-panel__section-title">{t('updates.title')}</h3>

      <div class="settings-panel__row">
        <span class="settings-panel__label">{t('updates.version')}</span>
        <span class="settings-panel__value settings-panel__value--mono">{appVersion}</span>
      </div>

      <div class="settings-panel__row">
        <span class="settings-panel__label">{t('updates.checkAuto')}</span>
        <label class="settings-panel__toggle">
          <input type="checkbox" bind:checked={settings.autoCheckUpdates} />
          <span class="settings-panel__toggle-track"></span>
        </label>
      </div>

      <div class="settings-panel__update-actions">
        {#if updateStatus.state === 'available'}
          <button
            class="settings-panel__btn settings-panel__btn--primary"
            onclick={openReleasePage}
          >
            {t('updates.viewOnGithub')}
          </button>
        {:else if updateStatus.state === 'downloaded'}
          <button
            class="settings-panel__btn settings-panel__btn--primary"
            onclick={installUpdate}
          >
            {t('updates.restartBtn')}
          </button>
        {:else}
          <button
            class="settings-panel__btn settings-panel__btn--outline"
            onclick={() => void checkForUpdates()}
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
          >
            {updateStatus.state === 'checking' ? t('updates.checkingBtn') : t('updates.checkBtn')}
          </button>
        {/if}
      </div>

      {#if updateStatusText(updateStatus)}
        <p
          class="settings-panel__status-text"
          class:settings-panel__status-text--error={updateStatus.state === 'error'}
          class:settings-panel__status-text--success={updateStatus.state === 'not-available'}
        >
          {updateStatusText(updateStatus)}
        </p>
      {/if}

      {#if updateStatus.state === 'downloading'}
        <div class="settings-panel__progress-bar">
          <div class="settings-panel__progress-fill" style:width="{updateStatus.percent}%"></div>
        </div>
      {/if}
    </div>

    {#if devices.pairedIds.length > 0}
      <div class="settings-panel__section">
        <h3 class="settings-panel__section-title">{t('settings.deviceSection')}</h3>

        {#if confirmingUnpair}
          <div class="settings-panel__confirm">
            <p class="settings-panel__confirm-text">
              {t('settings.unpairConfirm', { device: cachedName ?? 'this device' })}
            </p>
            <div class="settings-panel__confirm-actions">
              <button
                class="settings-panel__btn settings-panel__btn--danger"
                onclick={() => void handleUnpair()}
                disabled={unpairing}
              >
                {unpairing ? t('settings.unpairing') : t('settings.unpairBtn')}
              </button>
              <button
                class="settings-panel__btn settings-panel__btn--cancel"
                onclick={() => (confirmingUnpair = false)}
                disabled={unpairing}
              >
                {t('settings.cancelBtn')}
              </button>
            </div>
          </div>
        {:else}
          <button
            class="settings-panel__btn settings-panel__btn--outline-danger"
            onclick={() => (confirmingUnpair = true)}
          >
            {t('settings.unpairDevice')}
          </button>
        {/if}
      </div>
    {/if}

    <div class="settings-panel__section">
      <button
        class="settings-panel__btn settings-panel__btn--outline"
        onclick={onAbout}
      >
        {t('settings.aboutBtn')}
      </button>
    </div>
  </div>
</div>

<style>
  .settings-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .settings-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    background-color: var(--bg-secondary);
  }

  .settings-panel__title {
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .settings-panel__close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: var(--space-1);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
  }

  .settings-panel__close:hover {
    color: var(--text-secondary);
    background-color: var(--bg-hover);
  }

  .settings-panel__content {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-6);
  }

  .settings-panel__section {
    margin-bottom: var(--space-8);
  }

  .settings-panel__section-title {
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: var(--space-4);
  }

  .settings-panel__row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .settings-panel__label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .settings-panel__hint {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .settings-panel__select {
    width: 100%;
    background-color: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-family);
    font-size: var(--font-size-sm);
    outline: none;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .settings-panel__select:focus {
    border-color: var(--accent-primary);
  }

  .settings-panel__select option {
    background-color: var(--bg-secondary);
    color: var(--text-primary);
  }

  .settings-panel__value {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }

  .settings-panel__value--mono {
    font-family: monospace;
  }

  .settings-panel__value--muted {
    color: var(--text-muted);
    font-style: italic;
  }

  .settings-panel__confirm {
    background-color: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .settings-panel__confirm-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: var(--space-3);
    line-height: 1.4;
  }

  .settings-panel__confirm-actions {
    display: flex;
    gap: var(--space-2);
  }

  .settings-panel__btn {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .settings-panel__btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .settings-panel__btn--danger {
    background-color: var(--danger);
    color: #fff;
  }

  .settings-panel__btn--danger:hover:not(:disabled) {
    background-color: #d32f2f;
  }

  .settings-panel__btn--cancel {
    background-color: var(--bg-surface);
    color: var(--text-secondary);
  }

  .settings-panel__btn--cancel:hover:not(:disabled) {
    background-color: var(--bg-hover);
  }

  .settings-panel__btn--outline-danger {
    background: none;
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .settings-panel__btn--outline-danger:hover {
    background-color: var(--danger);
    color: #fff;
  }

  .settings-panel__toggle {
    position: relative;
    display: inline-block;
    cursor: pointer;
  }

  .settings-panel__toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .settings-panel__toggle-track {
    display: block;
    width: 40px;
    height: 22px;
    background-color: var(--bg-surface);
    border-radius: 11px;
    transition: background-color 0.2s;
    position: relative;
  }

  .settings-panel__toggle-track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    background-color: var(--text-muted);
    border-radius: var(--radius-full);
    transition: transform 0.2s, background-color 0.2s;
  }

  .settings-panel__toggle input:checked + .settings-panel__toggle-track {
    background-color: var(--accent-primary);
  }

  .settings-panel__toggle input:checked + .settings-panel__toggle-track::after {
    transform: translateX(18px);
    background-color: #fff;
  }

  .settings-panel__update-actions {
    margin-top: var(--space-3);
  }

  .settings-panel__btn--primary {
    background-color: var(--accent-primary);
    color: #fff;
  }

  .settings-panel__btn--primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .settings-panel__btn--outline {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .settings-panel__btn--outline:hover:not(:disabled) {
    background-color: var(--bg-hover);
    color: var(--text-primary);
  }

  .settings-panel__status-text {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-top: var(--space-2);
  }

  .settings-panel__status-text--error {
    color: var(--danger);
  }

  .settings-panel__status-text--success {
    color: var(--success);
  }

  .settings-panel__progress-bar {
    height: 4px;
    background-color: var(--bg-surface);
    border-radius: var(--radius-full);
    margin-top: var(--space-2);
    overflow: hidden;
  }

  .settings-panel__progress-fill {
    height: 100%;
    background-color: var(--accent-primary);
    border-radius: var(--radius-full);
    transition: width 0.3s ease;
  }
</style>
