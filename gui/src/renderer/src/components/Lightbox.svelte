<script lang="ts">
  import { closeLightbox, lightbox } from '../stores/lightbox.svelte'

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      closeLightbox()
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      closeLightbox()
    }
  }

  function handleContextMenu(e: MouseEvent): void {
    if (!lightbox.current) return
    e.preventDefault()
    window.api.showAttachmentContextMenu(lightbox.current.partId, lightbox.current.messageId)
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if lightbox.current}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="lightbox" onclick={handleBackdropClick}>
    <button class="lightbox__close" onclick={closeLightbox} title="Close">
      <svg viewBox="0 0 24 24" width="28" height="28">
        <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </button>
    <div class="lightbox__content">
      {#if lightbox.current.type === 'image'}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <img class="lightbox__media" src={lightbox.current.src} alt="Full size" oncontextmenu={handleContextMenu} />
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="lightbox__media" src={lightbox.current.src} controls autoplay oncontextmenu={handleContextMenu}></video>
      {/if}
    </div>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background-color: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lightbox__close {
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 1001;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 8px;
    border-radius: 50%;
    transition: color 0.15s, background-color 0.15s;
  }

  .lightbox__close:hover {
    color: white;
    background-color: rgba(255, 255, 255, 0.1);
  }

  .lightbox__content {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lightbox__media {
    /* Small media (e.g. 150x200 MMS): scale up to at least 2/3 of the
       smaller viewport dimension so it's not a postage stamp */
    min-width: min(66.67vw, 66.67vh);
    min-height: min(66.67vw, 66.67vh);
    /* Large media: cap at 90% viewport */
    max-width: 90vw;
    max-height: 90vh;
    object-fit: contain;
    border-radius: 4px;
  }
</style>
