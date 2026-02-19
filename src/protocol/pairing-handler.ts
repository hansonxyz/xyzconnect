/**
 * Pairing Protocol Handler
 *
 * Implements the KDE Connect pairing protocol:
 * 1. Either side sends pair request with timestamp
 * 2. Other side shows verification key, user accepts/rejects
 * 3. Response sent (accept/reject)
 * 4. On accept: store peer's certificate as trusted
 *
 * Verification key algorithm:
 * - Extract SPKI DER hex from both certificates
 * - Sort keys descending (larger hex string first)
 * - SHA256(key1 + key2 + timestampSeconds)
 * - First 8 hex chars, uppercase
 *
 * Pairing modes:
 * - Outgoing: desktop initiates, phone responds
 * - Incoming: phone initiates, queued for user approval via CLI/UI
 * - Only one pending pairing at a time per device
 * - Configurable timeout on pairing request
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import { getPublicKeyDerHex } from '../utils/crypto.js';
import {
  createPacket,
  serializePacket,
  PACKET_TYPE_PAIR,
} from '../network/packet.js';
import type { NetworkPacket } from '../network/packet.js';
import type { DeviceConnection } from '../network/connection-manager.js';

export interface PairingHandlerOptions {
  ourCertPem: string;
  trustedCertsDir: string;
  pairingTimeout?: number;
}

interface PendingPairing {
  deviceId: string;
  verificationKey: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface IncomingPairingRequest {
  deviceId: string;
  deviceName: string;
  timestamp: number;
}

type PairingResultCallback = (
  deviceId: string,
  success: boolean,
  verificationKey?: string,
) => void;

type UnpairedCallback = (deviceId: string) => void;

type IncomingPairingCallback = (request: IncomingPairingRequest) => void;

const DEFAULT_PAIRING_TIMEOUT = 30000;

export class PairingHandler {
  private ourCertPem: string;
  private trustedCertsDir: string;
  private pairingTimeout: number;
  private pendingPairings = new Map<string, PendingPairing>();
  private incomingRequests = new Map<string, IncomingPairingRequest>();
  private incomingConnections = new Map<string, DeviceConnection>();
  private resultCallbacks: PairingResultCallback[] = [];
  private unpairedCallbacks: UnpairedCallback[] = [];
  private incomingPairingCallbacks: IncomingPairingCallback[] = [];
  private logger: Logger;

  constructor(options: PairingHandlerOptions) {
    this.ourCertPem = options.ourCertPem;
    this.trustedCertsDir = options.trustedCertsDir;
    this.pairingTimeout = options.pairingTimeout ?? DEFAULT_PAIRING_TIMEOUT;
    this.logger = createLogger('pairing-handler');
  }

  /**
   * Initiate pairing with a connected device.
   * Sends unpair first (to reset phone state if it thinks it's still paired),
   * then sends pair request and returns the verification key.
   */
  requestPairing(connection: DeviceConnection): { verificationKey: string } {
    if (!connection.peerCertPem) {
      throw new Error('No peer certificate available for pairing');
    }

    if (this.isPaired(connection.deviceId)) {
      throw new Error('Already paired with this device');
    }

    // Send unpair first to reset phone state. This handles the case where
    // our cert was deleted locally but the phone still thinks it's paired.
    // The phone will process this and clear its pairing for us.
    const unpairPacket = createPacket(PACKET_TYPE_PAIR, { pair: false });
    connection.socket.write(serializePacket(unpairPacket));

    const timestampMs = Date.now();
    const timestampSeconds = Math.floor(timestampMs / 1000);

    const verificationKey = this.generateVerificationKey(
      this.ourCertPem,
      connection.peerCertPem,
      timestampMs,
    );

    // Send pair request
    const pairPacket = createPacket(PACKET_TYPE_PAIR, {
      pair: true,
      timestamp: timestampSeconds,
    });
    connection.socket.write(serializePacket(pairPacket));

    this.logger.info('protocol.pairing', 'Pairing request sent', {
      deviceId: connection.deviceId,
      verificationKey,
    });

    // Set timeout
    const timeoutId = setTimeout(() => {
      if (this.pendingPairings.has(connection.deviceId)) {
        this.pendingPairings.delete(connection.deviceId);
        this.logger.warn('protocol.pairing', 'Pairing timeout', {
          deviceId: connection.deviceId,
        });
        this.firePairingResult(connection.deviceId, false);
      }
    }, this.pairingTimeout);

    this.pendingPairings.set(connection.deviceId, {
      deviceId: connection.deviceId,
      verificationKey,
      timeoutId,
    });

    return { verificationKey };
  }

  /**
   * Handle an incoming pair/unpair packet from a connected device.
   */
  handlePairingPacket(packet: NetworkPacket, connection: DeviceConnection): void {
    const isPairRequest = packet.body['pair'] === true;
    const hasPending = this.pendingPairings.has(connection.deviceId);

    if (!isPairRequest) {
      // Unpair request or rejection
      if (hasPending) {
        // Rejection of our pairing request
        this.clearPending(connection.deviceId);
        this.logger.info('protocol.pairing', 'Pairing rejected by remote', {
          deviceId: connection.deviceId,
        });
        this.firePairingResult(connection.deviceId, false);
      } else {
        // Phone-initiated unpair
        this.removeTrustedCert(connection.deviceId);
        this.logger.info('protocol.pairing', 'Device unpaired by remote', {
          deviceId: connection.deviceId,
        });
        this.fireUnpaired(connection.deviceId);
      }
      return;
    }

    if (hasPending) {
      // Phone accepted our pairing request
      this.clearPending(connection.deviceId);

      if (connection.peerCertPem) {
        this.storeTrustedCert(connection.deviceId, connection.peerCertPem);
        this.logger.info('protocol.pairing', 'Pairing accepted', {
          deviceId: connection.deviceId,
        });
        this.firePairingResult(connection.deviceId, true);
      } else {
        this.logger.error('protocol.pairing', 'No peer cert for pairing completion', {
          deviceId: connection.deviceId,
        });
        this.firePairingResult(connection.deviceId, false);
      }
    } else {
      // Phone-initiated pairing — queue for user approval
      const request: IncomingPairingRequest = {
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
        timestamp: Date.now(),
      };
      this.incomingRequests.set(connection.deviceId, request);
      this.incomingConnections.set(connection.deviceId, connection);

      this.logger.info('protocol.pairing', 'Incoming pairing request queued', {
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
      });

      this.fireIncomingPairing(request);
    }
  }

  /**
   * Check if a device is paired (has a trusted certificate on disk).
   */
  isPaired(deviceId: string): boolean {
    const certFile = path.join(this.trustedCertsDir, `${deviceId}.pem`);
    return fs.existsSync(certFile);
  }

  /**
   * Send unpair packet (if connected) and remove trusted certificate.
   * Connection is optional — local cert removal works even when disconnected.
   */
  unpair(deviceId: string, connection?: DeviceConnection): void {
    if (connection?.connected) {
      const unpairPacket = createPacket(PACKET_TYPE_PAIR, { pair: false });
      connection.socket.write(serializePacket(unpairPacket));
    } else {
      this.logger.info('protocol.pairing', 'Unpairing without active connection', { deviceId });
    }

    this.removeTrustedCert(deviceId);
    this.logger.info('protocol.pairing', 'Unpaired device', { deviceId });
    this.fireUnpaired(deviceId);
  }

  /**
   * Load trusted device IDs from disk.
   */
  loadTrustedDevices(): string[] {
    if (!fs.existsSync(this.trustedCertsDir)) {
      return [];
    }

    return fs.readdirSync(this.trustedCertsDir)
      .filter((f) => f.endsWith('.pem'))
      .map((f) => f.replace(/\.pem$/, ''));
  }

  /**
   * Register a callback for pairing results (success or failure).
   */
  onPairingResult(callback: PairingResultCallback): void {
    this.resultCallbacks.push(callback);
  }

  /**
   * Register a callback for when a device is unpaired (local or remote).
   */
  onUnpaired(callback: UnpairedCallback): void {
    this.unpairedCallbacks.push(callback);
  }

  /**
   * Register a callback for incoming (phone-initiated) pairing requests.
   */
  onIncomingPairing(callback: IncomingPairingCallback): void {
    this.incomingPairingCallbacks.push(callback);
  }

  /**
   * Get all pending incoming pairing requests.
   */
  getPendingIncoming(): IncomingPairingRequest[] {
    return Array.from(this.incomingRequests.values());
  }

  /**
   * Accept a pending incoming pairing request from a phone.
   */
  acceptIncomingPairing(deviceId: string): void {
    const request = this.incomingRequests.get(deviceId);
    const connection = this.incomingConnections.get(deviceId);

    if (!request || !connection) {
      throw new Error(`No pending incoming pairing request from device: ${deviceId}`);
    }

    this.incomingRequests.delete(deviceId);
    this.incomingConnections.delete(deviceId);

    if (!connection.peerCertPem) {
      this.logger.error('protocol.pairing', 'No peer cert for incoming pairing', { deviceId });
      this.firePairingResult(deviceId, false);
      return;
    }

    // Send pair acceptance
    const acceptPacket = createPacket(PACKET_TYPE_PAIR, { pair: true });
    connection.socket.write(serializePacket(acceptPacket));

    // Store trusted cert
    this.storeTrustedCert(deviceId, connection.peerCertPem);
    this.logger.info('protocol.pairing', 'Incoming pairing accepted', { deviceId });
    this.firePairingResult(deviceId, true);
  }

  /**
   * Reject a pending incoming pairing request from a phone.
   */
  rejectIncomingPairing(deviceId: string): void {
    const request = this.incomingRequests.get(deviceId);
    const connection = this.incomingConnections.get(deviceId);

    if (!request) {
      throw new Error(`No pending incoming pairing request from device: ${deviceId}`);
    }

    this.incomingRequests.delete(deviceId);
    this.incomingConnections.delete(deviceId);

    if (connection?.connected) {
      const rejectPacket = createPacket(PACKET_TYPE_PAIR, { pair: false });
      connection.socket.write(serializePacket(rejectPacket));
    }

    this.logger.info('protocol.pairing', 'Incoming pairing rejected', { deviceId });
    this.firePairingResult(deviceId, false);
  }

  /**
   * Generate verification key from two certificates and a timestamp.
   * Public method for testing.
   */
  generateVerificationKey(
    certPem1: string,
    certPem2: string,
    timestampMs: number,
  ): string {
    const pub1 = getPublicKeyDerHex(certPem1);
    const pub2 = getPublicKeyDerHex(certPem2);
    const timestampSeconds = Math.floor(timestampMs / 1000);

    // Sort descending (larger hex string first)
    const keys = [pub1, pub2].sort().reverse();

    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(keys[0]!, 'hex'));
    hash.update(Buffer.from(keys[1]!, 'hex'));
    hash.update(timestampSeconds.toString());

    return hash.digest('hex').substring(0, 8).toUpperCase();
  }

  /**
   * Clean up pending timers and incoming requests. Call on shutdown.
   */
  cleanup(): void {
    for (const [, pending] of this.pendingPairings) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingPairings.clear();
    this.incomingRequests.clear();
    this.incomingConnections.clear();
  }

  private clearPending(deviceId: string): void {
    const pending = this.pendingPairings.get(deviceId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingPairings.delete(deviceId);
    }
  }

  private storeTrustedCert(deviceId: string, certPem: string): void {
    fs.mkdirSync(this.trustedCertsDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.trustedCertsDir, `${deviceId}.pem`),
      certPem,
      { mode: 0o644 },
    );
  }

  private removeTrustedCert(deviceId: string): void {
    const certFile = path.join(this.trustedCertsDir, `${deviceId}.pem`);
    if (fs.existsSync(certFile)) {
      fs.unlinkSync(certFile);
    }
  }

  private firePairingResult(deviceId: string, success: boolean): void {
    for (const cb of this.resultCallbacks) {
      cb(deviceId, success);
    }
  }

  private fireUnpaired(deviceId: string): void {
    for (const cb of this.unpairedCallbacks) {
      cb(deviceId);
    }
  }

  private fireIncomingPairing(request: IncomingPairingRequest): void {
    for (const cb of this.incomingPairingCallbacks) {
      cb(request);
    }
  }
}
