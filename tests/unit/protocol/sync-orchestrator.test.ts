import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SyncOrchestrator } from '../../../src/protocol/sync-orchestrator.js';
import { SmsHandler } from '../../../src/protocol/sms-handler.js';
import { ContactsHandler } from '../../../src/protocol/contacts-handler.js';
import { StateMachine, AppState } from '../../../src/core/state-machine.js';
import { DatabaseService } from '../../../src/database/database.js';
import { getDefaultConfig } from '../../../src/config/config.js';
import type { DaemonConfig } from '../../../src/config/config.js';
import type { DeviceConnection } from '../../../src/network/connection-manager.js';
import type { NetworkPacket } from '../../../src/network/packet.js';
import { initializeLogger, resetLogger } from '../../../src/utils/logger.js';

function createMockConnection(): DeviceConnection & { _written: string[] } {
  const written: string[] = [];
  return {
    deviceId: 'test-device-id-12345678901234567890',
    deviceName: 'Test Phone',
    socket: {
      write: (data: string) => { written.push(data); return true; },
      writable: true,
    } as unknown as DeviceConnection['socket'],
    protocolVersion: 8,
    peerCertPem: undefined,
    connected: true,
    _written: written,
  } as unknown as DeviceConnection & { _written: string[] };
}

function createMessagesPacket(threadId: number, count: number): NetworkPacket {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      _id: threadId * 100 + i,
      thread_id: threadId,
      addresses: [{ address: '+1555' }],
      body: `Message ${i}`,
      date: 1700000000000 + i * 1000,
      type: 1,
      read: 1,
    });
  }
  return { id: Date.now(), type: 'kdeconnect.sms.messages', body: { messages } };
}

describe('SyncOrchestrator', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let connection: DeviceConnection & { _written: string[] };
  let stateMachine: StateMachine;
  let smsHandler: SmsHandler;
  let contactsHandler: ContactsHandler;
  let config: DaemonConfig;
  let orchestrator: SyncOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    initializeLogger({ level: 'error', pretty: false });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-orch-test-'));
    db = new DatabaseService(path.join(tmpDir, 'test.db'));
    db.open();
    connection = createMockConnection();
    stateMachine = new StateMachine();

    config = getDefaultConfig();
    config.sync.silenceTimeout = 5000; // 5s for tests
    config.sync.syncInterval = 30000;

    smsHandler = new SmsHandler({
      db,
      getConnection: () => connection,
      getCert: () => 'mock-cert',
      getKey: () => 'mock-key',
    });
    contactsHandler = new ContactsHandler({
      db,
      getConnection: () => connection,
    });

    // Move state machine to CONNECTED
    stateMachine.transition(AppState.DISCONNECTED);
    stateMachine.transition(AppState.DISCOVERING);
    stateMachine.transition(AppState.CONNECTED, { deviceId: 'test', deviceName: 'Test' });

    orchestrator = new SyncOrchestrator({
      smsHandler,
      contactsHandler,
      stateMachine,
      config,
      db,
    });
  });

  afterEach(() => {
    orchestrator.destroy();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    resetLogger();
  });

  describe('startSync', () => {
    it('should transition to SYNCING state', () => {
      orchestrator.startSync();
      expect(stateMachine.getState()).toBe(AppState.SYNCING);
    });

    it('should set syncPhase to contacts', () => {
      orchestrator.startSync();
      expect(stateMachine.getContext().syncPhase).toBe('contacts');
    });

    it('should request contacts UIDs and conversations in parallel', () => {
      orchestrator.startSync();
      expect(connection._written).toHaveLength(2);
      const packets = connection._written.map((w) => JSON.parse(w) as NetworkPacket);
      expect(packets[0]!.type).toBe('kdeconnect.contacts.request_all_uids_timestamps');
      expect(packets[1]!.type).toBe('kdeconnect.sms.request_conversations');
    });

    it('should fire onSyncStarted callback', () => {
      let started = false;
      orchestrator.onSyncStarted(() => { started = true; });
      orchestrator.startSync();
      expect(started).toBe(true);
    });

    it('should set isSyncing to true', () => {
      expect(orchestrator.isSyncing()).toBe(false);
      orchestrator.startSync();
      expect(orchestrator.isSyncing()).toBe(true);
    });

    it('should not start if already syncing', () => {
      orchestrator.startSync();
      connection._written.length = 0;
      orchestrator.startSync(); // second call
      expect(connection._written).toHaveLength(0); // no duplicate requests
    });

    it('should not start from invalid state', () => {
      // Move to DISCONNECTED which can't transition to SYNCING
      stateMachine.transition(AppState.DISCONNECTED);
      orchestrator.startSync();
      expect(stateMachine.getState()).toBe(AppState.DISCONNECTED);
      expect(orchestrator.isSyncing()).toBe(false);
    });
  });

  describe('silence timeout', () => {
    it('should transition to READY after silence timeout', () => {
      orchestrator.startSync();
      expect(stateMachine.getState()).toBe(AppState.SYNCING);

      vi.advanceTimersByTime(5000);

      expect(stateMachine.getState()).toBe(AppState.READY);
      expect(orchestrator.isSyncing()).toBe(false);
    });

    it('should fire onSyncComplete when silence timeout fires', () => {
      let completed = false;
      orchestrator.onSyncComplete(() => { completed = true; });

      orchestrator.startSync();
      vi.advanceTimersByTime(5000);

      expect(completed).toBe(true);
    });

    it('should reset silence timer on incoming messages', () => {
      orchestrator.startSync();

      // 3 seconds in, messages arrive
      vi.advanceTimersByTime(3000);

      // Simulate messages arriving (this fires the smsHandler onMessages callback)
      smsHandler.handleMessages(createMessagesPacket(100, 5), connection);

      // 3 more seconds (6 total) — should not be READY yet because timer reset
      vi.advanceTimersByTime(3000);
      expect(stateMachine.getState()).toBe(AppState.SYNCING);

      // 2 more seconds (8 total, 5 since last message) — now should be READY
      vi.advanceTimersByTime(2000);
      expect(stateMachine.getState()).toBe(AppState.READY);
    });

    it('should record last sync timestamp', () => {
      orchestrator.startSync();
      vi.advanceTimersByTime(5000);

      const lastSync = db.getSyncState('lastSync');
      expect(lastSync).toBeDefined();
      expect(parseInt(lastSync!, 10)).toBeGreaterThan(0);
    });
  });

  describe('conversations phase', () => {
    it('should request conversations after contacts received', () => {
      orchestrator.startSync();
      connection._written.length = 0; // clear contacts request

      // Simulate contacts response arriving
      const contactsPacket: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: {
          'uid1': 'BEGIN:VCARD\nFN:Test\nTEL:+1555\nEND:VCARD',
        },
      };
      contactsHandler.handleVcardsResponse(contactsPacket, connection);

      // Should have sent a conversations request
      expect(connection._written.length).toBeGreaterThanOrEqual(1);
      const sentPackets = connection._written.map((w) => JSON.parse(w) as NetworkPacket);
      const conversationReq = sentPackets.find((p) => p.type === 'kdeconnect.sms.request_conversations');
      expect(conversationReq).toBeDefined();
    });
  });

  describe('stopSync', () => {
    it('should clear syncing state', () => {
      orchestrator.startSync();
      expect(orchestrator.isSyncing()).toBe(true);

      orchestrator.stopSync();
      expect(orchestrator.isSyncing()).toBe(false);
    });

    it('should prevent silence timeout from firing', () => {
      orchestrator.startSync();
      orchestrator.stopSync();

      vi.advanceTimersByTime(10000);
      // Should still be SYNCING (state was not changed by orchestrator)
      expect(stateMachine.getState()).toBe(AppState.SYNCING);
    });
  });

  describe('periodic re-sync', () => {
    it('should re-sync after syncInterval when in READY state', () => {
      orchestrator.startSync();
      vi.advanceTimersByTime(5000); // silence timeout → READY
      expect(stateMachine.getState()).toBe(AppState.READY);

      connection._written.length = 0;

      // Wait for re-sync interval
      vi.advanceTimersByTime(30000);

      // Should have started syncing again
      expect(stateMachine.getState()).toBe(AppState.SYNCING);
    });

    it('should not re-sync if autoSync is false', () => {
      config.sync.autoSync = false;

      const noAutoOrch = new SyncOrchestrator({
        smsHandler,
        contactsHandler,
        stateMachine,
        config,
        db,
      });

      noAutoOrch.startSync();
      vi.advanceTimersByTime(5000); // → READY
      expect(stateMachine.getState()).toBe(AppState.READY);

      connection._written.length = 0;
      vi.advanceTimersByTime(60000);

      // Should still be READY, no re-sync
      expect(stateMachine.getState()).toBe(AppState.READY);
      noAutoOrch.destroy();
    });
  });

  describe('destroy', () => {
    it('should stop syncing and clear all state', () => {
      orchestrator.startSync();
      orchestrator.destroy();

      expect(orchestrator.isSyncing()).toBe(false);

      // Silence timer should not fire
      vi.advanceTimersByTime(10000);
      expect(stateMachine.getState()).toBe(AppState.SYNCING); // not transitioned
    });

    it('should prevent future syncs', () => {
      orchestrator.destroy();
      orchestrator.startSync();
      expect(orchestrator.isSyncing()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle disconnect during sync gracefully', () => {
      orchestrator.startSync();
      expect(orchestrator.isSyncing()).toBe(true);

      // Simulate disconnect
      orchestrator.stopSync();
      stateMachine.transition(AppState.DISCONNECTED);

      expect(orchestrator.isSyncing()).toBe(false);
    });

    it('should handle startSync from READY state', () => {
      orchestrator.startSync();
      vi.advanceTimersByTime(5000); // → READY
      expect(stateMachine.getState()).toBe(AppState.READY);

      // Manual re-sync
      orchestrator.startSync();
      expect(stateMachine.getState()).toBe(AppState.SYNCING);
      expect(orchestrator.isSyncing()).toBe(true);
    });
  });
});
