/**
 * KDE Connect Packet Serialization
 *
 * Packet format: {"id": <timestamp_ms>, "type": "kdeconnect.<type>", "body": {...}}\n
 * All packets are newline-delimited JSON over TCP/TLS.
 */

import { ErrorCode, ProtocolError } from '../core/errors.js';

// Packet type constants
export const PACKET_TYPE_IDENTITY = 'kdeconnect.identity' as const;
export const PACKET_TYPE_PAIR = 'kdeconnect.pair' as const;
export const PACKET_TYPE_SMS_REQUEST = 'kdeconnect.sms.request' as const;
export const PACKET_TYPE_SMS_REQUEST_CONVERSATIONS = 'kdeconnect.sms.request_conversations' as const;
export const PACKET_TYPE_SMS_REQUEST_CONVERSATION = 'kdeconnect.sms.request_conversation' as const;
export const PACKET_TYPE_SMS_MESSAGES = 'kdeconnect.sms.messages' as const;
export const PACKET_TYPE_SMS_REQUEST_ATTACHMENT = 'kdeconnect.sms.request_attachment' as const;
export const PACKET_TYPE_SMS_ATTACHMENT_FILE = 'kdeconnect.sms.attachment_file' as const;
export const PACKET_TYPE_CONTACTS_REQUEST_ALL = 'kdeconnect.contacts.request_all_uids_timestamps' as const;
export const PACKET_TYPE_CONTACTS_REQUEST_VCARDS = 'kdeconnect.contacts.request_vcards_by_uid' as const;
export const PACKET_TYPE_CONTACTS_RESPONSE_UIDS = 'kdeconnect.contacts.response_uids_timestamps' as const;
export const PACKET_TYPE_CONTACTS_RESPONSE_VCARDS = 'kdeconnect.contacts.response_vcards' as const;
export const PACKET_TYPE_NOTIFICATION = 'kdeconnect.notification' as const;
export const PACKET_TYPE_PING = 'kdeconnect.ping' as const;
export const PACKET_TYPE_FINDMYPHONE_REQUEST = 'kdeconnect.findmyphone.request' as const;

export const PROTOCOL_VERSION = 8;

// Capabilities we advertise (from CLAUDE.md)
export const INCOMING_CAPABILITIES: readonly string[] = [
  'kdeconnect.sms.messages',
  'kdeconnect.sms.attachment_file',
  'kdeconnect.contacts.response_uids_timestamps',
  'kdeconnect.contacts.response_vcards',
  'kdeconnect.notification',
] as const;

export const OUTGOING_CAPABILITIES: readonly string[] = [
  'kdeconnect.sms.request',
  'kdeconnect.sms.request_conversations',
  'kdeconnect.sms.request_conversation',
  'kdeconnect.sms.request_attachment',
  'kdeconnect.contacts.request_all_uids_timestamps',
  'kdeconnect.contacts.request_vcards_by_uid',
  'kdeconnect.ping',
  'kdeconnect.findmyphone.request',
] as const;

// Interfaces
export interface NetworkPacket {
  id: number;
  type: string;
  body: Record<string, unknown>;
  payloadSize?: number;
  payloadTransferInfo?: Record<string, unknown>;
}

export interface IdentityBody {
  deviceId: string;
  deviceName: string;
  deviceType: 'desktop' | 'laptop' | 'phone' | 'tablet' | 'tv';
  protocolVersion: number;
  tcpPort: number;
  incomingCapabilities: string[];
  outgoingCapabilities: string[];
}

export interface PairBody {
  pair: boolean;
  timestamp?: number;
}

// Device ID validation regex: 32-38 alphanumeric + dash/underscore
const DEVICE_ID_REGEX = /^[a-zA-Z0-9_-]{32,38}$/;

/**
 * Validate a device ID string.
 */
export function isValidDeviceId(deviceId: string): boolean {
  return DEVICE_ID_REGEX.test(deviceId);
}

/**
 * Create a new packet with the current timestamp.
 */
export function createPacket(type: string, body: Record<string, unknown>): NetworkPacket {
  return {
    id: Date.now(),
    type,
    body,
  };
}

/**
 * Serialize a packet to a newline-delimited JSON string.
 */
export function serializePacket(packet: NetworkPacket): string {
  return JSON.stringify(packet) + '\n';
}

/**
 * Parse a packet from a JSON string.
 * Throws ProtocolError on invalid data.
 */
export function parsePacket(data: string): NetworkPacket {
  const trimmed = data.trim();
  if (trimmed.length === 0) {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_PACKET,
      'Empty packet data',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_PACKET,
      'Invalid JSON in packet',
      { data: trimmed.substring(0, 100) },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_PACKET,
      'Packet is not an object',
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['id'] !== 'number') {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_PACKET,
      'Packet missing numeric id field',
    );
  }

  if (typeof obj['type'] !== 'string') {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_PACKET,
      'Packet missing string type field',
    );
  }

  if (typeof obj['body'] !== 'object' || obj['body'] === null) {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_PACKET,
      'Packet missing object body field',
    );
  }

  return {
    id: obj['id'] as number,
    type: obj['type'] as string,
    body: obj['body'] as Record<string, unknown>,
    ...(typeof obj['payloadSize'] === 'number' ? { payloadSize: obj['payloadSize'] } : {}),
    ...(typeof obj['payloadTransferInfo'] === 'object' && obj['payloadTransferInfo'] !== null
      ? { payloadTransferInfo: obj['payloadTransferInfo'] as Record<string, unknown> }
      : {}),
  };
}

/**
 * Create an identity packet for this device.
 */
export function createIdentityPacket(options: {
  deviceId: string;
  deviceName: string;
  tcpPort: number;
}): NetworkPacket {
  return createPacket(PACKET_TYPE_IDENTITY, {
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    deviceType: 'desktop',
    protocolVersion: PROTOCOL_VERSION,
    tcpPort: options.tcpPort,
    incomingCapabilities: [...INCOMING_CAPABILITIES],
    outgoingCapabilities: [...OUTGOING_CAPABILITIES],
  });
}

/**
 * Validate an identity packet body and return typed IdentityBody.
 * Throws ProtocolError on invalid identity data.
 */
export function validateIdentityPacket(packet: NetworkPacket): IdentityBody {
  const body = packet.body;

  if (typeof body['deviceId'] !== 'string') {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_IDENTITY,
      'Identity packet missing deviceId',
    );
  }

  if (!isValidDeviceId(body['deviceId'])) {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_IDENTITY,
      `Invalid device ID format: ${body['deviceId']}`,
      { deviceId: body['deviceId'] },
    );
  }

  if (typeof body['deviceName'] !== 'string') {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_IDENTITY,
      'Identity packet missing deviceName',
    );
  }

  if (typeof body['deviceType'] !== 'string') {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_IDENTITY,
      'Identity packet missing deviceType',
    );
  }

  if (typeof body['protocolVersion'] !== 'number') {
    throw new ProtocolError(
      ErrorCode.PROTOCOL_INVALID_IDENTITY,
      'Identity packet missing protocolVersion',
    );
  }

  const tcpPort = typeof body['tcpPort'] === 'number' ? body['tcpPort'] : 0;

  return {
    deviceId: body['deviceId'],
    deviceName: body['deviceName'],
    deviceType: body['deviceType'] as IdentityBody['deviceType'],
    protocolVersion: body['protocolVersion'],
    tcpPort,
    incomingCapabilities: Array.isArray(body['incomingCapabilities'])
      ? (body['incomingCapabilities'] as string[])
      : [],
    outgoingCapabilities: Array.isArray(body['outgoingCapabilities'])
      ? (body['outgoingCapabilities'] as string[])
      : [],
  };
}
