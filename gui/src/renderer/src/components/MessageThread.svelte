<script lang="ts">
  import { conversations } from '../stores/conversations.svelte'
  import { displayConversations } from '../stores/conversations.svelte'
  import { messages, displayMessages, loadThread } from '../stores/messages.svelte'
  import { clearAttachmentStates, requestDownload } from '../stores/attachments.svelte'
  import {
    sendMessage as queueSendMessage,
    getPendingMessages,
    cancelSend,
    retrySend,
  } from '../stores/send-queue.svelte'
  import type { PendingMessage } from '../stores/send-queue.svelte'
  import MessageBubble from './MessageBubble.svelte'
  import { t } from '../stores/i18n.svelte'
  import { tick } from 'svelte'
  import 'emoji-picker-element'

  // Export thread as TXT or CSV
  let showExportMenu = $state(false)

  async function exportThread(format: 'txt' | 'csv'): Promise<void> {
    showExportMenu = false
    if (!selectedConversation || messages.rows.length === 0) return

    const safeName = selectedConversation.displayName.replace(/[<>:"/\\|?*]/g, '_')
    const ext = format
    const filters = format === 'csv'
      ? [{ name: 'CSV Files', extensions: ['csv'] }]
      : [{ name: 'Text Files', extensions: ['txt'] }]

    const filePath = await window.api.showSaveDialog(`${safeName}.${ext}`, filters)
    if (!filePath) return

    let content: string
    if (format === 'csv') {
      const header = t('export.csvHeader')
      const rows = messages.rows.map((row) => {
        const date = new Date(row.date).toISOString()
        const from = row.type === 2 ? t('export.me') : row.address
        const body = '"' + (row.body ?? '').replace(/"/g, '""') + '"'
        return `${date},${from},${body}`
      })
      content = header + '\n' + rows.join('\n')
    } else {
      const lines = messages.rows.map((row) => {
        const date = new Date(row.date).toLocaleString()
        const from = row.type === 2 ? t('export.me') : row.address
        return `[${date}] ${from}: ${row.body ?? ''}`
      })
      content = lines.join('\n')
    }

    await window.api.writeFile(filePath, content)
  }

  // Send message state
  let messageText = $state('')
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let showEmojiPicker = $state(false)
  let emojiPickerEl: HTMLDivElement | undefined = $state()

  const selectedConversation = $derived(
    displayConversations.current.find((c) => c.threadId === conversations.selectedThreadId) ?? null,
  )

  const canSend = $derived(messageText.trim().length > 0)

  // Pending messages for the current thread
  const pendingMsgs = $derived(
    conversations.selectedThreadId !== null
      ? getPendingMessages(conversations.selectedThreadId)
      : [],
  )

  async function handleSend(): Promise<void> {
    if (!canSend || !selectedConversation) {
      textareaEl?.focus()
      return
    }
    const address = selectedConversation.addresses[0]
    if (!address) {
      textareaEl?.focus()
      return
    }

    const body = messageText.trim()
    const threadId = selectedConversation.threadId
    messageText = ''
    resetTextareaHeight()

    // Fire and forget — the send queue handles status tracking
    void queueSendMessage(threadId, address, body)

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
    // Auto-resize: reset to 1 row, then expand to content (max 4 rows via CSS)
    textareaEl.style.height = 'auto'
    textareaEl.style.height = textareaEl.scrollHeight + 'px'
  }

  function resetTextareaHeight(): void {
    if (!textareaEl) return
    textareaEl.style.height = 'auto'
  }

  function toggleEmojiPicker(): void {
    showEmojiPicker = !showEmojiPicker
  }

  function handleEmojiClick(e: Event): void {
    const detail = (e as CustomEvent).detail
    if (detail?.unicode) {
      // Insert emoji at cursor position
      if (textareaEl) {
        const start = textareaEl.selectionStart
        const end = textareaEl.selectionEnd
        const before = messageText.slice(0, start)
        const after = messageText.slice(end)
        messageText = before + detail.unicode + after
        // Move cursor after the inserted emoji
        requestAnimationFrame(() => {
          if (textareaEl) {
            const newPos = start + detail.unicode.length
            textareaEl.selectionStart = newPos
            textareaEl.selectionEnd = newPos
            textareaEl.focus()
            handleInput()
          }
        })
      } else {
        messageText += detail.unicode
      }
    }
  }

  // Close emoji picker and export menu when clicking outside
  function handleDocumentClick(e: MouseEvent): void {
    const target = e.target as HTMLElement
    if (showEmojiPicker) {
      if (emojiPickerEl && !emojiPickerEl.contains(target) && !target.closest('.compose__emoji-btn')) {
        showEmojiPicker = false
      }
    }
    if (showExportMenu) {
      if (!target.closest('.message-thread__export-wrapper')) {
        showExportMenu = false
      }
    }
  }

  // Wire up emoji-click event on the web component and close-on-outside-click
  $effect(() => {
    if (showEmojiPicker || showExportMenu) {
      document.addEventListener('click', handleDocumentClick)

      // Attach emoji-click listener to the web component (custom element event)
      const picker = showEmojiPicker ? emojiPickerEl?.querySelector('emoji-picker') : null
      if (picker) {
        picker.addEventListener('emoji-click', handleEmojiClick)
      }

      return () => {
        document.removeEventListener('click', handleDocumentClick)
        if (picker) {
          picker.removeEventListener('emoji-click', handleEmojiClick)
        }
      }
    }
  })

  // Close emoji picker and export menu on thread switch
  $effect(() => {
    conversations.selectedThreadId
    showEmojiPicker = false
    showExportMenu = false
  })

  // Virtual scroll constants
  const EST_MSG_HEIGHT = 56
  const EST_SEPARATOR_HEIGHT = 40
  const EST_IMAGE_ATTACHMENT_HEIGHT = 208   // 200px placeholder + 8px gap
  const EST_AUDIO_ATTACHMENT_HEIGHT = 56    // 48px placeholder + 8px gap
  const BUFFER_ITEMS = 15

  let scrollContainer: HTMLDivElement | undefined = $state()
  let prevThreadId: number | null = null
  let prevMessageCount = 0
  let scrollTop = $state(0)
  let containerHeight = $state(600)
  let shouldAutoScroll = true

  // Scroll position preservation: track the first visible message and its
  // pixel offset from the viewport top. When older messages are prepended,
  // we use this anchor to restore the scroll position so the user's view
  // doesn't jump.
  let anchorMessageId: number | null = null
  let anchorViewportOffset = 0

  function updateScrollAnchor(): void {
    if (!scrollContainer) return
    const msgs = displayMessages.current
    const { offsets, heights, count } = layout
    if (count === 0) return

    const viewTop = scrollContainer.scrollTop

    // Binary search: first message whose bottom edge >= viewTop
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid]! + heights[mid]! < viewTop) lo = mid + 1
      else hi = mid
    }

    if (lo < count) {
      anchorMessageId = msgs[lo]!.id
      anchorViewportOffset = offsets[lo]! - viewTop
    }
  }

  // Load thread when selection changes
  $effect(() => {
    const threadId = conversations.selectedThreadId
    if (threadId !== prevThreadId) {
      prevThreadId = threadId
      prevMessageCount = 0
      shouldAutoScroll = true
      scrollTop = 0
      clearAttachmentStates()
      loadThread(threadId)
    }
  })

  // Compute cumulative Y offsets and per-item heights (cheap — just arithmetic)
  const layout = $derived.by(() => {
    const msgs = displayMessages.current
    const len = msgs.length
    const offsets: number[] = new Array(len)
    const heights: number[] = new Array(len)
    let y = 0
    for (let i = 0; i < len; i++) {
      offsets[i] = y
      let h = msgs[i]!.showTimestamp ? EST_MSG_HEIGHT + EST_SEPARATOR_HEIGHT : EST_MSG_HEIGHT
      // Add height for each attachment
      for (const att of msgs[i]!.attachments) {
        h += att.kind === 'audio' ? EST_AUDIO_ATTACHMENT_HEIGHT : EST_IMAGE_ATTACHMENT_HEIGHT
      }
      heights[i] = h
      y += h
    }
    return { offsets, heights, totalHeight: y, count: len }
  })

  // Determine visible range via binary search (only depends on layout + scroll position)
  const visible = $derived.by(() => {
    const { offsets, heights, totalHeight, count } = layout
    if (count === 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0 }

    const viewTop = scrollTop
    const viewBottom = scrollTop + containerHeight

    // Binary search: first item whose bottom edge >= viewTop
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid]! + heights[mid]! < viewTop) lo = mid + 1
      else hi = mid
    }
    const start = Math.max(0, lo - BUFFER_ITEMS)

    // Binary search: last item whose top edge <= viewBottom
    lo = start
    hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid]! > viewBottom) hi = mid - 1
      else lo = mid
    }
    const end = Math.min(count, lo + 1 + BUFFER_ITEMS)

    const topPad = start > 0 ? offsets[start]! : 0
    const lastRendered = end - 1
    const bottomPad = end < count ? totalHeight - (offsets[lastRendered]! + heights[lastRendered]!) : 0

    return { start, end, topPad, bottomPad, totalHeight }
  })

  const visibleMessages = $derived(
    displayMessages.current.slice(visible.start, visible.end),
  )

  // Trigger attachment downloads for visible messages.
  // More reliable than per-component IntersectionObserver since the virtual
  // scroll already knows exactly which items are on screen.
  $effect(() => {
    const msgs = visibleMessages
    let withAtts = 0
    for (const msg of msgs) {
      if (msg.attachments.length > 0) {
        withAtts++
        requestDownload(msg.attachments)
      }
    }
    if (msgs.length > 0) {
      window.api.log('renderer', 'Visible range attachment check', {
        visibleCount: String(msgs.length),
        withAttachments: String(withAtts),
        start: String(visible.start),
        end: String(visible.end),
      })
    }
  })

  // Auto-scroll to bottom on load, or preserve scroll position during pagination
  $effect(() => {
    const count = displayMessages.current.length
    if (count > 0 && count !== prevMessageCount) {
      const hadMessages = prevMessageCount > 0
      prevMessageCount = count
      if (shouldAutoScroll) {
        scrollToBottom()
      } else if (hadMessages && anchorMessageId !== null) {
        // Older messages were prepended — restore scroll so the same
        // content stays in view
        const msgs = displayMessages.current
        const anchorIdx = msgs.findIndex((m) => m.id === anchorMessageId)
        if (anchorIdx >= 0) {
          const newOffset = layout.offsets[anchorIdx]!
          const targetScroll = newOffset - anchorViewportOffset
          requestAnimationFrame(() => {
            if (scrollContainer) {
              scrollContainer.scrollTop = targetScroll
              scrollTop = targetScroll
            }
          })
        }
      }
    }
  })

  // Auto-scroll when pending messages are added
  $effect(() => {
    if (pendingMsgs.length > 0 && shouldAutoScroll) {
      scrollToBottom()
    }
  })

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      }
    })
  }

  function handleScroll(): void {
    if (!scrollContainer) return
    scrollTop = scrollContainer.scrollTop
    containerHeight = scrollContainer.clientHeight

    // If user scrolled near bottom, keep auto-scrolling for new messages
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
    shouldAutoScroll = distanceFromBottom < 100

    // Track anchor for scroll position preservation during pagination
    updateScrollAnchor()
  }

  // Measure container height on mount
  $effect(() => {
    if (scrollContainer) {
      containerHeight = scrollContainer.clientHeight
    }
  })
</script>

<div class="message-thread">
  {#if selectedConversation}
    <div class="message-thread__header">
      <div class="message-thread__header-info">
        <h2 class="message-thread__name">{selectedConversation.displayName}</h2>
        {#if selectedConversation.addresses.length === 1 && selectedConversation.isContact}
          <span class="message-thread__address">{selectedConversation.addresses[0]}</span>
        {/if}
      </div>
      <div class="message-thread__header-actions">
        <div class="message-thread__export-wrapper">
          <button
            class="message-thread__icon-btn"
            onclick={() => { showExportMenu = !showExportMenu }}
            title={t('export.tooltip')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
          </button>
          {#if showExportMenu}
            <div class="message-thread__export-menu">
              <button class="message-thread__export-option" onclick={() => void exportThread('txt')}>
                {t('export.txt')}
              </button>
              <button class="message-thread__export-option" onclick={() => void exportThread('csv')}>
                {t('export.csv')}
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if messages.loading && messages.rows.length === 0}
    <div class="message-thread__status">
      <div class="message-thread__spinner"></div>
      <span>{t('messages.loading')}</span>
    </div>
  {:else if displayMessages.current.length === 0 && pendingMsgs.length === 0}
    <div class="message-thread__status">
      <span>{t('messages.empty')}</span>
    </div>
  {:else}
    <div
      class="message-thread__messages"
      bind:this={scrollContainer}
      onscroll={handleScroll}
    >
      <div style:height="{visible.topPad}px"></div>
      {#each visibleMessages as msg (msg.id)}
        {#if msg.showTimestamp}
          <div class="message-thread__timestamp">
            <span class="message-thread__timestamp-label">{msg.timestampLabel}</span>
          </div>
        {/if}
        <MessageBubble message={msg} />
      {/each}
      <div style:height="{visible.bottomPad}px"></div>
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
    </div>
  {/if}

  <div class="compose">
    <div class="compose__row">
      <div class="compose__emoji-wrapper">
        <button
          class="compose__emoji-btn"
          class:compose__emoji-btn--active={showEmojiPicker}
          onclick={toggleEmojiPicker}
          title={t('messages.emoji')}
          type="button"
        >
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
          </svg>
        </button>
        {#if showEmojiPicker}
          <div class="compose__emoji-popover" bind:this={emojiPickerEl}>
            <!-- svelte-ignore element_invalid_self_closing_tag -->
            <emoji-picker class="emoji-picker-dark" data-source="./emoji-data.json"></emoji-picker>
          </div>
        {/if}
      </div>
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
</div>

<style>
  .message-thread {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .message-thread__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    background-color: var(--bg-secondary);
  }

  .message-thread__header-info {
    min-width: 0;
  }

  .message-thread__name {
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .message-thread__address {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .message-thread__header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .message-thread__icon-btn {
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

  .message-thread__icon-btn:hover {
    color: var(--text-secondary);
    background-color: var(--bg-hover);
  }

  .message-thread__export-wrapper {
    position: relative;
  }

  .message-thread__export-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: var(--space-1);
    background-color: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    z-index: 50;
    overflow: hidden;
  }

  .message-thread__export-option {
    display: block;
    width: 100%;
    padding: var(--space-2) var(--space-4);
    background: none;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-family);
    font-size: var(--font-size-sm);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .message-thread__export-option:hover {
    background-color: var(--bg-hover);
  }

  .message-thread__messages {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4) 0;
  }

  .message-thread__status {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .message-thread__spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent-primary);
    border-radius: var(--radius-full);
    animation: spin 0.8s linear infinite;
  }

  .message-thread__timestamp {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-3) var(--space-4);
  }

  .message-thread__timestamp-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background-color: var(--bg-surface);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
  }

  /* --- Pending message bubbles --- */

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

  /* --- Compose area --- */

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

  .compose__emoji-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .compose__emoji-btn {
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--radius-full);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s;
  }

  .compose__emoji-btn:hover {
    color: var(--text-secondary);
  }

  .compose__emoji-btn--active {
    color: var(--accent-primary);
  }

  .compose__emoji-popover {
    position: absolute;
    bottom: 44px;
    left: 0;
    z-index: 100;
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
  }

  /* Style the emoji picker to match our dark theme */
  :global(emoji-picker.emoji-picker-dark) {
    --background: var(--bg-secondary);
    --border-color: var(--border);
    --input-border-color: var(--border);
    --input-font-color: var(--text-primary);
    --input-placeholder-color: var(--text-muted);
    --category-font-color: var(--text-muted);
    --indicator-color: var(--accent-primary);
    --button-active-background: var(--bg-hover);
    --button-hover-background: var(--bg-hover);
    --outline-color: var(--accent-primary);
    --text-color: var(--text-primary);
    --emoji-size: 1.4rem;
    --num-columns: 8;
    width: 320px;
    height: 360px;
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

  .compose__input:disabled {
    opacity: 0.5;
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

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
