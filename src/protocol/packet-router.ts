/**
 * Packet Router
 *
 * Routes incoming TLS packets to registered handlers by packet type.
 * Handles data buffering for newline-delimited packets — a connection
 * may deliver partial data or multiple packets in one chunk.
 */

import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import { parsePacket } from '../network/packet.js';
import type { NetworkPacket } from '../network/packet.js';
import type { DeviceConnection } from '../network/connection-manager.js';

type PacketHandler = (packet: NetworkPacket, connection: DeviceConnection) => void;

export class PacketRouter {
  private handlers = new Map<string, PacketHandler>();
  private buffers = new Map<string, string>();
  private logger: Logger;

  constructor() {
    this.logger = createLogger('packet-router');
  }

  /**
   * Register a handler for a specific packet type.
   */
  registerHandler(packetType: string, handler: PacketHandler): void {
    this.handlers.set(packetType, handler);
  }

  /**
   * Route incoming data from a connection.
   * Buffers partial packets and dispatches complete ones.
   */
  route(data: string, connection: DeviceConnection): void {
    const deviceId = connection.deviceId;
    const existing = this.buffers.get(deviceId) ?? '';
    const buffer = existing + data;

    let remaining = buffer;
    let nlIdx = remaining.indexOf('\n');

    while (nlIdx !== -1) {
      const line = remaining.substring(0, nlIdx);
      remaining = remaining.substring(nlIdx + 1);

      if (line.trim().length > 0) {
        this.dispatchPacket(line, connection);
      }

      nlIdx = remaining.indexOf('\n');
    }

    // Store any remaining partial data
    if (remaining.length > 0) {
      this.buffers.set(deviceId, remaining);
    } else {
      this.buffers.delete(deviceId);
    }
  }

  /**
   * Reset the buffer for a specific device (e.g., on disconnect).
   */
  resetBuffer(deviceId: string): void {
    this.buffers.delete(deviceId);
  }

  private dispatchPacket(data: string, connection: DeviceConnection): void {
    let packet: NetworkPacket;
    try {
      packet = parsePacket(data);
    } catch (err) {
      this.logger.warn('protocol.router', 'Failed to parse packet', {
        deviceId: connection.deviceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const handler = this.handlers.get(packet.type);
    if (handler) {
      handler(packet, connection);
    } else {
      this.logger.debug('protocol.router', 'No handler for packet type', {
        type: packet.type,
        deviceId: connection.deviceId,
      });
    }
  }
}
