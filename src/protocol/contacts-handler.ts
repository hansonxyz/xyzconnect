/**
 * Contacts Protocol Handler
 *
 * Two-step contact sync:
 * 1. Send request_all_uids_timestamps → receive response_uids_timestamps
 * 2. Send request_vcards_by_uid with UIDs → receive response_vcards
 *
 * The UIDs response can come in two formats:
 * - Array format: { uids: string[] }
 * - Object format: { "uid1": timestamp, "uid2": timestamp, ... }
 *
 * vCards are returned as body keys (UID → vCard string), with a "uids" key to skip.
 */

import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import {
  createPacket,
  serializePacket,
  PACKET_TYPE_CONTACTS_REQUEST_ALL,
  PACKET_TYPE_CONTACTS_REQUEST_VCARDS,
} from '../network/packet.js';
import type { NetworkPacket } from '../network/packet.js';
import type { DeviceConnection } from '../network/connection-manager.js';
import type { DatabaseService, ContactRow } from '../database/database.js';

export interface ContactsHandlerOptions {
  db: DatabaseService;
  getConnection: () => DeviceConnection | undefined;
}

type UidsReceivedCallback = (uids: string[]) => void;
type ContactsUpdatedCallback = (contacts: ContactRow[]) => void;

/**
 * Parse a vCard string to extract name and phone numbers.
 */
export function parseVcard(vcard: string): { name: string; phoneNumbers: string[] } {
  const lines = vcard.split(/\r?\n/);
  let name = '';
  const phoneNumbers: string[] = [];

  for (const line of lines) {
    if (line.startsWith('FN:')) {
      name = line.substring(3).trim();
    } else if (line.toUpperCase().startsWith('TEL')) {
      // TEL;TYPE=CELL:+1234567890 or TEL:+1234567890
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const number = line.substring(colonIdx + 1).trim();
        if (number) {
          phoneNumbers.push(number);
        }
      }
    }
  }

  return { name, phoneNumbers };
}

export class ContactsHandler {
  private db: DatabaseService;
  private getConnection: () => DeviceConnection | undefined;
  private logger: Logger;
  private uidsReceivedCallbacks: UidsReceivedCallback[] = [];
  private contactsUpdatedCallbacks: ContactsUpdatedCallback[] = [];

  constructor(options: ContactsHandlerOptions) {
    this.db = options.db;
    this.getConnection = options.getConnection;
    this.logger = createLogger('contacts-handler');
  }

  /**
   * Handle kdeconnect.contacts.response_uids_timestamps.
   * Extracts UIDs and automatically requests vCards for all of them.
   */
  handleUidsResponse(packet: NetworkPacket, _connection: DeviceConnection): void {
    const body = packet.body;
    const uids: string[] = [];

    // Format 1: { uids: string[] }
    if (Array.isArray(body['uids'])) {
      for (const uid of body['uids'] as unknown[]) {
        if (typeof uid === 'string') {
          uids.push(uid);
        }
      }
    } else {
      // Format 2: { "uid1": timestamp, "uid2": timestamp, ... }
      for (const key of Object.keys(body)) {
        // Skip non-UID keys (timestamps are numeric values)
        if (typeof body[key] === 'number' || typeof body[key] === 'string') {
          uids.push(key);
        }
      }
    }

    this.logger.info('protocol.contacts', 'UIDs received', { count: uids.length });
    this.fireUidsReceived(uids);

    // Automatically request vCards for all UIDs
    if (uids.length > 0) {
      this.requestVcardsByUid(uids);
    }
  }

  /**
   * Handle kdeconnect.contacts.response_vcards.
   * Body keys are UIDs, values are vCard strings. "uids" key is skipped.
   */
  handleVcardsResponse(packet: NetworkPacket, _connection: DeviceConnection): void {
    const body = packet.body;
    const contacts: ContactRow[] = [];

    for (const uid of Object.keys(body)) {
      if (uid === 'uids') continue;

      const vcardStr = body[uid];
      if (typeof vcardStr !== 'string') continue;

      const parsed = parseVcard(vcardStr);
      if (!parsed.name) {
        this.logger.debug('protocol.contacts', 'Skipping contact with no name', { uid });
        continue;
      }

      contacts.push({
        uid,
        name: parsed.name,
        phone_numbers: JSON.stringify(parsed.phoneNumbers),
        timestamp: Date.now(),
      });
    }

    if (contacts.length > 0) {
      this.db.upsertContacts(contacts);
    }

    this.logger.info('protocol.contacts', 'Contacts synced', { count: contacts.length });
    this.fireContactsUpdated(contacts);
  }

  // --- Outgoing requests ---

  requestAllUidsTimestamps(): void {
    const conn = this.getConnection();
    if (!conn) {
      this.logger.warn('protocol.contacts', 'Cannot request contacts: not connected');
      return;
    }
    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_CONTACTS_REQUEST_ALL, {})));
    this.logger.debug('protocol.contacts', 'Requested all UIDs');
  }

  requestVcardsByUid(uids: string[]): void {
    const conn = this.getConnection();
    if (!conn) {
      this.logger.warn('protocol.contacts', 'Cannot request vCards: not connected');
      return;
    }
    conn.socket.write(serializePacket(createPacket(PACKET_TYPE_CONTACTS_REQUEST_VCARDS, { uids })));
    this.logger.debug('protocol.contacts', 'Requested vCards', { count: uids.length });
  }

  // --- Callbacks ---

  onUidsReceived(cb: UidsReceivedCallback): void {
    this.uidsReceivedCallbacks.push(cb);
  }

  onContactsUpdated(cb: ContactsUpdatedCallback): void {
    this.contactsUpdatedCallbacks.push(cb);
  }

  private fireUidsReceived(uids: string[]): void {
    for (const cb of this.uidsReceivedCallbacks) {
      cb(uids);
    }
  }

  private fireContactsUpdated(contacts: ContactRow[]): void {
    for (const cb of this.contactsUpdatedCallbacks) {
      cb(contacts);
    }
  }
}
