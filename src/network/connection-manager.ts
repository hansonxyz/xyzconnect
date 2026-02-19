/**
 * Connection Manager
 *
 * Manages the TCP server for incoming connections, outgoing connections
 * to discovered devices, identity exchange, and TLS upgrade. Tracks
 * active connections and fires callbacks for connect/disconnect events.
 *
 * Connection flow (outgoing — we connect to phone):
 * 1. TCP connect to phone's advertised port
 * 2. Send our identity packet over plain TCP
 * 3. Phone reads identity, immediately starts TLS as client
 * 4. TLS upgrade: we act as TLS server (role inversion)
 * 5. Protocol v8: exchange identity over TLS
 * 6. Store connection
 *
 * Connection flow (incoming — phone connects to us):
 * 1. Receive phone's identity over plain TCP
 * 2. Phone immediately starts TLS as server after sending identity
 * 3. TLS upgrade: we act as TLS client (role inversion)
 * 4. Protocol v8: exchange identity over TLS
 * 5. Store connection
 *
 * Per Android LanLinkProvider source: phone does NOT send/receive identity
 * over plain TCP in the direction we previously assumed. Plain-text identity
 * only flows in one direction before TLS, then v8 exchanges both over TLS.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import { ErrorCode, NetworkError } from '../core/errors.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import {
  createIdentityPacket,
  serializePacket,
  parsePacket,
  validateIdentityPacket,
  PACKET_TYPE_IDENTITY,
} from './packet.js';
import { upgradePlainSocketToTls, getPeerCertificatePem, getPeerDeviceId } from './tls.js';
import type { DiscoveredDevice } from './discovery.js';

export interface DeviceConnection {
  deviceId: string;
  deviceName: string;
  socket: tls.TLSSocket;
  protocolVersion: number;
  peerCertPem: string | undefined;
  connected: boolean;
}

type ConnectionCallback = (connection: DeviceConnection) => void;
type DisconnectionCallback = (deviceId: string) => void;

const MIN_TCP_PORT = 1716;
const MAX_TCP_PORT = 1764;
const IDENTITY_TIMEOUT = 10000;

export class ConnectionManager {
  private server: net.Server | undefined;
  private tcpPort = 0;
  private connections = new Map<string, DeviceConnection>();
  private pendingConnections = new Set<string>();
  private connectionCallbacks: ConnectionCallback[] = [];
  private disconnectionCallbacks: DisconnectionCallback[] = [];
  private logger: Logger;
  private deviceName = 'XYZConnect';

  private deviceId: string | undefined;
  private cert: string | undefined;
  private key: string | undefined;

  constructor() {
    this.logger = createLogger('connection-manager');
  }

  /**
   * Start the TCP server on the first available port in the KDE Connect range.
   */
  async start(deviceId: string, cert: string, key: string, deviceName?: string): Promise<void> {
    this.deviceId = deviceId;
    this.cert = cert;
    this.key = key;
    if (deviceName) this.deviceName = deviceName;

    this.server = net.createServer((socket) => {
      this.handleIncomingConnection(socket);
    });

    // Try each port in range until one binds
    for (let port = MIN_TCP_PORT; port <= MAX_TCP_PORT; port++) {
      try {
        await this.tryListen(port);
        this.tcpPort = port;
        this.logger.info('network.connection', 'TCP server listening', { port });
        return;
      } catch {
        // Port in use, try next
      }
    }

    throw new NetworkError(
      ErrorCode.NETWORK_BIND_FAILED,
      `No available port in range ${MIN_TCP_PORT}-${MAX_TCP_PORT}`,
    );
  }

  /**
   * Stop the TCP server and close all connections.
   */
  async stop(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.socket.destroy();
    }
    this.connections.clear();
    this.pendingConnections.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    this.tcpPort = 0;
  }

  getTcpPort(): number {
    return this.tcpPort;
  }

  connectToDevice(device: DiscoveredDevice): void {
    if (!this.deviceId || !this.cert || !this.key) {
      this.logger.error('network.connection', 'Connection manager not started');
      return;
    }

    if (device.deviceId === this.deviceId) return;

    if (this.connections.has(device.deviceId)) {
      this.logger.debug('network.connection', 'Already connected', {
        deviceId: device.deviceId,
      });
      return;
    }

    if (this.pendingConnections.has(device.deviceId)) {
      this.logger.debug('network.connection', 'Connection already in progress', {
        deviceId: device.deviceId,
      });
      return;
    }

    this.pendingConnections.add(device.deviceId);

    const socket = net.connect(device.tcpPort, device.address);

    socket.on('error', (err) => {
      this.pendingConnections.delete(device.deviceId);
      this.logger.error('network.connection', 'Outgoing connection error', {
        deviceId: device.deviceId,
        error: err.message,
      });
    });

    socket.on('connect', () => {
      this.handleOutgoingConnection(socket, device);
    });
  }

  /**
   * Connect to a device by raw IP address and port.
   * Does not require knowing the deviceId — it's discovered during TLS
   * identity exchange. Used for direct IP connections (e.g. over VPN).
   */
  connectToAddress(address: string, port: number): void {
    if (!this.deviceId || !this.cert || !this.key) {
      this.logger.error('network.connection', 'Connection manager not started');
      return;
    }

    // Use a placeholder identity — finishConnection will resolve the real
    // deviceId from the TLS identity exchange (protocol v8).
    const placeholder: DiscoveredDevice = {
      deviceId: `_pending_${address}`,
      deviceName: 'unknown',
      deviceType: 'phone',
      protocolVersion: 8,
      tcpPort: port,
      address,
      lastSeen: Date.now(),
    };

    const socket = net.connect(port, address);

    socket.on('error', (err) => {
      this.logger.error('network.connection', 'Outgoing connection error (direct IP)', {
        address,
        port,
        error: err.message,
      });
    });

    socket.on('connect', () => {
      this.logger.info('network.connection', 'TCP connected to direct IP', {
        address,
        port,
      });
      this.handleOutgoingConnection(socket, placeholder);
    });
  }

  getConnection(deviceId: string): DeviceConnection | undefined {
    return this.connections.get(deviceId);
  }

  getConnectedDeviceIds(): string[] {
    return Array.from(this.connections.keys());
  }

  getConnectedDevices(): Array<{ deviceId: string; deviceName: string }> {
    return Array.from(this.connections.values()).map((c) => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
    }));
  }

  onConnection(callback: ConnectionCallback): void {
    this.connectionCallbacks.push(callback);
  }

  onDisconnection(callback: DisconnectionCallback): void {
    this.disconnectionCallbacks.push(callback);
  }

  private tryListen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server!.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server!.removeListener('error', onError);
        resolve();
      };
      this.server!.once('error', onError);
      this.server!.once('listening', onListening);
      this.server!.listen(port, '0.0.0.0');
    });
  }

  /**
   * Read a single newline-delimited packet from a plain TCP socket.
   * Returns a promise with the packet string and pauses the socket
   * to prevent consuming TLS handshake bytes.
   */
  private readIdentityPacket(socket: net.Socket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let buffer = '';

      const timeout = setTimeout(() => {
        socket.removeListener('data', dataHandler);
        reject(new Error('Identity exchange timeout'));
      }, IDENTITY_TIMEOUT);

      const dataHandler = (data: Buffer) => {
        buffer += data.toString();
        const nlIdx = buffer.indexOf('\n');
        if (nlIdx === -1) return;

        clearTimeout(timeout);
        socket.removeListener('data', dataHandler);
        // Pause socket immediately to prevent consuming TLS bytes
        socket.pause();

        resolve(buffer.substring(0, nlIdx));
      };

      socket.on('data', dataHandler);
    });
  }

  /**
   * Handle incoming TCP connection (phone → us).
   * Phone sends identity over plain TCP, then immediately starts TLS as server.
   * We read identity, then TLS upgrade as client (role inversion).
   * Per Android source: phone does NOT expect our identity before TLS.
   */
  private handleIncomingConnection(socket: net.Socket): void {
    if (!this.deviceId || !this.cert || !this.key) {
      socket.destroy();
      return;
    }

    const ourDeviceId = this.deviceId;
    const cert = this.cert;
    const key = this.key;

    socket.on('error', (err) => {
      this.logger.error('network.connection', 'Incoming socket error', {
        error: err.message,
      });
    });

    this.readIdentityPacket(socket)
      .then((packetData) => {
        this.logger.debug('network.connection', 'Raw incoming identity data', {
          length: packetData.length,
          data: packetData.substring(0, 500),
        });

        const packet = parsePacket(packetData);
        if (packet.type !== PACKET_TYPE_IDENTITY) {
          this.logger.warn('network.connection', 'Expected identity from incoming connection');
          socket.destroy();
          return;
        }

        const identity = validateIdentityPacket(packet);

        // Reject if we already have a connection or handshake in progress
        if (this.connections.has(identity.deviceId) || this.pendingConnections.has(identity.deviceId)) {
          this.logger.debug('network.connection', 'Already connected or in progress, rejecting incoming', {
            deviceId: identity.deviceId,
          });
          socket.destroy();
          return;
        }

        this.pendingConnections.add(identity.deviceId);

        this.logger.info('network.connection', 'Incoming identity received', {
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
        });

        // Do NOT send identity before TLS — phone has already started
        // TLS handshake as server. We upgrade as TLS client (role inversion).
        return upgradePlainSocketToTls(socket, { cert, key, isServer: false })
          .then((tlsSocket) => {
            this.finishConnection(tlsSocket, identity, ourDeviceId);
          })
          .catch((err) => {
            this.pendingConnections.delete(identity.deviceId);
            throw err;
          });
      })
      .catch((err) => {
        this.logger.error('network.connection', 'Incoming connection failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        socket.destroy();
      });
  }

  /**
   * Handle outgoing TCP connection (us → phone).
   * We send identity over plain TCP, then immediately TLS upgrade as server.
   * Per Android source: phone reads our identity, then starts TLS as client.
   * Phone does NOT send identity back over plain TCP.
   */
  private handleOutgoingConnection(socket: net.Socket, device: DiscoveredDevice): void {
    if (!this.deviceId || !this.cert || !this.key) {
      socket.destroy();
      return;
    }

    const ourDeviceId = this.deviceId;
    const cert = this.cert;
    const key = this.key;

    socket.on('error', (err) => {
      this.logger.error('network.connection', 'Outgoing socket error', {
        deviceId: device.deviceId,
        error: err.message,
      });
    });

    // Send our identity, then immediately TLS upgrade.
    // Phone reads identity and starts TLS as client — no plain-text identity response.
    const ourIdentity = createIdentityPacket({
      deviceId: ourDeviceId,
      deviceName: this.deviceName,
      tcpPort: this.tcpPort,
    });

    socket.write(serializePacket(ourIdentity), () => {
      // Identity flushed. Pause socket before TLS upgrade to avoid
      // processing any incoming bytes as raw data events.
      socket.pause();

      this.logger.debug('network.connection', 'Identity sent, starting TLS as server', {
        deviceId: device.deviceId,
      });

      // TLS upgrade: outgoing TCP → we are TLS server (role inversion)
      upgradePlainSocketToTls(socket, { cert, key, isServer: true })
        .then((tlsSocket) => {
          // Use discovery info as preliminary identity.
          // For v8, finishConnection will exchange real identity over TLS.
          const identity = {
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            protocolVersion: device.protocolVersion,
          };
          this.finishConnection(tlsSocket, identity, ourDeviceId);
        })
        .catch((err) => {
          this.pendingConnections.delete(device.deviceId);
          this.logger.error('network.connection', 'Outgoing TLS upgrade failed', {
            error: err instanceof Error ? err.message : String(err),
            deviceId: device.deviceId,
          });
          socket.destroy();
        });
    });
  }

  /**
   * After TLS upgrade, exchange identity over TLS (protocol v8) and store connection.
   */
  private finishConnection(
    tlsSocket: tls.TLSSocket,
    identity: { deviceId: string; deviceName: string; protocolVersion: number },
    ourDeviceId: string,
  ): void {
    const peerCertPem = getPeerCertificatePem(tlsSocket);
    const peerDeviceId = getPeerDeviceId(tlsSocket);

    if (peerDeviceId && peerDeviceId !== identity.deviceId) {
      this.logger.warn('network.connection', 'Certificate device ID mismatch', {
        certDeviceId: peerDeviceId,
        identityDeviceId: identity.deviceId,
      });
    }

    if (identity.protocolVersion >= 8) {
      // Protocol v8: exchange identity over TLS
      const ourIdentity = createIdentityPacket({
        deviceId: ourDeviceId,
        deviceName: this.deviceName,
        tcpPort: this.tcpPort,
      });
      tlsSocket.write(serializePacket(ourIdentity));

      let tlsBuffer = '';
      let tlsIdentityReceived = false;

      const tlsTimeout = setTimeout(() => {
        if (!tlsIdentityReceived) {
          this.pendingConnections.delete(identity.deviceId);
          this.logger.warn('network.connection', 'TLS identity exchange timeout');
          tlsSocket.destroy();
        }
      }, IDENTITY_TIMEOUT);

      const tlsDataHandler = (data: Buffer) => {
        if (tlsIdentityReceived) return;

        tlsBuffer += data.toString();
        const nlIdx = tlsBuffer.indexOf('\n');
        if (nlIdx === -1) return;

        tlsIdentityReceived = true;
        clearTimeout(tlsTimeout);
        tlsSocket.removeListener('data', tlsDataHandler);

        try {
          const packet = parsePacket(tlsBuffer.substring(0, nlIdx));
          const tlsIdentity = validateIdentityPacket(packet);

          const remaining = tlsBuffer.substring(nlIdx + 1);
          this.logger.info('network.connection', 'TLS identity exchange complete', {
            deviceId: tlsIdentity.deviceId,
            deviceName: tlsIdentity.deviceName,
            remainingBufferLength: remaining.length,
            remainingPreview: remaining.substring(0, 200),
          });

          this.storeConnection(tlsSocket, {
            deviceId: tlsIdentity.deviceId,
            deviceName: tlsIdentity.deviceName,
            protocolVersion: tlsIdentity.protocolVersion,
          }, peerCertPem, remaining);
        } catch (err) {
          this.pendingConnections.delete(identity.deviceId);
          this.logger.error('network.connection', 'Failed to parse TLS identity', {
            error: err instanceof Error ? err.message : String(err),
          });
          tlsSocket.destroy();
        }
      };

      tlsSocket.on('data', tlsDataHandler);
    } else {
      this.storeConnection(tlsSocket, identity, peerCertPem);
    }
  }

  private storeConnection(
    tlsSocket: tls.TLSSocket,
    identity: { deviceId: string; deviceName: string; protocolVersion: number },
    peerCertPem: string | undefined,
    remainingBuffer?: string,
  ): void {
    const conn: DeviceConnection = {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      socket: tlsSocket,
      protocolVersion: identity.protocolVersion,
      peerCertPem,
      connected: true,
    };

    this.pendingConnections.delete(identity.deviceId);
    this.connections.set(identity.deviceId, conn);

    this.logger.info('network.connection', 'Connection established', {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
    });

    const cleanup = () => {
      if (conn.connected) {
        conn.connected = false;

        // Only fire disconnect if we're still the current connection.
        // A newer connection for the same device may have replaced us
        // in the map — in that case, silently close without callbacks.
        if (this.connections.get(identity.deviceId) === conn) {
          this.connections.delete(identity.deviceId);

          this.logger.info('network.connection', 'Connection closed', {
            deviceId: identity.deviceId,
          });

          for (const cb of this.disconnectionCallbacks) {
            cb(identity.deviceId);
          }
        } else {
          this.logger.debug('network.connection', 'Stale connection closed (replaced by newer)', {
            deviceId: identity.deviceId,
          });
        }
      }
    };

    tlsSocket.on('close', cleanup);
    tlsSocket.on('error', (err) => {
      this.logger.error('network.connection', 'Connection error', {
        deviceId: identity.deviceId,
        error: err.message,
      });
      cleanup();
    });

    for (const cb of this.connectionCallbacks) {
      cb(conn);
    }

    // If there was data remaining in the TLS buffer after identity exchange,
    // emit it as a data event so the new data handler can process it.
    // This matches the v1 setupPacketHandler(connection, tlsBuffer) pattern.
    if (remainingBuffer && remainingBuffer.length > 0) {
      this.logger.debug('network.connection', 'Replaying remaining TLS buffer', {
        deviceId: identity.deviceId,
        length: remainingBuffer.length,
      });
      tlsSocket.emit('data', Buffer.from(remainingBuffer));
    }
  }
}
