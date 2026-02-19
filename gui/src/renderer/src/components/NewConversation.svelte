<script lang="ts">
  import { tick } from 'svelte'
  import {
    conversations,
    findThreadByAddress,
    selectConversation,
    setComposeAddress,
  } from '../stores/conversations.svelte'
  import { findContactByPhone } from '../stores/contacts.svelte'
  import { formatPhone } from '../lib/phone'
  import {
    sendMessage as queueSendMessage,
    getPendingMessages,
    clearPendingForThread,
    cancelSend,
    retrySend,
  } from '../stores/send-queue.svelte'
  import type { PendingMessage } from '../stores/send-queue.svelte'
  import ContactAutocomplete from './ContactAutocomplete.svelte'
  import { t } from '../stores/i18n.svelte'

  let resolvedAddress: string | null = $state(null)
  let hasSent = $state(false)
  let messageText = $state('')
  let textareaEl: HTMLTextAreaElement | undefined = $state()

  const resolvedDisplay = $derived.by(() => {
    if (!resolvedAddress) return null
    const contact = findContactByPhone(resolvedAddress)
    return contact ? contact.name : formatPhone(resolvedAddress)
  })

  const pendingMsgs = $derived(getPendingMessages(-1))
  const canSend = $derived(messageText.trim().length > 0 && resolvedAddress !== null)

  function handleAddressSelect(address: string): void {
    // Check if there's an existing thread for this address
    const existingThread = findThreadByAddress(address)
    if (existingThread !== null) {
      selectConversation(existingThread)
      return
    }
    resolvedAddress = address
    setComposeAddress(address)
    // Focus the compose box after address is set
    tick().then(() => textareaEl?.focus())
  }

  function clearAddress(): void {
    resolvedAddress = null
    setComposeAddress('')
  }

  async function handleSend(): Promise<void> {
    if (!canSend || !resolvedAddress) return

    const body = messageText.trim()
    messageText = ''
    resetTextareaHeight()
    hasSent = true

    void queueSendMessage(-1, resolvedAddress, body)

    await tick()
    textareaEl?.focus()
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  function handleInput(): void {
    if (!textareaEl) return
    textareaEl.style.height = 'auto'
    textareaEl.style.height = textareaEl.scrollHeight + 'px'
  }

  function resetTextareaHeight(): void {
    if (!textareaEl) return
    textareaEl.style.height = 'auto'
  }

  // Post-send transition: watch for real thread appearing
  $effect(() => {
    if (hasSent && conversations.composingNew && resolvedAddress) {
      const realThread = findThreadByAddress(resolvedAddress)
      if (realThread !== null) {
        clearPendingForThread(-1)
        selectConversation(realThread)
      }
    }
  })
</script>

<div class="new-conversation">
  <div class="new-conversation__header">
    <span class="new-conversation__label">{t('newMessage.to')}</span>
    {#if resolvedAddress}
      <div class="new-conversation__resolved">
        <span class="new-conversation__resolved-name">{resolvedDisplay}</span>
        <button
          class="new-conversation__resolved-clear"
          onclick={clearAddress}
          title={t('newMessage.changeRecipient')}
        >
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
    {:else}
      <ContactAutocomplete onSelect={handleAddressSelect} />
    {/if}
  </div>

  <div class="new-conversation__body">
    {#if pendingMsgs.length > 0}
      {#each pendingMsgs as pmsg (pmsg.queueId)}
        <div class="message-bubble message-bubble--sent">
          <div class="message-bubble__content message-bubble__content--pending">
            <p class="message-bubble__body">{pmsg.body}</p>
            <div class="message-bubble__status-row">
              {#if pmsg.status === 'sending'}
                <span class="message-bubble__status">{t('messages.sending')}</span>
                <button
                  class="message-bubble__cancel"
                  onclick={() => void cancelSend(pmsg.queueId)}
                  title={t('messages.cancel')}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14">
                    <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              {:else if pmsg.status === 'sent'}
                <span class="message-bubble__status">{t('messages.sent')}</span>
              {:else if pmsg.status === 'timeout'}
                <span class="message-bubble__status message-bubble__status--error">{t('messages.failed')}</span>
                <button
                  class="message-bubble__action"
                  onclick={() => void retrySend(pmsg.queueId)}
                >{t('messages.retry')}</button>
                <button
                  class="message-bubble__cancel"
                  onclick={() => void cancelSend(pmsg.queueId)}
                  title={t('messages.cancel')}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14">
                    <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {:else if resolvedAddress}
      <div class="new-conversation__empty">
        <p class="new-conversation__empty-text">{t('newMessage.startNew')}</p>
      </div>
    {:else}
      <div class="new-conversation__empty">
        <p class="new-conversation__empty-text">{t('newMessage.enterContact')}</p>
      </div>
    {/if}
  </div>

  {#if resolvedAddress}
    <div class="compose">
      <div class="compose__row">
        <textarea
          class="compose__input"
          bind:this={textareaEl}
          bind:value={messageText}
          oninput={handleInput}
          onkeydown={handleKeydown}
          placeholder={t('messages.compose')}
          rows="1"
        ></textarea>
        <button
          class="compose__send"
          disabled={!canSend}
          onclick={() => void handleSend()}
          title={t('messages.send')}
          type="button"
        >
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .new-conversation {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .new-conversation__header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    background-color: var(--bg-secondary);
  }

  .new-conversation__label {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .new-conversation__resolved {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background-color: var(--bg-surface);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
  }

  .new-conversation__resolved-name {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    font-weight: var(--font-weight-medium);
  }

  .new-conversation__resolved-clear {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
  }

  .new-conversation__resolved-clear:hover {
    color: var(--text-secondary);
  }

  .new-conversation__body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4) 0;
  }

  .new-conversation__empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }

  .new-conversation__empty-text {
    color: var(--text-muted);
    font-size: var(--font-size-base);
  }

  /* Pending message bubbles (same styles as MessageThread) */

  .message-bubble {
    display: flex;
    margin-bottom: var(--space-1);
    padding: 0 var(--space-4);
  }

  .message-bubble--sent {
    justify-content: flex-end;
  }

  .message-bubble__content {
    max-width: 65%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-lg);
    word-wrap: break-word;
    overflow-wrap: break-word;
    background-color: var(--bubble-sent);
    border-bottom-right-radius: var(--radius-sm);
  }

  .message-bubble__content--pending {
    opacity: 0.7;
  }

  .message-bubble__body {
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .message-bubble__status-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .message-bubble__status {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-style: italic;
  }

  .message-bubble__status--error {
    color: var(--danger);
    font-style: normal;
  }

  .message-bubble__action {
    background: none;
    border: 1px solid var(--text-muted);
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .message-bubble__action:hover {
    color: var(--text-primary);
    border-color: var(--text-secondary);
  }

  .message-bubble__cancel {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    margin-left: auto;
  }

  .message-bubble__cancel:hover {
    color: var(--danger);
  }

  /* Compose area (same styles as MessageThread) */

  .compose {
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--border);
    background-color: var(--bg-secondary);
  }

  .compose__row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  .compose__input {
    flex: 1;
    background-color: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-family);
    font-size: var(--font-size-sm);
    line-height: 1.4;
    resize: none;
    overflow-y: auto;
    max-height: calc(var(--font-size-sm) * 1.4 * 4 + var(--space-2) * 2 + 2px);
    outline: none;
    transition: border-color 0.15s;
  }

  .compose__input::placeholder {
    color: var(--text-muted);
  }

  .compose__input:focus {
    border-color: var(--accent-primary);
  }

  .compose__send {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--radius-full);
    background-color: var(--accent-primary);
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.15s, opacity 0.15s;
  }

  .compose__send:hover:not(:disabled) {
    background-color: #4a7de0;
  }

  .compose__send:disabled {
    background-color: var(--bg-surface);
    color: var(--text-muted);
    cursor: default;
  }
</style>
