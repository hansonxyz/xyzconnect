import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PacketRouter } from '../../../src/protocol/packet-router.js';
import type { DeviceConnection } from '../../../src/network/connection-manager.js';
import {
  createPacket,
  serializePacket,
  PACKET_TYPE_PAIR,
  PACKET_TYPE_PING,
} from '../../../src/network/packet.js';
import {
  resetLogger,
  initializeLogger,
  shutdownLogger,
} from '../../../src/utils/logger.js';
import { PassThrough } from 'node:stream';

describe('PacketRouter', () => {
  let logStream: PassThrough;
  let router: PacketRouter;

  beforeEach(() => {
    resetLogger();
    logStream = new PassThrough();
    initializeLogger({ level: 'debug', stream: logStream });

    router = new PacketRouter();
  });

  afterEach(async () => {
    await shutdownLogger();
    resetLogger();
    logStream.destroy();
  });

  function createMockConnection(): DeviceConnection {
    return {
      deviceId: 'test-device',
      deviceName: 'TestDevice',
      socket: new PassThrough() as unknown as DeviceConnection['socket'],
      protocolVersion: 8,
      peerCertPem: 'mock-cert',
      connected: true,
    };
  }

  it('routes packet to registered handler', () => {
    const conn = createMockConnection();
    const handler = vi.fn();
    router.registerHandler(PACKET_TYPE_PAIR, handler);

    const packet = createPacket(PACKET_TYPE_PAIR, { pair: true });
    router.route(serializePacket(packet), conn);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: PACKET_TYPE_PAIR }),
      conn,
    );
  });

  it('does not crash on unknown packet type', () => {
    const conn = createMockConnection();
    const packet = createPacket('kdeconnect.unknown.type', {});

    expect(() => {
      router.route(JSON.stringify(packet), conn);
    }).not.toThrow();
  });

  it('does not crash on invalid JSON', () => {
    const conn = createMockConnection();

    expect(() => {
      router.route('not valid json{{{', conn);
    }).not.toThrow();
  });

  it('handles multiple handlers for different types', () => {
    const conn = createMockConnection();
    const pairHandler = vi.fn();
    const pingHandler = vi.fn();
    router.registerHandler(PACKET_TYPE_PAIR, pairHandler);
    router.registerHandler(PACKET_TYPE_PING, pingHandler);

    const pairPacket = createPacket(PACKET_TYPE_PAIR, { pair: true });
    router.route(serializePacket(pairPacket), conn);

    expect(pairHandler).toHaveBeenCalledOnce();
    expect(pingHandler).not.toHaveBeenCalled();
  });

  it('handles data buffering with partial packets', () => {
    const conn = createMockConnection();
    const handler = vi.fn();
    router.registerHandler(PACKET_TYPE_PING, handler);

    const packet = createPacket(PACKET_TYPE_PING, {});
    const serialized = serializePacket(packet);

    // Split into two chunks
    const mid = Math.floor(serialized.length / 2);
    router.route(serialized.substring(0, mid), conn);
    expect(handler).not.toHaveBeenCalled();

    router.route(serialized.substring(mid), conn);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('handles multiple packets in a single chunk', () => {
    const conn = createMockConnection();
    const handler = vi.fn();
    router.registerHandler(PACKET_TYPE_PING, handler);

    const p1 = createPacket(PACKET_TYPE_PING, { seq: 1 });
    const p2 = createPacket(PACKET_TYPE_PING, { seq: 2 });
    const combined = serializePacket(p1) + serializePacket(p2);

    router.route(combined, conn);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('resets buffer for a connection when requested', () => {
    const conn = createMockConnection();
    const handler = vi.fn();
    router.registerHandler(PACKET_TYPE_PING, handler);

    const packet = createPacket(PACKET_TYPE_PING, {});
    const serialized = serializePacket(packet);

    // Send partial data
    router.route(serialized.substring(0, 10), conn);
    expect(handler).not.toHaveBeenCalled();

    // Reset buffer
    router.resetBuffer(conn.deviceId);

    // Send full packet — should work since buffer was cleared
    router.route(serialized, conn);
    expect(handler).toHaveBeenCalledOnce();
  });
});
