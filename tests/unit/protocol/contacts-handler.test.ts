import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContactsHandler, parseVcard } from '../../../src/protocol/contacts-handler.js';
import { DatabaseService } from '../../../src/database/database.js';
import type { NetworkPacket } from '../../../src/network/packet.js';
import type { DeviceConnection } from '../../../src/network/connection-manager.js';
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

describe('parseVcard', () => {
  it('should extract name from FN line', () => {
    const result = parseVcard('BEGIN:VCARD\nFN:John Doe\nEND:VCARD');
    expect(result.name).toBe('John Doe');
  });

  it('should extract phone numbers from TEL lines', () => {
    const result = parseVcard(
      'BEGIN:VCARD\nFN:Jane\nTEL;TYPE=CELL:+15551234567\nTEL;TYPE=HOME:+15559876543\nEND:VCARD',
    );
    expect(result.phoneNumbers).toEqual(['+15551234567', '+15559876543']);
  });

  it('should handle TEL without TYPE', () => {
    const result = parseVcard('BEGIN:VCARD\nFN:Test\nTEL:+15551111111\nEND:VCARD');
    expect(result.phoneNumbers).toEqual(['+15551111111']);
  });

  it('should return empty name for vCard without FN', () => {
    const result = parseVcard('BEGIN:VCARD\nTEL:+15551234567\nEND:VCARD');
    expect(result.name).toBe('');
  });

  it('should return empty phone numbers for vCard without TEL', () => {
    const result = parseVcard('BEGIN:VCARD\nFN:No Phone\nEND:VCARD');
    expect(result.phoneNumbers).toEqual([]);
  });

  it('should handle Windows-style line endings', () => {
    const result = parseVcard('BEGIN:VCARD\r\nFN:Windows User\r\nTEL:+15551234567\r\nEND:VCARD');
    expect(result.name).toBe('Windows User');
    expect(result.phoneNumbers).toEqual(['+15551234567']);
  });

  it('should handle multiple phone types', () => {
    const vcard = [
      'BEGIN:VCARD',
      'FN:Multi Phone',
      'TEL;TYPE=CELL:+15551111111',
      'TEL;TYPE=WORK:+15552222222',
      'TEL;TYPE=HOME;TYPE=VOICE:+15553333333',
      'END:VCARD',
    ].join('\n');

    const result = parseVcard(vcard);
    expect(result.phoneNumbers).toHaveLength(3);
  });

  it('should handle empty vCard', () => {
    const result = parseVcard('');
    expect(result.name).toBe('');
    expect(result.phoneNumbers).toEqual([]);
  });
});

describe('ContactsHandler', () => {
  let tmpDir: string;
  let db: DatabaseService;
  let connection: DeviceConnection & { _written: string[] };
  let handler: ContactsHandler;

  beforeEach(() => {
    initializeLogger({ level: 'error', pretty: false });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-handler-test-'));
    db = new DatabaseService(path.join(tmpDir, 'test.db'));
    db.open();
    connection = createMockConnection();

    handler = new ContactsHandler({
      db,
      getConnection: () => connection,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetLogger();
  });

  describe('handleUidsResponse', () => {
    it('should parse UIDs in array format', () => {
      let receivedUids: string[] = [];
      handler.onUidsReceived((uids) => { receivedUids = uids; });

      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_uids_timestamps',
        body: { uids: ['uid1', 'uid2', 'uid3'] },
      };

      handler.handleUidsResponse(packet, connection);
      expect(receivedUids).toEqual(['uid1', 'uid2', 'uid3']);
    });

    it('should parse UIDs in object format (uid: timestamp)', () => {
      let receivedUids: string[] = [];
      handler.onUidsReceived((uids) => { receivedUids = uids; });

      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_uids_timestamps',
        body: { 'uid1': 1700000000, 'uid2': 1700000001 },
      };

      handler.handleUidsResponse(packet, connection);
      expect(receivedUids).toContain('uid1');
      expect(receivedUids).toContain('uid2');
    });

    it('should automatically request vCards after receiving UIDs', () => {
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_uids_timestamps',
        body: { uids: ['uid1', 'uid2'] },
      };

      handler.handleUidsResponse(packet, connection);

      expect(connection._written).toHaveLength(1);
      const sentPacket = JSON.parse(connection._written[0]!) as NetworkPacket;
      expect(sentPacket.type).toBe('kdeconnect.contacts.request_vcards_by_uid');
      expect(sentPacket.body['uids']).toEqual(['uid1', 'uid2']);
    });

    it('should not request vCards when no UIDs', () => {
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_uids_timestamps',
        body: { uids: [] },
      };

      handler.handleUidsResponse(packet, connection);
      expect(connection._written).toHaveLength(0);
    });
  });

  describe('handleVcardsResponse', () => {
    it('should parse vCards and persist contacts', () => {
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: {
          'uid1': 'BEGIN:VCARD\nFN:John Doe\nTEL:+15551234567\nEND:VCARD',
          'uid2': 'BEGIN:VCARD\nFN:Jane Smith\nTEL:+15559876543\nEND:VCARD',
          'uids': ['uid1', 'uid2'],
        },
      };

      handler.handleVcardsResponse(packet, connection);

      expect(db.getContactCount()).toBe(2);
      const john = db.getContact('uid1');
      expect(john).toBeDefined();
      expect(john!.name).toBe('John Doe');
      expect(JSON.parse(john!.phone_numbers)).toEqual(['+15551234567']);
    });

    it('should skip contacts with no name', () => {
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: {
          'uid1': 'BEGIN:VCARD\nTEL:+15551234567\nEND:VCARD',
          'uids': ['uid1'],
        },
      };

      handler.handleVcardsResponse(packet, connection);
      expect(db.getContactCount()).toBe(0);
    });

    it('should skip the "uids" key', () => {
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: {
          'uid1': 'BEGIN:VCARD\nFN:Test\nTEL:+1555\nEND:VCARD',
          'uids': ['uid1'],
        },
      };

      handler.handleVcardsResponse(packet, connection);
      expect(db.getContactCount()).toBe(1);
      // Should not have a contact with uid 'uids'
      expect(db.getContact('uids')).toBeUndefined();
    });

    it('should handle contact with multiple phone numbers', () => {
      const vcard = 'BEGIN:VCARD\nFN:Multi Phone\nTEL;TYPE=CELL:+15551111111\nTEL;TYPE=HOME:+15552222222\nEND:VCARD';
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: { 'uid1': vcard },
      };

      handler.handleVcardsResponse(packet, connection);

      const contact = db.getContact('uid1');
      expect(contact).toBeDefined();
      const numbers = JSON.parse(contact!.phone_numbers) as string[];
      expect(numbers).toHaveLength(2);
    });

    it('should fire onContactsUpdated callback', () => {
      let receivedCount = 0;
      handler.onContactsUpdated((contacts) => { receivedCount = contacts.length; });

      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: {
          'uid1': 'BEGIN:VCARD\nFN:Test\nTEL:+1555\nEND:VCARD',
        },
      };

      handler.handleVcardsResponse(packet, connection);
      expect(receivedCount).toBe(1);
    });

    it('should update existing contacts', () => {
      // First sync
      const packet1: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: { 'uid1': 'BEGIN:VCARD\nFN:Old Name\nTEL:+1555\nEND:VCARD' },
      };
      handler.handleVcardsResponse(packet1, connection);
      expect(db.getContact('uid1')!.name).toBe('Old Name');

      // Second sync
      const packet2: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: { 'uid1': 'BEGIN:VCARD\nFN:New Name\nTEL:+1555\nEND:VCARD' },
      };
      handler.handleVcardsResponse(packet2, connection);
      expect(db.getContact('uid1')!.name).toBe('New Name');
    });

    it('should skip non-string vCard values', () => {
      const packet: NetworkPacket = {
        id: Date.now(),
        type: 'kdeconnect.contacts.response_vcards',
        body: {
          'uid1': 12345, // not a string
          'uid2': 'BEGIN:VCARD\nFN:Valid\nTEL:+1555\nEND:VCARD',
        },
      };

      handler.handleVcardsResponse(packet, connection);
      expect(db.getContactCount()).toBe(1);
    });
  });

  describe('outgoing requests', () => {
    it('should send requestAllUidsTimestamps packet', () => {
      handler.requestAllUidsTimestamps();
      expect(connection._written).toHaveLength(1);
      const packet = JSON.parse(connection._written[0]!) as NetworkPacket;
      expect(packet.type).toBe('kdeconnect.contacts.request_all_uids_timestamps');
    });

    it('should send requestVcardsByUid packet with UIDs', () => {
      handler.requestVcardsByUid(['uid1', 'uid2', 'uid3']);
      expect(connection._written).toHaveLength(1);
      const packet = JSON.parse(connection._written[0]!) as NetworkPacket;
      expect(packet.type).toBe('kdeconnect.contacts.request_vcards_by_uid');
      expect(packet.body['uids']).toEqual(['uid1', 'uid2', 'uid3']);
    });

    it('should not throw when not connected', () => {
      const disconnectedHandler = new ContactsHandler({
        db,
        getConnection: () => undefined,
      });
      disconnectedHandler.requestAllUidsTimestamps();
      disconnectedHandler.requestVcardsByUid(['uid1']);
    });
  });
});
