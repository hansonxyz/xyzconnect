import { describe, it, expect } from 'vitest';
import {
  PACKET_TYPE_IDENTITY,
  PACKET_TYPE_PAIR,
  PACKET_TYPE_SMS_REQUEST,
  PACKET_TYPE_SMS_REQUEST_CONVERSATIONS,
  PACKET_TYPE_SMS_REQUEST_CONVERSATION,
  PACKET_TYPE_SMS_MESSAGES,
  PACKET_TYPE_SMS_REQUEST_ATTACHMENT,
  PACKET_TYPE_SMS_ATTACHMENT_FILE,
  PACKET_TYPE_CONTACTS_REQUEST_ALL,
  PACKET_TYPE_CONTACTS_REQUEST_VCARDS,
  PACKET_TYPE_CONTACTS_RESPONSE_UIDS,
  PACKET_TYPE_CONTACTS_RESPONSE_VCARDS,
  PACKET_TYPE_NOTIFICATION,
  PACKET_TYPE_PING,
  PROTOCOL_VERSION,
  INCOMING_CAPABILITIES,
  OUTGOING_CAPABILITIES,
  createPacket,
  serializePacket,
  parsePacket,
  createIdentityPacket,
  validateIdentityPacket,
  isValidDeviceId,
} from '../../../src/network/packet.js';
import { ProtocolError } from '../../../src/core/errors.js';

describe('packet constants', () => {
  it('PROTOCOL_VERSION is 8', () => {
    expect(PROTOCOL_VERSION).toBe(8);
  });

  it('packet type constants have correct values', () => {
    expect(PACKET_TYPE_IDENTITY).toBe('kdeconnect.identity');
    expect(PACKET_TYPE_PAIR).toBe('kdeconnect.pair');
    expect(PACKET_TYPE_SMS_REQUEST).toBe('kdeconnect.sms.request');
    expect(PACKET_TYPE_SMS_REQUEST_CONVERSATIONS).toBe('kdeconnect.sms.request_conversations');
    expect(PACKET_TYPE_SMS_REQUEST_CONVERSATION).toBe('kdeconnect.sms.request_conversation');
    expect(PACKET_TYPE_SMS_MESSAGES).toBe('kdeconnect.sms.messages');
    expect(PACKET_TYPE_SMS_REQUEST_ATTACHMENT).toBe('kdeconnect.sms.request_attachment');
    expect(PACKET_TYPE_SMS_ATTACHMENT_FILE).toBe('kdeconnect.sms.attachment_file');
    expect(PACKET_TYPE_CONTACTS_REQUEST_ALL).toBe('kdeconnect.contacts.request_all_uids_timestamps');
    expect(PACKET_TYPE_CONTACTS_REQUEST_VCARDS).toBe('kdeconnect.contacts.request_vcards_by_uid');
    expect(PACKET_TYPE_CONTACTS_RESPONSE_UIDS).toBe('kdeconnect.contacts.response_uids_timestamps');
    expect(PACKET_TYPE_CONTACTS_RESPONSE_VCARDS).toBe('kdeconnect.contacts.response_vcards');
    expect(PACKET_TYPE_NOTIFICATION).toBe('kdeconnect.notification');
    expect(PACKET_TYPE_PING).toBe('kdeconnect.ping');
  });

  it('INCOMING_CAPABILITIES matches CLAUDE.md spec', () => {
    expect(INCOMING_CAPABILITIES).toContain('kdeconnect.sms.messages');
    expect(INCOMING_CAPABILITIES).toContain('kdeconnect.sms.attachment_file');
    expect(INCOMING_CAPABILITIES).toContain('kdeconnect.contacts.response_uids_timestamps');
    expect(INCOMING_CAPABILITIES).toContain('kdeconnect.contacts.response_vcards');
    expect(INCOMING_CAPABILITIES).toContain('kdeconnect.notification');
    expect(INCOMING_CAPABILITIES).toHaveLength(5);
  });

  it('OUTGOING_CAPABILITIES matches CLAUDE.md spec', () => {
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.sms.request');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.sms.request_conversations');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.sms.request_conversation');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.sms.request_attachment');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.contacts.request_all_uids_timestamps');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.contacts.request_vcards_by_uid');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.ping');
    expect(OUTGOING_CAPABILITIES).toContain('kdeconnect.findmyphone.request');
    expect(OUTGOING_CAPABILITIES).toHaveLength(8);
  });
});

describe('createPacket', () => {
  it('returns packet with correct type and body', () => {
    const packet = createPacket('kdeconnect.ping', { message: 'hello' });
    expect(packet.type).toBe('kdeconnect.ping');
    expect(packet.body).toEqual({ message: 'hello' });
  });

  it('sets id as a number (timestamp)', () => {
    const before = Date.now();
    const packet = createPacket('kdeconnect.ping', {});
    const after = Date.now();
    expect(typeof packet.id).toBe('number');
    expect(packet.id).toBeGreaterThanOrEqual(before);
    expect(packet.id).toBeLessThanOrEqual(after);
  });
});

describe('serializePacket', () => {
  it('produces JSON string ending with newline', () => {
    const packet = createPacket('kdeconnect.ping', {});
    const serialized = serializePacket(packet);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.indexOf('\n')).toBe(serialized.length - 1);
  });

  it('produces valid JSON (minus trailing newline)', () => {
    const packet = createPacket('kdeconnect.ping', { key: 'value' });
    const serialized = serializePacket(packet);
    const parsed = JSON.parse(serialized.trimEnd());
    expect(parsed.type).toBe('kdeconnect.ping');
    expect(parsed.body.key).toBe('value');
  });
});

describe('parsePacket', () => {
  it('roundtrips with serializePacket', () => {
    const original = createPacket('kdeconnect.pair', { pair: true });
    const serialized = serializePacket(original);
    const parsed = parsePacket(serialized);
    expect(parsed.id).toBe(original.id);
    expect(parsed.type).toBe(original.type);
    expect(parsed.body).toEqual(original.body);
  });

  it('handles data with trailing newline', () => {
    const json = '{"id":12345,"type":"kdeconnect.ping","body":{}}\n';
    const packet = parsePacket(json);
    expect(packet.type).toBe('kdeconnect.ping');
  });

  it('handles data without trailing newline', () => {
    const json = '{"id":12345,"type":"kdeconnect.ping","body":{}}';
    const packet = parsePacket(json);
    expect(packet.type).toBe('kdeconnect.ping');
  });

  it('throws ProtocolError on empty string', () => {
    expect(() => parsePacket('')).toThrow(ProtocolError);
  });

  it('throws ProtocolError on invalid JSON', () => {
    expect(() => parsePacket('not json')).toThrow(ProtocolError);
  });

  it('throws ProtocolError on missing id', () => {
    expect(() => parsePacket('{"type":"kdeconnect.ping","body":{}}')).toThrow(ProtocolError);
  });

  it('throws ProtocolError on missing type', () => {
    expect(() => parsePacket('{"id":123,"body":{}}')).toThrow(ProtocolError);
  });

  it('throws ProtocolError on missing body', () => {
    expect(() => parsePacket('{"id":123,"type":"kdeconnect.ping"}')).toThrow(ProtocolError);
  });

  it('throws ProtocolError on null body', () => {
    expect(() => parsePacket('{"id":123,"type":"kdeconnect.ping","body":null}')).toThrow(ProtocolError);
  });
});

describe('isValidDeviceId', () => {
  it('accepts 32-char hex string', () => {
    expect(isValidDeviceId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true);
  });

  it('accepts 38-char string with dashes and underscores', () => {
    expect(isValidDeviceId('a1b2c3d4-e5f6-a1b2-c3d4-e5f6a1b2c3d4')).toBe(true);
  });

  it('accepts 36-char UUID format', () => {
    expect(isValidDeviceId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects string shorter than 32 chars', () => {
    expect(isValidDeviceId('abc123')).toBe(false);
  });

  it('rejects string longer than 38 chars', () => {
    expect(isValidDeviceId('a'.repeat(39))).toBe(false);
  });

  it('rejects string with special characters', () => {
    expect(isValidDeviceId('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d!')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidDeviceId('')).toBe(false);
  });
});

describe('createIdentityPacket', () => {
  it('creates a valid identity packet', () => {
    const packet = createIdentityPacket({
      deviceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      deviceName: 'TestPC',
      tcpPort: 1716,
    });

    expect(packet.type).toBe(PACKET_TYPE_IDENTITY);
    expect(typeof packet.id).toBe('number');
    expect(packet.body['deviceId']).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
    expect(packet.body['deviceName']).toBe('TestPC');
    expect(packet.body['deviceType']).toBe('desktop');
    expect(packet.body['protocolVersion']).toBe(PROTOCOL_VERSION);
    expect(packet.body['tcpPort']).toBe(1716);
    expect(packet.body['incomingCapabilities']).toEqual(INCOMING_CAPABILITIES);
    expect(packet.body['outgoingCapabilities']).toEqual(OUTGOING_CAPABILITIES);
  });
});

describe('validateIdentityPacket', () => {
  function makeIdentityPacket(overrides?: Record<string, unknown>) {
    return createPacket(PACKET_TYPE_IDENTITY, {
      deviceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      deviceName: 'TestPhone',
      deviceType: 'phone',
      protocolVersion: 7,
      tcpPort: 1716,
      incomingCapabilities: [],
      outgoingCapabilities: [],
      ...overrides,
    });
  }

  it('accepts a valid identity packet and returns typed body', () => {
    const packet = makeIdentityPacket();
    const identity = validateIdentityPacket(packet);
    expect(identity.deviceId).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
    expect(identity.deviceName).toBe('TestPhone');
    expect(identity.deviceType).toBe('phone');
    expect(identity.protocolVersion).toBe(7);
    expect(identity.tcpPort).toBe(1716);
  });

  it('throws ProtocolError on missing deviceId', () => {
    const packet = makeIdentityPacket();
    delete (packet.body as Record<string, unknown>)['deviceId'];
    expect(() => validateIdentityPacket(packet)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on invalid deviceId format', () => {
    const packet = makeIdentityPacket({ deviceId: 'short' });
    expect(() => validateIdentityPacket(packet)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on missing deviceName', () => {
    const packet = makeIdentityPacket();
    delete (packet.body as Record<string, unknown>)['deviceName'];
    expect(() => validateIdentityPacket(packet)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on missing protocolVersion', () => {
    const packet = makeIdentityPacket();
    delete (packet.body as Record<string, unknown>)['protocolVersion'];
    expect(() => validateIdentityPacket(packet)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on missing deviceType', () => {
    const packet = makeIdentityPacket();
    delete (packet.body as Record<string, unknown>)['deviceType'];
    expect(() => validateIdentityPacket(packet)).toThrow(ProtocolError);
  });
});
