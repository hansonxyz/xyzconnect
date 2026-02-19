/**
 * UDP Discovery Service
 *
 * Broadcasts identity packets on port 1716 and listens for
 * identity broadcasts from Android devices running KDE Connect.
 * Tracks discovered devices and fires callbacks for new/lost devices.
 */

import * as dgram from 'node:dgram';
import * as os from 'node:os';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import {
  createIdentityPacket,
  serializePacket,
  parsePacket,
  validateIdentityPacket,
  isValidDeviceId,
  PACKET_TYPE_IDENTITY,
} from './packet.js';

export interface DiscoveredDevice {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  protocolVersion: number;
  tcpPort: number;
  address: string;
  lastSeen: number;
}

export interface DiscoveryOptions {
  udpPort?: number;
  broadcastInterval?: number;
  deviceLostTimeout?: number;
  reachabilityCheckInterval?: number;
}

type DeviceFoundCallback = (device: DiscoveredDevice) => void;
type DeviceLostCallback = (deviceId: string) => void;

const DEFAULT_UDP_PORT = 1716;
const DEFAULT_BROADCAST_INTERVAL = 5000;
const DEFAULT_DEVICE_LOST_TIMEOUT = 120000;
const DEFAULT_REACHABILITY_CHECK_INTERVAL = 5000;

export class DiscoveryService {
  private socket: dgram.Socket | undefined;
  private broadcastTimer: ReturnType<typeof setInterval> | undefined;
  private reachabilityTimer: ReturnType<typeof setInterval> | undefined;
  private devices = new Map<string, DiscoveredDevice>();
  private deviceFoundCallbacks: DeviceFoundCallback[] = [];
  private deviceLostCallbacks: DeviceLostCallback[] = [];
  private logger: Logger;
  private running = false;

  private deviceId: string | undefined;
  private deviceName: string | undefined;
  private tcpPort: number | undefined;

  private readonly udpPort: number;
  private readonly broadcastInterval: number;
  private readonly deviceLostTimeout: number;
  private readonly reachabilityCheckInterval: number;

  constructor(options?: DiscoveryOptions) {
    this.udpPort = options?.udpPort ?? DEFAULT_UDP_PORT;
    this.broadcastInterval = options?.broadcastInterval ?? DEFAULT_BROADCAST_INTERVAL;
    this.deviceLostTimeout = options?.deviceLostTimeout ?? DEFAULT_DEVICE_LOST_TIMEOUT;
    this.reachabilityCheckInterval = options?.reachabilityCheckInterval ?? DEFAULT_REACHABILITY_CHECK_INTERVAL;
    this.logger = createLogger('discovery');
  }

  /**
   * Start the discovery service: bind UDP socket, begin broadcasting.
   */
  start(deviceId: string, deviceName: string, tcpPort: number): void {
    if (this.running) {
      return;
    }

    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.tcpPort = tcpPort;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('error', (err) => {
      this.logger.error('network.discovery', 'UDP socket error', {
        error: err.message,
      });
    });

    this.socket.on('message', (msg, rinfo) => {
      this.handleIncomingPacket(msg.toString('utf-8'), rinfo.address);
    });

    this.socket.on('listening', () => {
      this.socket!.setBroadcast(true);
      this.running = true;

      this.logger.info('network.discovery', 'Discovery service started', {
        port: this.udpPort,
      });

      // Broadcast immediately, then on interval
      this.broadcast();
      this.broadcastTimer = setInterval(() => this.broadcast(), this.broadcastInterval);

      // Start reachability check
      this.reachabilityTimer = setInterval(
        () => this.checkReachability(),
        this.reachabilityCheckInterval,
      );
    });

    this.socket.bind(this.udpPort);
  }

  /**
   * Stop discovery: close socket, clear timers, clear device list.
   */
  stop(): void {
    if (!this.running && !this.socket) {
      return;
    }

    this.running = false;

    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }

    if (this.reachabilityTimer) {
      clearInterval(this.reachabilityTimer);
      this.reachabilityTimer = undefined;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }

    this.devices.clear();
  }

  /**
   * Get the current map of discovered devices.
   */
  getDiscoveredDevices(): Map<string, DiscoveredDevice> {
    return new Map(this.devices);
  }

  /**
   * Register a callback for when a new device is discovered.
   */
  onDeviceFound(callback: DeviceFoundCallback): void {
    this.deviceFoundCallbacks.push(callback);
  }

  /**
   * Register a callback for when a device is lost (timeout).
   */
  onDeviceLost(callback: DeviceLostCallback): void {
    this.deviceLostCallbacks.push(callback);
  }

  /**
   * Send a directed UDP identity packet to a specific IP address.
   * Used for connect-by-IP when broadcast discovery is unreliable
   * (e.g. VPN subnets). The phone receives our identity and
   * TCP-connects back to us.
   */
  sendDirectIdentity(address: string, port?: number): void {
    if (!this.socket || !this.deviceId || !this.deviceName || this.tcpPort === undefined) {
      this.logger.error('network.discovery', 'Cannot send direct identity: service not started');
      return;
    }

    const targetPort = port ?? this.udpPort;
    const packet = createIdentityPacket({
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      tcpPort: this.tcpPort,
    });
    const serialized = serializePacket(packet);
    const buffer = Buffer.from(serialized);

    this.socket.send(buffer, 0, buffer.length, targetPort, address, (err) => {
      if (err) {
        this.logger.error('network.discovery', 'Direct identity send error', {
          address,
          port: targetPort,
          error: err.message,
        });
      } else {
        this.logger.info('network.discovery', 'Direct identity sent', {
          address,
          port: targetPort,
        });
      }
    });
  }

  /**
   * Broadcast our identity packet to the network.
   */
  private broadcast(): void {
    if (!this.socket || !this.deviceId || !this.deviceName || this.tcpPort === undefined) {
      return;
    }

    const packet = createIdentityPacket({
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      tcpPort: this.tcpPort,
    });
    const serialized = serializePacket(packet);
    const buffer = Buffer.from(serialized);

    if (process.platform === 'win32' || process.platform === 'freebsd') {
      this.broadcastFromAllInterfaces(buffer);
    } else {
      this.socket.send(buffer, 0, buffer.length, this.udpPort, '255.255.255.255', (err) => {
        if (err) {
          this.logger.error('network.discovery', 'Broadcast send error', {
            error: err.message,
          });
        }
      });
    }
  }

  /**
   * Broadcast from each non-internal IPv4 interface individually.
   * Required on Windows/FreeBSD to reach all network segments.
   */
  private broadcastFromAllInterfaces(buffer: Buffer): void {
    const interfaces = os.networkInterfaces();

    for (const [, addresses] of Object.entries(interfaces)) {
      if (!addresses) continue;

      for (const addr of addresses) {
        if (addr.family !== 'IPv4' || addr.internal) continue;

        const tempSocket = dgram.createSocket('udp4');
        tempSocket.bind(0, addr.address, () => {
          tempSocket.setBroadcast(true);
          tempSocket.send(buffer, 0, buffer.length, this.udpPort, '255.255.255.255', (err) => {
            if (err) {
              this.logger.warn('network.discovery', 'Interface broadcast error', {
                address: addr.address,
                error: err.message,
              });
            }
            tempSocket.close();
          });
        });
      }
    }
  }

  /**
   * Handle an incoming UDP packet.
   */
  private handleIncomingPacket(data: string, address: string): void {
    let packet;
    try {
      packet = parsePacket(data);
    } catch {
      this.logger.debug('network.discovery', 'Failed to parse incoming packet', { address });
      return;
    }

    // Only process identity packets
    if (packet.type !== PACKET_TYPE_IDENTITY) {
      return;
    }

    let identity;
    try {
      identity = validateIdentityPacket(packet);
    } catch {
      this.logger.debug('network.discovery', 'Invalid identity packet', { address });
      return;
    }

    // Ignore self-broadcasts
    if (identity.deviceId === this.deviceId) {
      return;
    }

    // Validate device ID format
    if (!isValidDeviceId(identity.deviceId)) {
      this.logger.debug('network.discovery', 'Invalid device ID format', {
        deviceId: identity.deviceId,
        address,
      });
      return;
    }

    const isNew = !this.devices.has(identity.deviceId);

    const device: DiscoveredDevice = {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      deviceType: identity.deviceType,
      protocolVersion: identity.protocolVersion,
      tcpPort: identity.tcpPort,
      address,
      lastSeen: Date.now(),
    };

    this.devices.set(identity.deviceId, device);

    if (isNew) {
      this.logger.info('network.discovery', 'Device discovered', {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        address,
      });

      for (const cb of this.deviceFoundCallbacks) {
        cb(device);
      }
    }
  }

  /**
   * Remove devices that haven't been seen within the timeout period.
   */
  private checkReachability(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [deviceId, device] of this.devices) {
      if (now - device.lastSeen > this.deviceLostTimeout) {
        toRemove.push(deviceId);
      }
    }

    for (const deviceId of toRemove) {
      this.devices.delete(deviceId);

      this.logger.info('network.discovery', 'Device lost', { deviceId });

      for (const cb of this.deviceLostCallbacks) {
        cb(deviceId);
      }
    }
  }
}
