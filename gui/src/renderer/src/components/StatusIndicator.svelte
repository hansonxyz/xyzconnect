<script lang="ts">
  import { effectiveState } from '../stores/connection.svelte'

  const stateConfig: Record<EffectiveState, { color: 'red' | 'yellow' | 'green'; label: string }> = {
    'no-daemon': { color: 'red', label: 'Daemon not running' },
    disconnected: { color: 'red', label: 'No device connected' },
    discovering: { color: 'yellow', label: 'Searching for devices...' },
    pairing: { color: 'yellow', label: 'Pairing...' },
    connected: { color: 'green', label: 'Device connected' },
    syncing: { color: 'yellow', label: 'Syncing...' },
    ready: { color: 'green', label: 'Ready' },
    error: { color: 'red', label: 'Error' }
  }

  // Phone reconnects every ~5s causing effectiveState to cycle through
  // discovering/disconnected/syncing. Use sticky logic:
  // - Once initial sync completes (ready), always show "Device connected"
  // - Only show "Syncing..." during the very first sync of a session
  // - Grace period before degrading to disconnected states
  const GOOD_STATES: Set<EffectiveState> = new Set(['connected', 'syncing', 'ready'])
  const GRACE_MS = 15_000

  let displayState = $state<EffectiveState>(effectiveState.current)
  let initialSyncDone = $state(false)
  let degradeTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    const state = effectiveState.current

    // Once we've reached 'ready' or 'connected' after syncing, initial sync is done
    if (state === 'ready' || (initialSyncDone && GOOD_STATES.has(state))) {
      initialSyncDone = true
    }

    if (GOOD_STATES.has(state)) {
      clearTimeout(degradeTimer)
      degradeTimer = undefined
      // After initial sync, collapse ready/connected to 'connected'
      // but still show 'syncing' when a manual or reconnect sync is active
      displayState = (initialSyncDone && state !== 'syncing') ? 'connected' : state
    } else if (GOOD_STATES.has(displayState) || displayState === 'connected') {
      // Was in a good state — delay before showing degraded state
      if (degradeTimer === undefined) {
        degradeTimer = setTimeout(() => {
          degradeTimer = undefined
          displayState = effectiveState.current
        }, GRACE_MS)
      }
    } else {
      // Not in a good state and wasn't before — show immediately
      displayState = state
    }
  })

  const config = $derived(stateConfig[displayState])
</script>

<div class="status-indicator">
  <span
    class="status-indicator__dot"
    class:status-indicator__dot--red={config.color === 'red'}
    class:status-indicator__dot--yellow={config.color === 'yellow'}
    class:status-indicator__dot--green={config.color === 'green'}
  ></span>
  <span class="status-indicator__label">{config.label}</span>
</div>

<style>
  .status-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .status-indicator__dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
  }

  .status-indicator__dot--red {
    background-color: var(--danger);
  }

  .status-indicator__dot--yellow {
    background-color: var(--warning);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .status-indicator__dot--green {
    background-color: var(--success);
  }

  .status-indicator__label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>
