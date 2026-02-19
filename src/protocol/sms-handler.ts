/**
 * SMS Protocol Handler
 *
 * Handles incoming SMS/MMS message packets from the phone and provides
 * methods to request conversations, messages, and send SMS.
 *
 * Incoming:
 * - kdeconnect.sms.messages — batch of messages for a thread
 * - kdeconnect.sms.attachment_file — attachment payload via TLS transfer
 *
 * Outgoing:
 * - kdeconnect.sms.request_conversations — request conversation list
 * - kdeconnect.sms.request_conversation — request messages for a thread
 * - kdeconnect.sms.request — send an SMS
 * - kdeconnect.sms.request_attachment — request attachment download
 *
 * MMS two-phase: Messages arrive with empty attachments first, then
 * attachment metadata arrives in separate packets seconds later.
 * We merge by message _id.
 *
 * Attachment download: Phone opens a TCP server on a random port, sends
 * the port in payloadTransferInfo. We open a new TLS connection to that
 * port and stream the file data to disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { execFile } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import {
  createPacket,
  serializePacket,
  PACKET_TYPE_SMS_REQUEST,
  PACKET_TYPE_SMS_REQUEST_CONVERSATIONS,
  PACKET_TYPE_SMS_REQUEST_CONVERSATION,
  PACKET_TYPE_SMS_REQUEST_ATTACHMENT,
} from '../network/packet.js';
import type { NetworkPacket } from '../network/packet.js';
import type { DeviceConnection } from '../network/connection-manager.js';
import type { DatabaseService, MessageRow, ConversationRow, AttachmentRow } from '../database/database.js';
import { getAttachmentsDir } from '../utils/paths.js';

export interface SmsHandlerOptions {
  db: DatabaseService;
  getConnection: () => DeviceConnection | undefined;
  getCert: () => string | undefined;
  getKey: () => string | undefined;
}

// Phone message format from kdeconnect.sms.messages packet
interface PhoneMessage {
  _id: number;
  thread_id: number;
  addresses: Array<{ address: string }>;
  body: string | null;
  date: number;
  type: number;
  read: number;
  sub_id?: number;
  event?: number;
  attachments?: Array<{
    part_id: number;
    unique_identifier: number;
    mime_type?: string;
    thumbnail?: string;
    filename?: string;
  }>;
}

type MessagesCallback = (threadId: number, messages: MessageRow[]) => void;
type ConversationsUpdatedCallback = (conversations: ConversationRow[]) => void;
type AttachmentDownloadedCallback = (partId: number, messageId: number, localPath: string) => void;
type SendStatusCallback = (queueId: string, status: 'sent' | 'timeout') => void;

interface QueuedSend {
  queueId: string;
  address: string;
  body: string;
  queuedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

export class SmsHandler {
  private db: DatabaseService;
  private getConnection: () => DeviceConnection | undefined;
  private getCert: () => string | undefined;
  private getKey: () => string | undefined;
  private logger: Logger;
  private messagesCallbacks: MessagesCallback[] = [];
  private conversationsUpdatedCallbacks: ConversationsUpdatedCallback[] = [];
  private attachmentDownloadedCallbacks: AttachmentDownloadedCallback[] = [];
  private sendStatusCallbacks: SendStatusCallback[] = [];
  private sendQueue = new Map<string, QueuedSend>();
  private sendQueueCounter = 0;
  private pendingDownloads = new Map<string, {
    resolve: (localPath: string) => void;
    reject: (err: Error) => void;
  }>();

  // Sequential download queue — only one attachment requested from the phone at a time
  private downloadQueue: Array<{
    partId: number;
    messageId: number;
    uniqueIdentifier: string;
    resolve: (localPath: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private downloadInFlight = false;

  /** Socket timeout for TLS payload connections (ms) */
  private static readonly PAYLOAD_SOCKET_TIMEOUT = 30000;
  /** Per-attachment download timeout (ms) */
  private static readonly DOWNLOAD_TIMEOUT = 60000;

  constructor(options: SmsHandlerOptions) {
    this.db = options.db;
    this.getConnection = options.getConnection;
    this.getCert = options.getCert;
    this.getKey = options.getKey;
    this.logger = createLogger('sms-handler');
  }

  /**
   * Handle incoming kdeconnect.sms.messages packet.
   */
  handleMessages(packet: NetworkPacket, _connection: DeviceConnection): void {
    const messages = packet.body['messages'] as PhoneMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) {
      this.logger.debug('protocol.sms', 'Empty or missing messages array in packet');
      return;
    }

    // Group messages by thread_id
    const threadMap = new Map<number, PhoneMessage[]>();
    for (const msg of messages) {
      if (typeof msg._id !== 'number' || typeof msg.thread_id !== 'number') {
        this.logger.warn('protocol.sms', 'Skipping message with missing _id or thread_id', {
          _id: msg._id,
          thread_id: msg.thread_id,
        });
        continue;
      }
      const list = threadMap.get(msg.thread_id) ?? [];
      list.push(msg);
      threadMap.set(msg.thread_id, list);
    }

    for (const [threadId, threadMessages] of threadMap) {
      const messageRows: MessageRow[] = [];
      const attachmentRows: AttachmentRow[] = [];

      // Collect addresses for conversation
      const addressSet = new Set<string>();

      for (const msg of threadMessages) {
        const address = msg.addresses?.[0]?.address ?? '';
        if (address) {
          addressSet.add(address);
        }

        messageRows.push({
          _id: msg._id,
          thread_id: msg.thread_id,
          address,
          body: msg.body ?? null,
          date: msg.date,
          type: msg.type,
          read: msg.read ?? 0,
          sub_id: msg.sub_id ?? 0,
          event: msg.event ?? 0,
        });

        // Handle attachment metadata (MMS two-phase)
        if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            // Save phone-provided thumbnail to disk if present
            let thumbnailPath: string | null = null;
            const thumbData = (att as Record<string, unknown>)['encoded_thumbnail'] as string | undefined
              ?? att.thumbnail;
            if (thumbData && typeof thumbData === 'string' && thumbData.length > 0) {
              try {
                const attachDir = getAttachmentsDir();
                fs.mkdirSync(attachDir, { recursive: true });
                const thumbFile = path.join(attachDir, `${att.part_id}_${msg._id}_thumb.jpg`);
                fs.writeFileSync(thumbFile, Buffer.from(thumbData, 'base64'));
                thumbnailPath = thumbFile;
              } catch (err) {
                this.logger.warn('protocol.sms', 'Failed to save phone thumbnail', {
                  partId: att.part_id,
                  messageId: msg._id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            attachmentRows.push({
              part_id: att.part_id,
              message_id: msg._id,
              unique_identifier: String(att.unique_identifier),
              mime_type: att.mime_type ?? 'application/octet-stream',
              filename: att.filename ?? null,
              file_size: null,
              downloaded: 0,
              local_path: null,
              thumbnail_path: thumbnailPath,
            });
          }
        }
      }

      // Persist messages
      this.db.upsertMessages(messageRows);

      // Persist attachments if any
      if (attachmentRows.length > 0) {
        this.db.upsertAttachments(attachmentRows);
      }

      // Build/update conversation from this batch
      const sorted = [...threadMessages].sort((a, b) => b.date - a.date);
      const mostRecent = sorted[0]!;
      const unreadCount = threadMessages.filter((m) => m.read === 0 && m.type === 1).length;

      const convRow: ConversationRow = {
        thread_id: threadId,
        addresses: JSON.stringify(Array.from(addressSet)),
        snippet: mostRecent.body ?? null,
        date: mostRecent.date,
        read: unreadCount === 0 ? 1 : 0,
        unread_count: unreadCount,
        locally_read_at: null, // Preserved by upsert COALESCE
        has_outgoing: 0, // Computed by getAllConversations query, not stored
      };

      // Check if existing conversation has newer data
      const existing = this.db.getConversation(threadId);
      if (!existing || mostRecent.date >= existing.date) {
        this.db.upsertConversation(convRow);
      }

      this.logger.info('protocol.sms', 'Messages received', {
        threadId,
        count: messageRows.length,
        attachments: attachmentRows.length,
      });

      // Fire callbacks
      this.fireMessages(threadId, messageRows);
    }

    // Fire conversations updated
    const updatedConversations = this.db.getAllConversations();
    this.fireConversationsUpdated(updatedConversations);
  }

  /**
   * Handle incoming kdeconnect.sms.attachment_file packet.
   * Opens a TLS connection to the phone's payload port and streams the file to disk.
   */
  handleAttachmentFile(packet: NetworkPacket, connection: DeviceConnection): void {
    const filename = packet.body['filename'] as string | undefined;
    const payloadSize = packet.payloadSize;
    const port = (packet.payloadTransferInfo as Record<string, unknown> | undefined)?.['port'] as number | undefined;

    this.logger.debug('protocol.sms', 'Received attachment_file packet', {
      body: packet.body,
      payloadSize,
      port,
      hasPayloadTransferInfo: !!packet.payloadTransferInfo,
    });

    if (!port || !payloadSize) {
      this.logger.warn('protocol.sms', 'Attachment packet missing payloadTransferInfo or payloadSize', {
        filename,
        port,
        payloadSize,
      });
      // Reject any pending download that might match this filename
      this.rejectPendingByFilename(filename, 'Attachment packet missing port or payloadSize');
      return;
    }

    const cert = this.getCert();
    const key = this.getKey();
    if (!cert || !key) {
      this.logger.error('protocol.sms', 'Cannot download attachment: missing TLS credentials');
      return;
    }

    // Get phone IP from the control connection
    const phoneIp = connection.socket.remoteAddress;
    if (!phoneIp) {
      this.logger.error('protocol.sms', 'Cannot download attachment: no remote address');
      return;
    }

    // Find matching attachment in DB by filename (which matches unique_identifier)
    let matchedAttachment: AttachmentRow | undefined;
    if (filename) {
      const undownloaded = this.db.getUndownloadedAttachments();
      matchedAttachment = undownloaded.find(
        (a) => a.unique_identifier === filename,
      );
      if (!matchedAttachment) {
        this.logger.warn('protocol.sms', 'No DB match for attachment filename', {
          filename,
          undownloadedCount: undownloaded.length,
        });
      }
    }

    // Create attachments directory
    const attachDir = getAttachmentsDir();
    fs.mkdirSync(attachDir, { recursive: true });

    // Generate local filename
    const ext = filename ? path.extname(filename) : '';
    const safeName = matchedAttachment
      ? `${matchedAttachment.part_id}_${matchedAttachment.message_id}${ext || '.bin'}`
      : `${Date.now()}_${filename ?? 'attachment.bin'}`;
    const localPath = path.join(attachDir, safeName);

    this.logger.info('protocol.sms', 'Downloading attachment', {
      filename,
      matchedPartId: matchedAttachment?.part_id,
      matchedMessageId: matchedAttachment?.message_id,
      port,
      payloadSize,
      localPath,
    });

    // Open TLS connection to phone's payload port with timeout
    this.logger.info('protocol.sms', 'Opening TLS connection to phone payload port', {
      host: phoneIp,
      port,
      filename,
      matchedPartId: matchedAttachment?.part_id,
    });

    const payloadSocket = tls.connect({
      host: phoneIp,
      port,
      cert,
      key,
      rejectUnauthorized: false,
    });

    // Socket-level timeout — if no data arrives within the timeout, abort
    payloadSocket.setTimeout(SmsHandler.PAYLOAD_SOCKET_TIMEOUT);
    payloadSocket.on('timeout', () => {
      this.logger.warn('protocol.sms', 'Payload socket timed out', {
        filename,
        matchedPartId: matchedAttachment?.part_id,
        bytesReceived,
        expectedSize: payloadSize,
      });
      payloadSocket.destroy(new Error('Payload socket timed out'));
    });

    const writeStream = fs.createWriteStream(localPath);
    let bytesReceived = 0;

    payloadSocket.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      writeStream.write(chunk);
      // Reset timeout on each chunk of data received
      payloadSocket.setTimeout(SmsHandler.PAYLOAD_SOCKET_TIMEOUT);
    });

    payloadSocket.on('end', () => {
      writeStream.end(() => {
        this.logger.info('protocol.sms', 'Attachment file received', {
          localPath,
          bytesReceived,
          expectedSize: payloadSize,
          sizeMatch: bytesReceived === payloadSize,
          matchedPartId: matchedAttachment?.part_id,
          matchedMessageId: matchedAttachment?.message_id,
        });

        if (matchedAttachment) {
          this.db.markAttachmentDownloaded(
            matchedAttachment.part_id,
            matchedAttachment.message_id,
            localPath,
            bytesReceived,
          );
          this.logger.info('protocol.sms', 'Attachment marked downloaded in DB', {
            partId: matchedAttachment.part_id,
            messageId: matchedAttachment.message_id,
          });

          const partId = matchedAttachment.part_id;
          const messageId = matchedAttachment.message_id;
          const mime = matchedAttachment.mime_type;
          const isVideo = mime.startsWith('video/');

          const finalize = (finalPath: string): void => {
            // Generate video thumbnail if needed
            if (isVideo && !matchedAttachment.thumbnail_path) {
              this.generateVideoThumbnail(finalPath, partId, messageId);
            }

            this.fireAttachmentDownloaded(partId, messageId, finalPath);

            // Resolve any pending download promise
            const pendingKey = `${partId}:${messageId}`;
            const pending = this.pendingDownloads.get(pendingKey);
            if (pending) {
              this.pendingDownloads.delete(pendingKey);
              this.logger.info('protocol.sms', 'Pending download promise resolved', { partId, messageId });
              pending.resolve(finalPath);
            }
          };

          // Transcode videos with non-Chromium codecs (e.g. HEVC) to H.264
          if (isVideo) {
            this.needsTranscode(localPath, (needs) => {
              if (needs) {
                this.transcodeToMp4(localPath, partId, messageId, (transcodedPath) => {
                  if (transcodedPath) {
                    finalize(transcodedPath);
                  } else {
                    // Transcode failed — serve original, it may still play
                    finalize(localPath);
                  }
                });
              } else {
                finalize(localPath);
              }
            });
          } else {
            finalize(localPath);
          }
        } else {
          this.logger.warn('protocol.sms', 'Attachment file received but no DB match — cannot resolve pending download', {
            filename,
            bytesReceived,
          });
        }
      });
    });

    payloadSocket.on('error', (err) => {
      this.logger.error('protocol.sms', 'Attachment download socket error', {
        error: err.message,
        localPath,
        filename,
        matchedPartId: matchedAttachment?.part_id,
        bytesReceived,
        expectedSize: payloadSize,
      });
      writeStream.end();
      // Clean up partial file
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }

      if (matchedAttachment) {
        const pendingKey = `${matchedAttachment.part_id}:${matchedAttachment.message_id}`;
        const pending = this.pendingDownloads.get(pendingKey);
        if (pending) {
          this.pendingDownloads.delete(pendingKey);
          pending.reject(err);
        }
      }
    });
  }

  /**
   * Reject pending downloads that match a given filename (unique_identifier).
   * Used when attachment packets are malformed so promises don't hang.
   */
  private rejectPendingByFilename(filename: string | undefined, reason: string): void {
    if (!filename) return;
    const undownloaded = this.db.getUndownloadedAttachments();
    const matched = undownloaded.find((a) => a.unique_identifier === filename);
    if (matched) {
      const pendingKey = `${matched.part_id}:${matched.message_id}`;
      const pending = this.pendingDownloads.get(pendingKey);
      if (pending) {
        this.pendingDownloads.delete(pendingKey);
        this.logger.warn('protocol.sms', 'Rejecting pending download due to malformed packet', {
          partId: matched.part_id,
          messageId: matched.message_id,
          reason,
        });
        pending.reject(new Error(reason));
      }
    }
  }

  /**
   * Download an attachment on demand. Returns the local file path.
   * If already downloaded and file exists, returns cached path.
   * Otherwise queues a request — only one attachment is requested from the phone at a time.
   */
  async downloadAttachment(partId: number, messageId: number): Promise<string> {
    this.logger.info('protocol.sms', 'downloadAttachment called', { partId, messageId });

    // Check if already downloaded
    const att = this.db.getAttachment(partId, messageId);
    if (!att) {
      throw new Error(`Attachment not found: part_id=${partId}, message_id=${messageId}`);
    }

    if (att.downloaded && att.local_path) {
      // Verify file still exists on disk
      if (fs.existsSync(att.local_path)) {
        this.logger.debug('protocol.sms', 'Attachment already cached on disk', { partId, messageId, localPath: att.local_path });
        return att.local_path;
      }
      // File missing — re-download
      this.logger.warn('protocol.sms', 'Attachment file missing from disk, re-downloading', {
        partId,
        messageId,
        localPath: att.local_path,
      });
    }

    // Check if already queued or in-flight
    const pendingKey = `${partId}:${messageId}`;
    if (this.pendingDownloads.has(pendingKey)) {
      this.logger.debug('protocol.sms', 'Attachment download already in progress, waiting', { partId, messageId });
      // Return a new promise that piggybacks on the existing one
      return new Promise<string>((resolve, reject) => {
        const existing = this.pendingDownloads.get(pendingKey)!;
        const origResolve = existing.resolve;
        const origReject = existing.reject;
        this.pendingDownloads.set(pendingKey, {
          resolve: (path) => { origResolve(path); resolve(path); },
          reject: (err) => { origReject(err); reject(err); },
        });
      });
    }

    // Enqueue and process sequentially
    return new Promise<string>((resolve, reject) => {
      this.downloadQueue.push({
        partId,
        messageId,
        uniqueIdentifier: att.unique_identifier,
        resolve,
        reject,
      });
      this.logger.info('protocol.sms', 'Attachment queued for download', {
        partId,
        messageId,
        queueLength: this.downloadQueue.length,
        inFlight: this.downloadInFlight,
      });
      this.processDownloadQueue();
    });
  }

  /**
   * Process the next item in the download queue.
   * Only one download request is sent to the phone at a time.
   * If not connected, leaves items in queue — call resumeDownloads() on reconnect.
   */
  private processDownloadQueue(): void {
    if (this.downloadInFlight || this.downloadQueue.length === 0) return;

    // Don't dequeue if phone is not connected — wait for resumeDownloads()
    const conn = this.getConnection();
    if (!conn) {
      this.logger.info('protocol.sms', 'Download queue paused, waiting for connection', {
        queueLength: this.downloadQueue.length,
      });
      return;
    }

    const item = this.downloadQueue.shift()!;
    const pendingKey = `${item.partId}:${item.messageId}`;

    this.downloadInFlight = true;
    this.logger.info('protocol.sms', 'Processing download from queue', {
      partId: item.partId,
      messageId: item.messageId,
      remainingInQueue: this.downloadQueue.length,
    });

    // Set up pending download with timeout
    const timeout = setTimeout(() => {
      if (this.pendingDownloads.has(pendingKey)) {
        this.pendingDownloads.delete(pendingKey);
        this.logger.warn('protocol.sms', 'Attachment download timed out', {
          partId: item.partId,
          messageId: item.messageId,
        });
        item.reject(new Error('Attachment download timed out'));
        this.downloadInFlight = false;
        this.processDownloadQueue();
      }
    }, SmsHandler.DOWNLOAD_TIMEOUT);

    this.pendingDownloads.set(pendingKey, {
      resolve: (path) => {
        clearTimeout(timeout);
        item.resolve(path);
        this.downloadInFlight = false;
        this.processDownloadQueue();
      },
      reject: (err) => {
        clearTimeout(timeout);
        item.reject(err);
        this.downloadInFlight = false;
        this.processDownloadQueue();
      },
    });

    this.requestAttachment(item.partId, item.uniqueIdentifier);
  }

  /**
   * Resume processing the download queue after a reconnection.
   * Called by the daemon when the device connects.
   */
  resumeDownloads(): void {
    if (this.downloadQueue.length > 0) {
      this.logger.info('protocol.sms', 'Resuming download queue after reconnect', {
        queueLength: this.downloadQueue.length,
      });
      this.processDownloadQueue();
    }
  }

  // --- Deletion ---

  /**
   * Delete a message and its attachment files from disk and database.
   */
  deleteMessage(messageId: number): void {
    // Delete attachment files from disk
    const attachments = this.db.getAttachmentsForMessage(messageId);
    for (const att of attachments) {
      if (att.local_path) {
        try { fs.unlinkSync(att.local_path); } catch { /* ENOENT ok */ }
      }
    }

    this.db.deleteAttachmentsForMessage(messageId);
    this.db.deleteMessage(messageId);

    this.logger.info('protocol.sms', 'Message deleted', { messageId, attachmentsRemoved: attachments.length });
  }

  /**
   * Delete an entire conversation, all its messages, and all attachment files.
   */
  deleteConversation(threadId: number): void {
    // Get all messages to find attachments
    const messages = this.db.getThreadMessages(threadId);
    let filesRemoved = 0;

    for (const msg of messages) {
      const attachments = this.db.getAttachmentsForMessage(msg._id);
      for (const att of attachments) {
        if (att.local_path) {
          try { fs.unlinkSync(att.local_path); filesRemoved++; } catch { /* ENOENT ok */ }
        }
      }
    }

    this.db.deleteAttachmentsForThread(threadId);
    this.db.deleteThreadMessages(threadId);
    this.db.deleteConversation(threadId);

    this.logger.info('protocol.sms', 'Conversation deleted', {
      threadId,
      messagesRemoved: messages.length,
      filesRemoved,
    });
  }

  // --- Outgoing requests ---

  requestConversations(): void {
    const conn = this.getConnection();
    if (!conn) {
      this.logger.warn('protocol.sms', 'Cannot request conversations: not connected');
      return;
    }
    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_SMS_REQUEST_CONVERSATIONS, {})));
    this.logger.debug('protocol.sms', 'Requested conversations');
  }

  requestConversation(threadId: number, rangeStartTimestamp?: number): void {
    const conn = this.getConnection();
    if (!conn) {
      this.logger.warn('protocol.sms', 'Cannot request conversation: not connected');
      return;
    }
    const body: Record<string, unknown> = {
      threadID: threadId,
      numberToRequest: 100,
    };
    if (rangeStartTimestamp !== undefined) {
      body['rangeStartTimestamp'] = rangeStartTimestamp;
    }
    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_SMS_REQUEST_CONVERSATION, body)));
    this.logger.debug('protocol.sms', 'Requested conversation', { threadId, rangeStartTimestamp });
  }

  /**
   * Queue a message for sending. Tries immediately if connected,
   * otherwise waits for the next connection. Times out after 2 minutes.
   * Returns a queueId for tracking.
   */
  queueMessage(address: string, body: string): string {
    const queueId = `send_${++this.sendQueueCounter}_${Date.now()}`;

    const timeout = setTimeout(() => {
      if (this.sendQueue.has(queueId)) {
        this.sendQueue.delete(queueId);
        this.logger.warn('protocol.sms', 'Send timed out', { queueId, address });
        this.fireSendStatus(queueId, 'timeout');
      }
    }, 120_000); // 2 minutes

    this.sendQueue.set(queueId, { queueId, address, body, queuedAt: Date.now(), timeout });
    this.logger.info('protocol.sms', 'Message queued', { queueId, address });

    // Try to send immediately
    this.trySendQueued(queueId);
    return queueId;
  }

  /**
   * Cancel a queued message. Returns true if it was still pending.
   */
  cancelSend(queueId: string): boolean {
    const entry = this.sendQueue.get(queueId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.sendQueue.delete(queueId);
    this.logger.info('protocol.sms', 'Send cancelled', { queueId, address: entry.address });
    return true;
  }

  /**
   * Flush the send queue — call when the phone connects.
   * Sends with 500ms gaps to preserve message ordering.
   */
  flushSendQueue(): void {
    const queueIds = [...this.sendQueue.keys()];
    for (let i = 0; i < queueIds.length; i++) {
      if (i === 0) {
        this.trySendQueued(queueIds[i]!);
      } else {
        setTimeout(() => {
          this.trySendQueued(queueIds[i]!);
        }, i * 500);
      }
    }
  }

  private trySendQueued(queueId: string): void {
    const entry = this.sendQueue.get(queueId);
    if (!entry) return;

    const conn = this.getConnection();
    if (!conn) return;

    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_SMS_REQUEST, {
      sendSms: true,
      phoneNumber: entry.address,
      messageBody: entry.body,
    })));

    clearTimeout(entry.timeout);
    this.sendQueue.delete(queueId);
    this.logger.info('protocol.sms', 'SMS sent', { queueId, address: entry.address });
    this.fireSendStatus(queueId, 'sent');
  }

  requestAttachment(partId: number, uniqueIdentifier: string): void {
    const conn = this.getConnection();
    if (!conn) {
      this.logger.warn('protocol.sms', 'Cannot request attachment: not connected', { partId, uniqueIdentifier });
      // Reject pending download since we can't reach the phone
      for (const [key, pending] of this.pendingDownloads) {
        if (key.startsWith(`${partId}:`)) {
          this.pendingDownloads.delete(key);
          pending.reject(new Error('Cannot request attachment: not connected'));
          break;
        }
      }
      return;
    }
    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_SMS_REQUEST_ATTACHMENT, {
      part_id: partId,
      unique_identifier: uniqueIdentifier,
    })));
    this.logger.info('protocol.sms', 'Sent attachment request to phone', { partId, uniqueIdentifier });
  }

  // --- Callbacks ---

  onMessages(cb: MessagesCallback): void {
    this.messagesCallbacks.push(cb);
  }

  onConversationsUpdated(cb: ConversationsUpdatedCallback): void {
    this.conversationsUpdatedCallbacks.push(cb);
  }

  onAttachmentDownloaded(cb: AttachmentDownloadedCallback): void {
    this.attachmentDownloadedCallbacks.push(cb);
  }

  onSendStatus(cb: SendStatusCallback): void {
    this.sendStatusCallbacks.push(cb);
  }

  private fireMessages(threadId: number, messages: MessageRow[]): void {
    for (const cb of this.messagesCallbacks) {
      cb(threadId, messages);
    }
  }

  private fireConversationsUpdated(conversations: ConversationRow[]): void {
    for (const cb of this.conversationsUpdatedCallbacks) {
      cb(conversations);
    }
  }

  private fireAttachmentDownloaded(partId: number, messageId: number, localPath: string): void {
    for (const cb of this.attachmentDownloadedCallbacks) {
      cb(partId, messageId, localPath);
    }
  }

  private fireSendStatus(queueId: string, status: 'sent' | 'timeout'): void {
    for (const cb of this.sendStatusCallbacks) {
      cb(queueId, status);
    }
  }

  // --- Video transcoding & thumbnail generation ---

  /** Video codecs Chromium can play natively without transcoding */
  private static readonly NATIVE_VIDEO_CODECS = new Set([
    'h264', 'vp8', 'vp9', 'av1',
  ]);

  private static ffmpegPath: string | null | undefined = undefined;

  /**
   * Check if a video file needs transcoding by probing its codec.
   * Uses ffprobe (bundled with ffmpeg) to read the video stream codec.
   * If the codec is not Chromium-native (H.264, VP8, VP9, AV1), returns true.
   * On probe failure, returns true (safer to attempt transcode than skip).
   */
  private needsTranscode(videoPath: string, callback: (needs: boolean) => void): void {
    const ffmpeg = SmsHandler.findFfmpeg();
    if (!ffmpeg) {
      callback(false);
      return;
    }

    // ffprobe is alongside ffmpeg in the same directory
    const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

    const args = [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      videoPath,
    ];

    try {
      execFile(ffprobe, args, { timeout: 10000 }, (err, stdout) => {
        if (err) {
          this.logger.debug('protocol.sms', 'ffprobe failed, assuming transcode needed', {
            videoPath,
            error: err.message,
          });
          callback(true);
          return;
        }

        const codec = stdout.trim().toLowerCase();
        const native = SmsHandler.NATIVE_VIDEO_CODECS.has(codec);
        this.logger.info('protocol.sms', 'Video codec probed', {
          videoPath,
          codec,
          needsTranscode: !native,
        });
        callback(!native);
      });
    } catch (spawnErr) {
      this.logger.debug('protocol.sms', 'Failed to spawn ffprobe', {
        videoPath,
        error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
      callback(true);
    }
  }

  private static findFfmpeg(): string | null {
    if (SmsHandler.ffmpegPath !== undefined) return SmsHandler.ffmpegPath;

    // Check for bundled ffmpeg in Electron resources
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const bundled = path.join(resourcesPath, 'ffmpeg', `ffmpeg${ext}`);
      try {
        const stat = fs.statSync(bundled);
        if (stat.isFile() && stat.size > 0) {
          SmsHandler.ffmpegPath = bundled;
          return bundled;
        }
      } catch {
        // Not found or not accessible
      }
    }

    // Fall back to system ffmpeg (PATH)
    SmsHandler.ffmpegPath = 'ffmpeg';
    return 'ffmpeg';
  }

  /**
   * Transcode a video to H.264 MP4 for Chromium playback.
   * Uses CRF 18 (near-visually-lossless) with medium preset for a good
   * quality/size balance. MMS videos are typically short and low-res so
   * this runs quickly. Calls back with the new path on success, null on failure.
   */
  private transcodeToMp4(
    inputPath: string,
    partId: number,
    messageId: number,
    callback: (transcodedPath: string | null) => void,
  ): void {
    const ffmpeg = SmsHandler.findFfmpeg();
    if (!ffmpeg) {
      callback(null);
      return;
    }

    const attachDir = getAttachmentsDir();
    const outputPath = path.join(attachDir, `${partId}_${messageId}.mp4`);

    // Skip if already transcoded (e.g. from a previous attempt)
    if (inputPath === outputPath || fs.existsSync(outputPath)) {
      callback(outputPath);
      return;
    }

    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-crf', '18',
      '-preset', 'medium',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    this.logger.info('protocol.sms', 'Transcoding video to MP4', {
      partId,
      messageId,
      inputPath,
      outputPath,
    });

    try {
      execFile(ffmpeg, args, { timeout: 120000 }, (err) => {
        if (err) {
          this.logger.warn('protocol.sms', 'Video transcode failed', {
            partId,
            messageId,
            error: err.message,
          });
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'UNKNOWN') {
            SmsHandler.ffmpegPath = null;
          }
          // Clean up partial output
          try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
          callback(null);
          return;
        }

        this.logger.info('protocol.sms', 'Video transcoded to MP4', {
          partId,
          messageId,
          outputPath,
        });

        // Update DB with transcoded path and mime type
        try {
          this.db.updateAttachmentPath(partId, messageId, outputPath, 'video/mp4');
        } catch (dbErr) {
          this.logger.warn('protocol.sms', 'Failed to update attachment path after transcode', {
            partId,
            messageId,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }

        // Remove original file
        try { fs.unlinkSync(inputPath); } catch { /* ignore */ }

        callback(outputPath);
      });
    } catch (spawnErr) {
      this.logger.warn('protocol.sms', 'Failed to spawn ffmpeg for transcode', {
        partId,
        messageId,
        error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
      SmsHandler.ffmpegPath = null;
      callback(null);
    }
  }

  private generateVideoThumbnail(videoPath: string, partId: number, messageId: number): void {
    const ffmpeg = SmsHandler.findFfmpeg();
    if (!ffmpeg) return;

    const attachDir = getAttachmentsDir();
    const thumbPath = path.join(attachDir, `${partId}_${messageId}_thumb.webp`);

    // Extract first frame at full resolution, encode as WebP quality 90
    const args = [
      '-i', videoPath,
      '-ss', '00:00:00.500',
      '-frames:v', '1',
      '-c:v', 'libwebp',
      '-quality', '90',
      '-y',
      thumbPath,
    ];

    try {
      execFile(ffmpeg, args, { timeout: 15000 }, (err) => {
        if (err) {
          this.logger.debug('protocol.sms', 'ffmpeg thumbnail generation failed', {
            partId,
            messageId,
            error: err.message,
          });
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'UNKNOWN') {
            SmsHandler.ffmpegPath = null;
          }
          return;
        }

        try {
          this.db.setAttachmentThumbnail(partId, messageId, thumbPath);
          this.logger.info('protocol.sms', 'Video thumbnail generated', {
            partId,
            messageId,
            thumbPath,
          });
        } catch (dbErr) {
          this.logger.warn('protocol.sms', 'Failed to save thumbnail path to DB', {
            partId,
            messageId,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }
      });
    } catch (spawnErr) {
      this.logger.warn('protocol.sms', 'Failed to spawn ffmpeg for thumbnail', {
        partId,
        messageId,
        error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      });
      SmsHandler.ffmpegPath = null;
    }
  }
}
