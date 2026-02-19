<script lang="ts">
  import { onMount } from 'svelte'

  let updateStatus = $state<UpdateStatus>({ state: 'idle' })
  let dismissed = $state(false)

  onMount(() => {
    void window.api.getUpdateStatus().then((status) => {
      updateStatus = status
    })

    const handleStatus = (status: UpdateStatus): void => {
      updateStatus = status
      dismissed = false
    }

    window.api.onUpdateStatus(handleStatus)
    return () => window.api.offUpdateStatus(handleStatus)
  })

  const show = $derived(!dismissed && updateStatus.state === 'downloaded')

  function install(): void {
    void window.api.installUpdate()
  }
</script>

{#if show}
  <div class="update-banner">
    <span class="update-banner__text">
      Version {updateStatus.state === 'downloaded' ? updateStatus.version : ''} is ready to install.
    </span>
    <button class="update-banner__btn update-banner__btn--primary" onclick={install}>
      Restart to Update
    </button>
    <button class="update-banner__btn update-banner__btn--dismiss" onclick={() => (dismissed = true)}>
      Later
    </button>
  </div>
{/if}

<style>
  .update-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background-color: var(--accent-primary);
    color: white;
    font-size: var(--font-size-sm);
    user-select: none;
  }

  .update-banner__text {
    flex: 1;
  }

  .update-banner__btn {
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    padding: var(--space-1) var(--space-3);
  }

  .update-banner__btn--primary {
    background-color: rgba(255, 255, 255, 0.2);
    color: white;
  }

  .update-banner__btn--primary:hover {
    background-color: rgba(255, 255, 255, 0.3);
  }

  .update-banner__btn--dismiss {
    background: none;
    color: rgba(255, 255, 255, 0.7);
  }

  .update-banner__btn--dismiss:hover {
    color: white;
  }
</style>
