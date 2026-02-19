/**
 * IPC Method Handlers
 *
 * Maps JSON-RPC method names to daemon operations. Registers both
 * request handlers (client → daemon) and notification wiring
 * (daemon events → broadcast to all clients).
 *
 * Provides reusable createMethodMap() and wireNotifications() for
 * both IPC server mode (standalone daemon) and embedded mode (Electron).
 */

import { createLogger } from '../utils/logger.js';
import { IpcServer } from './server.js';
import { createNotification } from './json-rpc.js';
import type { Daemon } from '../core/daemon.js';
import {
  loadKnownDevices,
  saveKnownDevice,
  removeKnownDevice,
} from '../config/known-devices.js';
import { createPacket, serializePacket, PACKET_TYPE_FINDMYPHONE_REQUEST } from '../network/packet.js';

const log = createLogger('ipc-handlers');

export type MethodHandler = (params?: Record<string, unknown>) => Promise<unknown>;
export type NotificationEmitter = (method: string, params: Record<string, unknown>) => void;

/**
 * Create a map of method name → handler function.
 * Used by both IPC server (standalone) and DaemonBridge (embedded).
 */
export function createMethodMap(daemon: Daemon): Map<string, MethodHandler> {
  const methods = new Map<string, MethodHandler>();

  methods.set('daemon.status', async () => {
    return daemon.getStatus();
  });

  methods.set('daemon.stop', async () => {
    // Defer stop so the caller gets a response first
    setTimeout(() => { void daemon.stop(); }, 100);
    return { ok: true };
  });

  methods.set('state.get', async () => {
    return { state: daemon.getStateMachine().getState() };
  });

  methods.set('state.context', async () => {
    return daemon.getStateMachine().getContext();
  });

  methods.set('state.history', async (params) => {
    const limit = (params?.['limit'] as number | undefined) ?? undefined;
    return daemon.getStateMachine().getHistory(limit);
  });

  methods.set('devices.discovered', async () => {
    const devices = daemon.getDiscoveryService().getDiscoveredDevices();
    return Array.from(devices.values());
  });

  methods.set('devices.paired', async () => {
    return daemon.getPairingHandler().loadTrustedDevices();
  });

  methods.set('devices.connected', async () => {
    return daemon.getConnectionManager().getConnectedDevices();
  });

  methods.set('devices.connect', async (params) => {
    const address = params?.['address'] as string | undefined;
    if (!address) {
      throw new Error('Missing required parameter: address');
    }
    const port = (params?.['port'] as number | undefined) ?? 1716;

    const mode = (params?.['mode'] as string | undefined) ?? 'udp';
    const discoveryService = daemon.getDiscoveryService();
    const connectionManager = daemon.getConnectionManager();

    if (mode === 'tcp') {
      // Direct TCP connect — works when phone is listening (e.g. LAN)
      connectionManager.connectToAddress(address, port);
    } else {
      // Send directed UDP identity to the phone. The phone will then
      // TCP-connect back to us (KDE Connect phones don't listen on TCP).
      discoveryService.sendDirectIdentity(address, port);
    }

    // Wait for the phone to connect back (up to 10 seconds)
    const result = await new Promise<{ deviceId: string; deviceName: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Connection to ${address}:${port} timed out — phone did not connect back`));
      }, 10000);

      const onConnect = (conn: { deviceId: string; deviceName: string }) => {
        cleanup();
        resolve({ deviceId: conn.deviceId, deviceName: conn.deviceName });
      };

      const cleanup = () => {
        clearTimeout(timeout);
      };

      connectionManager.onConnection(onConnect);
    });

    // Save to known devices
    saveKnownDevice({
      deviceId: result.deviceId,
      deviceName: result.deviceName,
      address,
      port,
    });

    return result;
  });

  methods.set('devices.known', async () => {
    return loadKnownDevices();
  });

  methods.set('devices.forget', async (params) => {
    const deviceId = params?.['deviceId'] as string | undefined;
    if (!deviceId) {
      throw new Error('Missing required parameter: deviceId');
    }
    removeKnownDevice(deviceId);
    return { ok: true };
  });

  methods.set('pair.request', async (params) => {
    const deviceId = params?.['deviceId'] as string | undefined;
    if (!deviceId) {
      throw new Error('Missing required parameter: deviceId');
    }

    const connectionManager = daemon.getConnectionManager();
    const pairingHandler = daemon.getPairingHandler();

    // Check if already connected
    const connection = connectionManager.getConnection(deviceId);

    if (connection) {
      return pairingHandler.requestPairing(connection);
    }

    // Not connected — need to connect and pair immediately on connection.
    // The phone drops unpaired connections very fast, so we must send the
    // pair packet inside the connection callback before the phone disconnects.
    const discoveryService = daemon.getDiscoveryService();
    const discovered = discoveryService.getDiscoveredDevices().get(deviceId);

    if (!discovered) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    // Register callback to pair immediately on connection, then initiate connect
    const result = await new Promise<{ verificationKey: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection to device ${deviceId} timed out`));
      }, 10000);

      connectionManager.onConnection((conn) => {
        if (conn.deviceId === deviceId) {
          clearTimeout(timeout);
          try {
            const pairResult = pairingHandler.requestPairing(conn);
            resolve(pairResult);
          } catch (err) {
            reject(err);
          }
        }
      });

      connectionManager.connectToDevice(discovered);
    });

    return result;
  });

  methods.set('pair.pending', async () => {
    return daemon.getPairingHandler().getPendingIncoming();
  });

  methods.set('pair.accept', async (params) => {
    const deviceId = params?.['deviceId'] as string | undefined;
    if (!deviceId) {
      throw new Error('Missing required parameter: deviceId');
    }

    daemon.getPairingHandler().acceptIncomingPairing(deviceId);
    return { ok: true };
  });

  methods.set('pair.reject', async (params) => {
    const deviceId = params?.['deviceId'] as string | undefined;
    if (!deviceId) {
      throw new Error('Missing required parameter: deviceId');
    }

    daemon.getPairingHandler().rejectIncomingPairing(deviceId);
    return { ok: true };
  });

  methods.set('pair.unpair', async (params) => {
    const deviceId = params?.['deviceId'] as string | undefined;
    if (!deviceId) {
      throw new Error('Missing required parameter: deviceId');
    }

    const connectionManager = daemon.getConnectionManager();
    const pairingHandler = daemon.getPairingHandler();
    const connection = connectionManager.getConnection(deviceId);

    pairingHandler.unpair(deviceId, connection);
    removeKnownDevice(deviceId);
    return { ok: true };
  });

  // --- SMS methods (Phase 5) ---

  methods.set('sms.conversations', async () => {
    return daemon.getDatabaseService().getAllConversations();
  });

  methods.set('sms.messages', async (params) => {
    const threadId = params?.['threadId'] as number | undefined;
    if (threadId === undefined) {
      throw new Error('Missing required parameter: threadId');
    }
    return daemon.getDatabaseService().getThreadMessages(threadId);
  });

  methods.set('sms.request_thread', async (params) => {
    const threadId = params?.['threadId'] as number | undefined;
    if (threadId === undefined) {
      throw new Error('Missing required parameter: threadId');
    }
    const rangeStartTimestamp = params?.['rangeStartTimestamp'] as number | undefined;
    daemon.getSmsHandler().requestConversation(threadId, rangeStartTimestamp);
    return { ok: true };
  });

  methods.set('sms.send', async (params) => {
    const address = params?.['address'] as string | undefined;
    const body = params?.['body'] as string | undefined;
    if (!address) {
      throw new Error('Missing required parameter: address');
    }
    if (!body) {
      throw new Error('Missing required parameter: body');
    }
    const queueId = daemon.getSmsHandler().queueMessage(address, body);
    return { queueId };
  });

  methods.set('sms.cancel_send', async (params) => {
    const queueId = params?.['queueId'] as string | undefined;
    if (!queueId) {
      throw new Error('Missing required parameter: queueId');
    }
    const cancelled = daemon.getSmsHandler().cancelSend(queueId);
    return { cancelled };
  });

  methods.set('sms.request_sync', async () => {
    daemon.getSyncOrchestrator().startSync();
    return { ok: true };
  });

  methods.set('sms.mark_thread_read', async (params) => {
    const threadId = params?.['threadId'] as number | undefined;
    if (threadId === undefined) {
      throw new Error('Missing required parameter: threadId');
    }
    daemon.getDatabaseService().markThreadLocallyRead(threadId);
    return { ok: true };
  });

  methods.set('sms.thread_attachments', async (params) => {
    const threadId = params?.['threadId'] as number | undefined;
    if (threadId === undefined) {
      throw new Error('Missing required parameter: threadId');
    }
    return daemon.getDatabaseService().getAttachmentsForThread(threadId);
  });

  methods.set('sms.attachment_path', async (params) => {
    const partId = params?.['partId'] as number | undefined;
    const messageId = params?.['messageId'] as number | undefined;
    if (partId === undefined || messageId === undefined) {
      throw new Error('Missing required parameters: partId, messageId');
    }
    const att = daemon.getDatabaseService().getAttachment(partId, messageId);
    if (!att || !att.local_path) return null;
    return { localPath: att.local_path, mimeType: att.mime_type };
  });

  methods.set('sms.attachment_thumbnail_path', async (params) => {
    const partId = params?.['partId'] as number | undefined;
    const messageId = params?.['messageId'] as number | undefined;
    if (partId === undefined || messageId === undefined) {
      throw new Error('Missing required parameters: partId, messageId');
    }
    const att = daemon.getDatabaseService().getAttachment(partId, messageId);
    if (!att || !att.thumbnail_path) return null;
    return { thumbnailPath: att.thumbnail_path, mimeType: 'image/webp' };
  });

  methods.set('sms.get_attachment', async (params) => {
    const partId = params?.['partId'] as number | undefined;
    const messageId = params?.['messageId'] as number | undefined;
    if (messageId === undefined) {
      throw new Error('Missing required parameter: messageId');
    }

    log.info('ipc.attachment', 'sms.get_attachment called', { partId, messageId });

    // If partId provided, download specific attachment
    if (partId !== undefined) {
      const localPath = await daemon.getSmsHandler().downloadAttachment(partId, messageId);
      const att = daemon.getDatabaseService().getAttachment(partId, messageId);
      log.info('ipc.attachment', 'sms.get_attachment completed', { partId, messageId, localPath });
      return {
        attachments: [{
          partId,
          localPath,
          mimeType: att?.mime_type ?? 'application/octet-stream',
          fileSize: att?.file_size ?? null,
        }],
      };
    }

    // No partId: download all attachments for the message
    const attachments = daemon.getDatabaseService().getAttachmentsForMessage(messageId);
    if (attachments.length === 0) {
      throw new Error(`No attachments found for message ${messageId}`);
    }

    log.info('ipc.attachment', 'Downloading all attachments for message', { messageId, count: attachments.length });
    const results = [];
    for (const att of attachments) {
      const localPath = await daemon.getSmsHandler().downloadAttachment(att.part_id, messageId);
      const updated = daemon.getDatabaseService().getAttachment(att.part_id, messageId);
      results.push({
        partId: att.part_id,
        localPath,
        mimeType: updated?.mime_type ?? att.mime_type,
        fileSize: updated?.file_size ?? att.file_size ?? null,
      });
    }
    log.info('ipc.attachment', 'sms.get_attachment completed (all)', { messageId, count: results.length });
    return { attachments: results };
  });

  methods.set('sms.delete_message', async (params) => {
    const messageId = params?.['messageId'] as number | undefined;
    if (messageId === undefined) {
      throw new Error('Missing required parameter: messageId');
    }
    daemon.getSmsHandler().deleteMessage(messageId);
    return { deleted: true };
  });

  methods.set('sms.delete_conversation', async (params) => {
    const threadId = params?.['threadId'] as number | undefined;
    if (threadId === undefined) {
      throw new Error('Missing required parameter: threadId');
    }
    daemon.getSmsHandler().deleteConversation(threadId);
    return { deleted: true };
  });

  // --- Contacts methods (Phase 5) ---

  methods.set('contacts.list', async () => {
    return daemon.getDatabaseService().getAllContacts();
  });

  methods.set('contacts.search', async (params) => {
    const query = params?.['query'] as string | undefined;
    if (!query) {
      throw new Error('Missing required parameter: query');
    }
    const all = daemon.getDatabaseService().getAllContacts();
    const lower = query.toLowerCase();
    return all.filter((c) => c.name.toLowerCase().includes(lower));
  });

  // --- Notifications methods (Phase 5) ---

  methods.set('notifications.list', async (params) => {
    const limit = (params?.['limit'] as number | undefined) ?? 50;
    return daemon.getDatabaseService().getRecentNotifications(limit);
  });

  // --- Find My Phone ---

  methods.set('phone.ring', async () => {
    const devices = daemon.getConnectionManager().getConnectedDevices();
    if (devices.length === 0) {
      throw new Error('No device connected');
    }
    const conn = daemon.getConnectionManager().getConnection(devices[0]!.deviceId);
    if (!conn) {
      throw new Error('No device connected');
    }
    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_FINDMYPHONE_REQUEST, {})));
    return { ok: true };
  });

  // --- Debug methods ---

  methods.set('debug.thread_info', async (params) => {
    const threadId = params?.['threadId'] as number | undefined;
    if (threadId === undefined) {
      throw new Error('Missing required parameter: threadId');
    }
    const db = daemon.getDatabaseService();
    const messages = db.getThreadMessages(threadId);
    const conversation = db.getConversation(threadId);
    const connected = daemon.getConnectionManager().getConnectedDevices();
    return {
      threadId,
      messageCount: messages.length,
      messageIds: messages.map((m) => m._id),
      oldestDate: messages.length > 0 ? messages[0]!.date : null,
      newestDate: messages.length > 0 ? messages[messages.length - 1]!.date : null,
      conversationExists: conversation !== null,
      connectedDevices: connected.length,
    };
  });

  return methods;
}

/**
 * Wire daemon events to a notification emitter.
 * Used by both IPC server (standalone) and DaemonBridge (embedded).
 */
export function wireNotifications(daemon: Daemon, emit: NotificationEmitter): void {
  // State machine transitions
  daemon.getStateMachine().onTransition((transition) => {
    emit('state.changed', {
      from: transition.from as string,
      to: transition.to as string,
      context: transition.context as unknown as Record<string, unknown>,
      timestamp: transition.timestamp,
    });
  });

  // Device discovery events
  const discoveryService = daemon.getDiscoveryService();

  discoveryService.onDeviceFound((device) => {
    emit('device.found', device as unknown as Record<string, unknown>);
  });

  discoveryService.onDeviceLost((deviceId) => {
    emit('device.lost', { deviceId });
  });

  // Connection events
  const connectionManager = daemon.getConnectionManager();

  connectionManager.onConnection((connection) => {
    emit('device.connected', {
      deviceId: connection.deviceId,
      deviceName: connection.deviceName,
    });
    // Flush any queued sends now that phone is connected
    daemon.getSmsHandler().flushSendQueue();
  });

  connectionManager.onDisconnection((deviceId) => {
    emit('device.disconnected', { deviceId });
  });

  // Incoming pairing requests
  daemon.getPairingHandler().onIncomingPairing((request) => {
    emit('pairing.incoming', request as unknown as Record<string, unknown>);
  });

  // Pairing events
  daemon.getPairingHandler().onPairingResult((deviceId, success, verificationKey) => {
    const params: Record<string, unknown> = { deviceId, success };
    if (verificationKey) {
      params['verificationKey'] = verificationKey;
    }
    emit('pairing.result', params);
  });

  // SMS events (Phase 5)
  daemon.getSmsHandler().onMessages((threadId, messages) => {
    const newestDate = messages.reduce((max, m) => Math.max(max, m.date), 0);
    emit('sms.messages', {
      threadId,
      count: messages.length,
      newestDate,
    });
  });

  daemon.getSmsHandler().onConversationsUpdated((conversations) => {
    emit('sms.conversations_updated', {
      count: conversations.length,
    });
  });

  daemon.getSmsHandler().onAttachmentDownloaded((partId, messageId, localPath) => {
    emit('sms.attachment_downloaded', {
      partId,
      messageId,
      localPath,
    });
  });

  daemon.getSmsHandler().onSendStatus((queueId, status) => {
    emit('sms.send_status', { queueId, status });
  });

  // Contact events (Phase 5)
  daemon.getContactsHandler().onContactsUpdated((contacts) => {
    emit('contacts.updated', {
      count: contacts.length,
    });
  });

  // Notification events (Phase 5)
  daemon.getNotificationHandler().onNotificationReceived((notif) => {
    emit('notification.received', {
      id: notif.id,
      appName: notif.app_name,
      title: notif.title,
      text: notif.text,
    });
  });

  daemon.getNotificationHandler().onNotificationDismissed((id) => {
    emit('notification.dismissed', { id });
  });

  // Sync events (Phase 5)
  daemon.getSyncOrchestrator().onSyncStarted(() => {
    emit('sync.started', {
      phase: daemon.getStateMachine().getContext().syncPhase ?? 'unknown',
    });
  });

  daemon.getSyncOrchestrator().onSyncComplete(() => {
    emit('sync.completed', {});
  });
}

/**
 * Register method handlers on an IPC server.
 * Uses createMethodMap internally — standalone daemon mode.
 */
export function registerHandlers(server: IpcServer, daemon: Daemon): void {
  const methods = createMethodMap(daemon);
  for (const [name, handler] of methods) {
    server.registerMethod(name, handler);
  }
  log.debug('ipc.handlers', 'Method handlers registered');
}

/**
 * Register notification wiring on an IPC server.
 * Uses wireNotifications internally — standalone daemon mode.
 */
export function registerNotifications(server: IpcServer, daemon: Daemon): void {
  wireNotifications(daemon, (method, params) => {
    server.broadcast(createNotification(method, params));
  });
  log.debug('ipc.handlers', 'Notification wiring registered');
}
