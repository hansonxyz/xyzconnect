<script lang="ts">
  import { effectiveState, connection } from '../stores/connection.svelte'
  import {
    devices,
    acceptIncomingPairing,
    rejectIncomingPairing,
    clearPairingError
  } from '../stores/devices.svelte'
  import DeviceList from '../components/DeviceList.svelte'
  import qrCodeImage from '../assets/kdeconnect-qr.png'

  const hasAnyDevices = $derived(
    devices.discovered.length > 0 || devices.pairedIds.length > 0,
  )
</script>

<div class="pairing-page">
  {#if effectiveState.current === 'no-daemon'}
    <div class="pairing-page__center">
      <div class="pairing-page__spinner pairing-page__spinner--large"></div>
      <h2 class="pairing-page__title">Starting...</h2>
      <p class="pairing-page__subtitle">Initializing XYZConnect</p>
    </div>

  {:else if devices.incomingPairing}
    <div class="pairing-page__center">
      <h2 class="pairing-page__title">Incoming Pairing Request</h2>
      <p class="pairing-page__subtitle">
        <strong>{devices.incomingPairing.deviceName}</strong> wants to pair
      </p>
      <p class="pairing-page__hint">Verify the code matches on your phone before accepting</p>
      <div class="pairing-page__actions">
        <button
          class="pairing-page__btn pairing-page__btn--accept"
          onclick={() => acceptIncomingPairing(devices.incomingPairing!.deviceId)}
        >
          Accept
        </button>
        <button
          class="pairing-page__btn pairing-page__btn--reject"
          onclick={() => rejectIncomingPairing(devices.incomingPairing!.deviceId)}
        >
          Reject
        </button>
      </div>
    </div>

  {:else if devices.outgoingPairingKey}
    <div class="pairing-page__center">
      <h2 class="pairing-page__title">Pairing</h2>
      <div class="pairing-page__verification-key">{devices.outgoingPairingKey}</div>
      <p class="pairing-page__subtitle">Confirm this code matches on your phone</p>
      <div class="pairing-page__spinner"></div>
    </div>

  {:else if effectiveState.current === 'error'}
    <div class="pairing-page__center">
      <div class="pairing-page__icon pairing-page__icon--error">!</div>
      <h2 class="pairing-page__title">Connection Error</h2>
      <p class="pairing-page__subtitle">
        {connection.stateContext?.errorMessage ?? 'An unexpected error occurred'}
      </p>
      <p class="pairing-page__hint">The daemon will attempt to recover automatically</p>
    </div>

  {:else}
    <div class="pairing-page__discovery">
      <div class="pairing-page__discovery-header">
        <h2 class="pairing-page__title">Connect to Your Phone</h2>
        <div class="pairing-page__searching">
          <div class="pairing-page__spinner"></div>
          <span>Searching for devices...</span>
        </div>
      </div>

      {#if hasAnyDevices}
        <div class="pairing-page__device-list">
          <DeviceList />
        </div>
        <div class="pairing-page__setup-hint">
          <span>Don't see your phone?</span>
          Install
          <a
            href="https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp"
            target="_blank"
            rel="noopener noreferrer"
          >KDE Connect</a>
          and connect to the same Wi-Fi network.
        </div>
      {:else}
        <div class="pairing-page__onboarding">
          <div class="pairing-page__onboarding-icon">
            <svg viewBox="0 0 24 24" width="48" height="48">
              <path
                fill="currentColor"
                d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"
              />
            </svg>
          </div>
          <h3 class="pairing-page__onboarding-title">Get Started with KDE Connect</h3>
          <p class="pairing-page__onboarding-text">
            Install KDE Connect on your Android phone to sync your messages,
            contacts, and notifications with your computer.
          </p>
          <img
            class="pairing-page__onboarding-qr"
            src={qrCodeImage}
            alt="QR code to download KDE Connect from Google Play"
            width="160"
            height="160"
          />
          <a
            class="pairing-page__onboarding-link"
            href="https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get it on Google Play
          </a>
          <ol class="pairing-page__onboarding-steps">
            <li>Install KDE Connect on your phone</li>
            <li>Open the app and make sure you're on the same Wi-Fi network</li>
            <li>Your phone will appear here automatically</li>
          </ol>
        </div>
      {/if}
    </div>
  {/if}

  {#if devices.pairingError}
    <div class="pairing-page__toast">
      <span>{devices.pairingError}</span>
      <button class="pairing-page__toast-dismiss" onclick={clearPairingError}>Dismiss</button>
    </div>
  {/if}
</div>

<style>
  .pairing-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
  }

  .pairing-page__center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    padding: var(--space-8);
    text-align: center;
  }

  .pairing-page__icon {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-full);
    background-color: var(--bg-surface);
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-semibold);
  }

  .pairing-page__icon--error {
    background-color: var(--danger);
    color: #fff;
  }

  .pairing-page__title {
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .pairing-page__subtitle {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    max-width: 400px;
  }

  .pairing-page__hint {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .pairing-page__verification-key {
    padding: var(--space-4) var(--space-6);
    background-color: var(--bg-surface);
    border-radius: var(--radius-lg);
    font-family: monospace;
    font-size: var(--font-size-2xl);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
    letter-spacing: 0.3em;
    user-select: text;
  }

  .pairing-page__actions {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  .pairing-page__btn {
    padding: var(--space-2) var(--space-6);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .pairing-page__btn--accept {
    background-color: var(--success);
    color: #fff;
  }

  .pairing-page__btn--accept:hover {
    background-color: #43a047;
  }

  .pairing-page__btn--reject {
    background-color: var(--bg-surface);
    color: var(--text-secondary);
  }

  .pairing-page__btn--reject:hover {
    background-color: var(--danger);
    color: #fff;
  }

  .pairing-page__discovery {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--space-8);
  }

  .pairing-page__discovery-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-6);
  }

  .pairing-page__searching {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .pairing-page__device-list {
    flex: 1;
    overflow-y: auto;
  }

  .pairing-page__setup-hint {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    text-align: center;
    line-height: 1.5;
  }

  .pairing-page__setup-hint span {
    font-weight: var(--font-weight-medium);
    color: var(--text-secondary);
  }

  .pairing-page__setup-hint a {
    color: var(--accent-primary);
    text-decoration: none;
  }

  .pairing-page__setup-hint a:hover {
    text-decoration: underline;
  }

  .pairing-page__onboarding {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    text-align: center;
    padding: var(--space-4);
  }

  .pairing-page__onboarding-icon {
    color: var(--accent-primary);
    margin-bottom: var(--space-2);
  }

  .pairing-page__onboarding-title {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .pairing-page__onboarding-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    max-width: 380px;
    line-height: 1.5;
  }

  .pairing-page__onboarding-qr {
    margin: var(--space-2) 0;
  }

  .pairing-page__onboarding-link {
    font-size: var(--font-size-sm);
    color: var(--accent-primary);
    text-decoration: none;
  }

  .pairing-page__onboarding-link:hover {
    text-decoration: underline;
  }

  .pairing-page__onboarding-steps {
    list-style: none;
    counter-reset: steps;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
    text-align: left;
  }

  .pairing-page__onboarding-steps li {
    counter-increment: steps;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .pairing-page__onboarding-steps li::before {
    content: counter(steps);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-full);
    background-color: var(--accent-primary);
    color: #fff;
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-semibold);
    flex-shrink: 0;
  }

  .pairing-page__spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent-primary);
    border-radius: var(--radius-full);
    animation: spin 0.8s linear infinite;
  }

  .pairing-page__spinner--large {
    width: 40px;
    height: 40px;
    border-width: 3px;
  }

  .pairing-page__toast {
    position: absolute;
    bottom: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background-color: var(--danger);
    color: #fff;
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
  }

  .pairing-page__toast-dismiss {
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.4);
    color: #fff;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  .pairing-page__toast-dismiss:hover {
    background-color: rgba(255, 255, 255, 0.15);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
