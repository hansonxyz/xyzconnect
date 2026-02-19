import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as tls from 'node:tls';
import {
  ConnectionManager,
} from '../../../src/network/connection-manager.js';
import type { DeviceConnection } from '../../../src/network/connection-manager.js';
import type { DiscoveredDevice } from '../../../src/network/discovery.js';
import {
  generateCertificate,
  generateDeviceId,
} from '../../../src/utils/crypto.js';
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

describe('ConnectionManager', () => {
  let logStream: PassThrough;
  let manager: ConnectionManager;

  const ourDeviceId = generateDeviceId();
  const ourCert = generateCertificate(ourDeviceId);

  const phoneDeviceId = generateDeviceId();
  const phoneCert = generateCertificate(phoneDeviceId);

  beforeEach(() => {
    resetLogger();
    logStream = new PassThrough();
    initializeLogger({ level: 'debug', stream: logStream });

    manager = new ConnectionManager();
  });

  afterEach(async () => {
    await manager.stop();
    await shutdownLogger();
    resetLogger();
    logStream.destroy();
  });

  it('starts TCP server on an available port', async () => {
    await manager.start(ourDeviceId, ourCert.cert, ourCert.private);

    const port = manager.getTcpPort();
    expect(port).toBeGreaterThanOrEqual(1716);
    expect(port).toBeLessThanOrEqual(1764);
  });

  it('stop() is safe to call multiple times', async () => {
    await manager.start(ourDeviceId, ourCert.cert, ourCert.private);
    await manager.stop();
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('connectToDevice establishes outgoing connection with identity exchange and TLS', async () => {
    await manager.start(ourDeviceId, ourCert.cert, ourCert.private);

    const phoneServer = await createMockPhoneServer(phoneDeviceId, phoneCert);

    const connectionPromise = new Promise<DeviceConnection>((resolve) => {
      manager.onConnection((conn) => resolve(conn));
    });

    const discoveredPhone: DiscoveredDevice = {
      deviceId: phoneDeviceId,
      deviceName: 'TestPhone',
      deviceType: 'phone',
      protocolVersion: PROTOCOL_VERSION,
      tcpPort: phoneServer.port,
      address: '127.0.0.1',
      lastSeen: Date.now(),
    };

    manager.connectToDevice(discoveredPhone);

    const conn = await connectionPromise;

    expect(conn.deviceId).toBe(phoneDeviceId);
    expect(conn.connected).toBe(true);
    expect(conn.peerCertPem).toContain('-----BEGIN CERTIFICATE-----');

    const stored = manager.getConnection(phoneDeviceId);
    expect(stored).toBeDefined();
    expect(stored!.deviceId).toBe(phoneDeviceId);

    conn.socket.destroy();
    phoneServer.server.close();
  }, 15000);

  it('handles incoming connection from phone', async () => {
    await manager.start(ourDeviceId, ourCert.cert, ourCert.private);

    const connectionPromise = new Promise<DeviceConnection>((resolve) => {
      manager.onConnection((conn) => resolve(conn));
    });

    // Simulate phone connecting to our TCP server
    simulatePhoneIncoming(
      manager.getTcpPort(),
      phoneDeviceId,
      phoneCert,
    );

    const conn = await connectionPromise;

    expect(conn.deviceId).toBe(phoneDeviceId);
    expect(conn.connected).toBe(true);

    conn.socket.destroy();
  }, 15000);

  it('fires onDisconnection when a connection is lost', async () => {
    await manager.start(ourDeviceId, ourCert.cert, ourCert.private);

    const phoneServer = await createMockPhoneServer(phoneDeviceId, phoneCert);

    const connectionPromise = new Promise<DeviceConnection>((resolve) => {
      manager.onConnection((conn) => resolve(conn));
    });

    const discoveredPhone: DiscoveredDevice = {
      deviceId: phoneDeviceId,
      deviceName: 'TestPhone',
      deviceType: 'phone',
      protocolVersion: PROTOCOL_VERSION,
      tcpPort: phoneServer.port,
      address: '127.0.0.1',
      lastSeen: Date.now(),
    };

    manager.connectToDevice(discoveredPhone);
    const conn = await connectionPromise;

    const disconnectPromise = new Promise<string>((resolve) => {
      manager.onDisconnection((deviceId) => resolve(deviceId));
    });

    conn.socket.destroy();

    const disconnectedId = await disconnectPromise;
    expect(disconnectedId).toBe(phoneDeviceId);
    expect(manager.getConnection(phoneDeviceId)).toBeUndefined();

    phoneServer.server.close();
  }, 15000);

  it('stop() closes all connections', async () => {
    await manager.start(ourDeviceId, ourCert.cert, ourCert.private);

    const phoneServer = await createMockPhoneServer(phoneDeviceId, phoneCert);

    const connectionPromise = new Promise<DeviceConnection>((resolve) => {
      manager.onConnection((conn) => resolve(conn));
    });

    const discoveredPhone: DiscoveredDevice = {
      deviceId: phoneDeviceId,
      deviceName: 'TestPhone',
      deviceType: 'phone',
      protocolVersion: PROTOCOL_VERSION,
      tcpPort: phoneServer.port,
      address: '127.0.0.1',
      lastSeen: Date.now(),
    };

    manager.connectToDevice(discoveredPhone);
    await connectionPromise;

    await manager.stop();
    expect(manager.getConnection(phoneDeviceId)).toBeUndefined();

    phoneServer.server.close();
  }, 15000);
});

/**
 * Create a mock phone TCP server that simulates Android KDE Connect:
 * 1. Accepts connection, waits for desktop identity over plain TCP
 * 2. Does NOT send identity back — goes straight to TLS as client
 * 3. Exchanges identity over TLS (protocol v8)
 *
 * Per Android LanLinkProvider.tcpPacketReceived: phone reads identity,
 * calls identityPacketReceived → TLS handshake. No plain-text identity response.
 */
async function createMockPhoneServer(
  phoneDeviceId: string,
  phoneCert: { cert: string; private: string },
): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';

      const dataHandler = (data: Buffer) => {
        buffer += data.toString();
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx === -1) return;

        // Got desktop's identity. Per Android source: do NOT send identity back.
        // Immediately start TLS as client.
        socket.removeListener('data', dataHandler);
        socket.pause();

        setTimeout(() => {
          const tlsSocket = tls.connect({
            socket,
            rejectUnauthorized: false,
            requestCert: true,
            key: phoneCert.private,
            cert: phoneCert.cert,
          });

          tlsSocket.on('secureConnect', () => {
            // v8: read desktop's TLS identity, then send ours
            let tlsBuffer = '';
            tlsSocket.on('data', (tlsData) => {
              tlsBuffer += tlsData.toString();
              const tlsNl = tlsBuffer.indexOf('\n');
              if (tlsNl === -1) return;

              tlsSocket.removeAllListeners('data');

              const tlsIdentity = createIdentityPacket({
                deviceId: phoneDeviceId,
                deviceName: 'MockPhone',
                tcpPort: 1716,
              });
              tlsSocket.write(serializePacket(tlsIdentity));
            });
          });

          tlsSocket.on('error', () => {
            // Connection may be closed by test
          });
        }, 10);
      };

      socket.on('data', dataHandler);
      socket.on('error', () => {});
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Simulate phone connecting to our TCP server (incoming connection).
 * Per Android LanLinkProvider.udpPacketReceived: phone connects, sends identity,
 * then immediately starts TLS as server. Does NOT wait for desktop identity.
 */
function simulatePhoneIncoming(
  desktopPort: number,
  phoneDeviceId: string,
  phoneCert: { cert: string; private: string },
): void {
  const phoneSocket = net.connect(desktopPort, '127.0.0.1');

  phoneSocket.on('connect', () => {
    // Phone sends identity first
    const phoneIdentity = createIdentityPacket({
      deviceId: phoneDeviceId,
      deviceName: 'TestPhone',
      tcpPort: 1716,
    });

    // Phone sends identity then immediately starts TLS as server.
    // Does NOT wait for desktop identity over plain TCP.
    phoneSocket.write(serializePacket(phoneIdentity), () => {
      phoneSocket.pause();

      setTimeout(() => {
        // For incoming connection, phone acts as TLS server (role inversion)
        const tlsSocket = new tls.TLSSocket(phoneSocket, {
          isServer: true,
          rejectUnauthorized: false,
          requestCert: true,
          key: phoneCert.private,
          cert: phoneCert.cert,
        });

        tlsSocket.once('secure', () => {
          // v8: exchange identity over TLS
          const tlsIdentity = createIdentityPacket({
            deviceId: phoneDeviceId,
            deviceName: 'TestPhone',
            tcpPort: 1716,
          });
          tlsSocket.write(serializePacket(tlsIdentity));

          // Read desktop's TLS identity
          let tlsBuf = '';
          tlsSocket.on('data', (d) => {
            tlsBuf += d.toString();
            if (tlsBuf.indexOf('\n') === -1) return;
            tlsSocket.removeAllListeners('data');
          });
        });

        tlsSocket.on('error', () => {});
      }, 10);
    });
  });

  phoneSocket.on('error', () => {});
}
