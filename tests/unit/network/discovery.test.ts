import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DiscoveryService,
} from '../../../src/network/discovery.js';
import type { DiscoveredDevice } from '../../../src/network/discovery.js';
import {
  createIdentityPacket,
  serializePacket,
  PROTOCOL_VERSION,
} from '../../../src/network/packet.js';
import {
  resetLogger,
  initializeLogger,
  shutdownLogger,
} from '../../../src/utils/logger.js';
import { PassThrough } from 'node:stream';

/**
 * Mock dgram socket for unit testing.
 * Extends EventEmitter to simulate dgram.Socket behavior.
 */
class MockSocket extends EventEmitter {
  public boundPort: number | undefined;
  public broadcastEnabled = false;
  public sentMessages: Array<{ buffer: Buffer; port: number; address: string }> = [];
  public closed = false;

  bind(port: number, callback?: () => void): this {
    this.boundPort = port;
    // Simulate async bind
    process.nextTick(() => {
      if (callback) callback();
      this.emit('listening');
    });
    return this;
  }

  setBroadcast(flag: boolean): void {
    this.broadcastEnabled = flag;
  }

  send(
    buffer: Buffer,
    _offset: number,
    _length: number,
    port: number,
    address: string,
    callback?: (err: Error | null) => void,
  ): void {
    this.sentMessages.push({ buffer, port, address });
    if (callback) callback(null);
  }

  close(callback?: () => void): void {
    this.closed = true;
    if (callback) process.nextTick(callback);
    process.nextTick(() => this.emit('close'));
  }

  address(): { address: string; family: string; port: number } {
    return { address: '0.0.0.0', family: 'udp4', port: this.boundPort ?? 1716 };
  }

  // Allow test to receive messages (unused in send path)
  ref(): this { return this; }
  unref(): this { return this; }
}

// Store reference to mock so tests can control it
let mockSocket: MockSocket;

vi.mock('node:dgram', () => ({
  createSocket: (_options: unknown) => {
    mockSocket = new MockSocket();
    return mockSocket;
  },
}));

describe('DiscoveryService', () => {
  let service: DiscoveryService;
  let logStream: PassThrough;

  const OUR_DEVICE_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
  const OUR_DEVICE_NAME = 'TestDesktop';
  const TCP_PORT = 1716;

  beforeEach(() => {
    resetLogger();
    logStream = new PassThrough();
    initializeLogger({ level: 'debug', stream: logStream });

    service = new DiscoveryService();
  });

  afterEach(async () => {
    service.stop();
    await shutdownLogger();
    resetLogger();
    logStream.destroy();
    vi.useRealTimers();
  });

  it('starts and binds UDP socket on port 1716', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);

    // Wait for bind
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockSocket.boundPort).toBe(1716);
    expect(mockSocket.broadcastEnabled).toBe(true);
  });

  it('broadcasts identity packet immediately on start', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);

    // Wait for bind and initial broadcast
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(mockSocket.sentMessages.length).toBeGreaterThanOrEqual(1);

    const sent = mockSocket.sentMessages[0]!;
    expect(sent.port).toBe(1716);
    expect(sent.address).toBe('255.255.255.255');

    // Parse the broadcast packet
    const packetStr = sent.buffer.toString('utf-8');
    const packet = JSON.parse(packetStr.trim());
    expect(packet.type).toBe('kdeconnect.identity');
    expect(packet.body.deviceId).toBe(OUR_DEVICE_ID);
    expect(packet.body.deviceName).toBe(OUR_DEVICE_NAME);
    expect(packet.body.tcpPort).toBe(TCP_PORT);
    expect(packet.body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('broadcasts periodically with fake timers', async () => {
    vi.useFakeTimers();

    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);

    // Trigger the bind event manually since fake timers affect nextTick
    await vi.advanceTimersByTimeAsync(10);

    const initialCount = mockSocket.sentMessages.length;
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Advance 5 seconds for next broadcast
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockSocket.sentMessages.length).toBeGreaterThan(initialCount);
  });

  it('parses incoming identity packet and tracks device', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const phoneDeviceId = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4';
    const phonePacket = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'MyPhone',
      tcpPort: 1740,
    });
    const data = serializePacket(phonePacket);

    // Simulate receiving a UDP packet
    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });

    // Give it a tick to process
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const devices = service.getDiscoveredDevices();
    expect(devices.size).toBe(1);
    expect(devices.has(phoneDeviceId)).toBe(true);

    const device = devices.get(phoneDeviceId)!;
    expect(device.deviceName).toBe('MyPhone');
    expect(device.deviceType).toBe('desktop'); // createIdentityPacket defaults to desktop
    expect(device.tcpPort).toBe(1740);
    expect(device.address).toBe('192.168.1.100');
    expect(device.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('fires onDeviceFound callback for new devices', async () => {
    const found: DiscoveredDevice[] = [];
    service.onDeviceFound((device) => found.push(device));

    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const phoneDeviceId = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4';
    const phonePacket = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'MyPhone',
      tcpPort: 1740,
    });
    const data = serializePacket(phonePacket);

    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(found.length).toBe(1);
    expect(found[0]!.deviceId).toBe(phoneDeviceId);
  });

  it('does not fire onDeviceFound for already-known device', async () => {
    const found: DiscoveredDevice[] = [];
    service.onDeviceFound((device) => found.push(device));

    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const phoneDeviceId = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4';
    const phonePacket = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'MyPhone',
      tcpPort: 1740,
    });
    const data = serializePacket(phonePacket);

    // Receive same device twice
    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(found.length).toBe(1);
  });

  it('updates lastSeen for known device', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const phoneDeviceId = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4';
    const phonePacket = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'MyPhone',
      tcpPort: 1740,
    });
    const data = serializePacket(phonePacket);

    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const firstSeen = service.getDiscoveredDevices().get(phoneDeviceId)!.lastSeen;

    // Wait a bit, then receive again
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const secondSeen = service.getDiscoveredDevices().get(phoneDeviceId)!.lastSeen;
    expect(secondSeen).toBeGreaterThanOrEqual(firstSeen);
  });

  it('ignores self-broadcasts', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const selfPacket = createIdentityPacket({
      deviceId: OUR_DEVICE_ID,
      deviceName: OUR_DEVICE_NAME,
      tcpPort: TCP_PORT,
    });
    const data = serializePacket(selfPacket);

    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.50', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(service.getDiscoveredDevices().size).toBe(0);
  });

  it('rejects invalid packets gracefully', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Invalid JSON
    mockSocket.emit('message', Buffer.from('not json\n'), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(service.getDiscoveredDevices().size).toBe(0);
  });

  it('rejects non-identity packets', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const packet = JSON.stringify({
      id: Date.now(),
      type: 'kdeconnect.pair',
      body: { pair: true },
    }) + '\n';

    mockSocket.emit('message', Buffer.from(packet), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(service.getDiscoveredDevices().size).toBe(0);
  });

  it('removes stale devices after timeout', async () => {
    vi.useFakeTimers();

    // Use short timeout and check interval for testing
    service = new DiscoveryService({ deviceLostTimeout: 500, reachabilityCheckInterval: 200 });
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await vi.advanceTimersByTimeAsync(10);

    const phoneDeviceId = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4';
    const phonePacket = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'MyPhone',
      tcpPort: 1740,
    });
    const data = serializePacket(phonePacket);

    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await vi.advanceTimersByTimeAsync(10);
    expect(service.getDiscoveredDevices().size).toBe(1);

    // Advance past device lost timeout + reachability check
    await vi.advanceTimersByTimeAsync(700);
    expect(service.getDiscoveredDevices().size).toBe(0);
  });

  it('fires onDeviceLost callback when device times out', async () => {
    vi.useFakeTimers();

    const lost: string[] = [];
    service = new DiscoveryService({ deviceLostTimeout: 500, reachabilityCheckInterval: 200 });
    service.onDeviceLost((deviceId) => lost.push(deviceId));

    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await vi.advanceTimersByTimeAsync(10);

    const phoneDeviceId = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4';
    const phonePacket = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'MyPhone',
      tcpPort: 1740,
    });
    const data = serializePacket(phonePacket);

    mockSocket.emit('message', Buffer.from(data), { address: '192.168.1.100', port: 1716 });
    await vi.advanceTimersByTimeAsync(10);

    // Advance past timeout + reachability check
    await vi.advanceTimersByTimeAsync(700);

    expect(lost).toEqual([phoneDeviceId]);
  });

  it('stop() closes socket and clears intervals', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    service.stop();

    expect(mockSocket.closed).toBe(true);
    expect(service.getDiscoveredDevices().size).toBe(0);
  });

  it('stop() is idempotent', () => {
    expect(() => {
      service.stop();
      service.stop();
    }).not.toThrow();
  });

  it('rejects identity packet with invalid deviceId format', async () => {
    service.start(OUR_DEVICE_ID, OUR_DEVICE_NAME, TCP_PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Valid packet structure but invalid deviceId (too short)
    const packet = JSON.stringify({
      id: Date.now(),
      type: 'kdeconnect.identity',
      body: {
        deviceId: 'short',
        deviceName: 'BadDevice',
        deviceType: 'phone',
        protocolVersion: 7,
        tcpPort: 1716,
        incomingCapabilities: [],
        outgoingCapabilities: [],
      },
    }) + '\n';

    mockSocket.emit('message', Buffer.from(packet), { address: '192.168.1.100', port: 1716 });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(service.getDiscoveredDevices().size).toBe(0);
  });
});
