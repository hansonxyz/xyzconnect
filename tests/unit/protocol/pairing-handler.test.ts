import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PairingHandler } from '../../../src/protocol/pairing-handler.js';
import type { DeviceConnection } from '../../../src/network/connection-manager.js';
import {
  createPacket,
  PACKET_TYPE_PAIR,
} from '../../../src/network/packet.js';
import {
  generateCertificate,
  generateDeviceId,
  getPublicKeyDerHex,
} from '../../../src/utils/crypto.js';
import {
  resetLogger,
  initializeLogger,
  shutdownLogger,
} from '../../../src/utils/logger.js';
import { PassThrough } from 'node:stream';
import * as crypto from 'node:crypto';

describe('PairingHandler', () => {
  let logStream: PassThrough;
  let handler: PairingHandler;
  let trustedCertsDir: string;
  let tmpDir: string;

  const ourDeviceId = generateDeviceId();
  const ourCert = generateCertificate(ourDeviceId);
  const phoneDeviceId = generateDeviceId();
  const phoneCert = generateCertificate(phoneDeviceId);

  beforeEach(() => {
    resetLogger();
    logStream = new PassThrough();
    initializeLogger({ level: 'debug', stream: logStream });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-test-'));
    trustedCertsDir = path.join(tmpDir, 'trusted_certs');
    fs.mkdirSync(trustedCertsDir, { recursive: true });

    handler = new PairingHandler({
      ourCertPem: ourCert.cert,
      trustedCertsDir,
      pairingTimeout: 500, // Short timeout for tests
    });
  });

  afterEach(async () => {
    handler.cleanup();
    await shutdownLogger();
    resetLogger();
    logStream.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockConnection(
    deviceId: string,
    certPem: string,
  ): DeviceConnection & { writtenPackets: string[] } {
    const writtenPackets: string[] = [];
    const socket = new PassThrough() as unknown as DeviceConnection['socket'];
    const origWrite = socket.write.bind(socket);
    socket.write = ((data: string | Buffer) => {
      writtenPackets.push(data.toString());
      return origWrite(data);
    }) as typeof socket.write;

    return {
      deviceId,
      deviceName: 'MockDevice',
      socket,
      protocolVersion: 8,
      peerCertPem: certPem,
      connected: true,
      writtenPackets,
    };
  }

  describe('verification key generation', () => {
    it('generates an 8-character uppercase hex verification key', () => {
      const key = handler.generateVerificationKey(ourCert.cert, phoneCert.cert, Date.now());
      expect(key).toMatch(/^[0-9A-F]{8}$/);
    });

    it('generates the same key regardless of argument order', () => {
      const ts = Date.now();
      const key1 = handler.generateVerificationKey(ourCert.cert, phoneCert.cert, ts);
      const key2 = handler.generateVerificationKey(phoneCert.cert, ourCert.cert, ts);
      expect(key1).toBe(key2);
    });

    it('generates different keys for different timestamps', () => {
      const key1 = handler.generateVerificationKey(ourCert.cert, phoneCert.cert, 1000000000000);
      const key2 = handler.generateVerificationKey(ourCert.cert, phoneCert.cert, 2000000000000);
      expect(key1).not.toBe(key2);
    });

    it('matches expected SHA256-based algorithm', () => {
      const ts = 1700000000000; // Fixed timestamp
      const key = handler.generateVerificationKey(ourCert.cert, phoneCert.cert, ts);

      // Manually compute expected key
      const ourPubHex = getPublicKeyDerHex(ourCert.cert);
      const phonePubHex = getPublicKeyDerHex(phoneCert.cert);
      const keys = [ourPubHex, phonePubHex].sort().reverse();
      const hash = crypto.createHash('sha256');
      hash.update(Buffer.from(keys[0]!, 'hex'));
      hash.update(Buffer.from(keys[1]!, 'hex'));
      hash.update(Math.floor(ts / 1000).toString());
      const expected = hash.digest('hex').substring(0, 8).toUpperCase();

      expect(key).toBe(expected);
    });
  });

  describe('requestPairing', () => {
    it('sends unpair then pair packet and returns verification key', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      const result = handler.requestPairing(conn);

      expect(result.verificationKey).toMatch(/^[0-9A-F]{8}$/);
      // Sends unpair first (to reset phone state), then pair request
      expect(conn.writtenPackets).toHaveLength(2);

      const unpair = JSON.parse(conn.writtenPackets[0]!.trim());
      expect(unpair.type).toBe('kdeconnect.pair');
      expect(unpair.body.pair).toBe(false);

      const pair = JSON.parse(conn.writtenPackets[1]!.trim());
      expect(pair.type).toBe('kdeconnect.pair');
      expect(pair.body.pair).toBe(true);
      expect(typeof pair.body.timestamp).toBe('number');
    });

    it('throws if connection has no peer certificate', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      conn.peerCertPem = undefined;

      expect(() => handler.requestPairing(conn)).toThrow('No peer certificate');
    });

    it('throws if device is already paired', () => {
      // Write a trusted cert file
      fs.writeFileSync(
        path.join(trustedCertsDir, `${phoneDeviceId}.pem`),
        phoneCert.cert,
      );

      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      expect(() => handler.requestPairing(conn)).toThrow('Already paired');
    });

    it('fires onPairingResult with timeout if phone does not respond', async () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      handler.requestPairing(conn);

      const result = await new Promise<{ deviceId: string; success: boolean }>((resolve) => {
        handler.onPairingResult((deviceId, success) => {
          resolve({ deviceId, success });
        });
      });

      expect(result.deviceId).toBe(phoneDeviceId);
      expect(result.success).toBe(false);
    });
  });

  describe('handlePairingPacket', () => {
    it('completes pairing when phone accepts', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      handler.requestPairing(conn);

      const results: Array<{ deviceId: string; success: boolean }> = [];
      handler.onPairingResult((deviceId, success) => {
        results.push({ deviceId, success });
      });

      // Phone responds with pair: true
      const acceptPacket = createPacket(PACKET_TYPE_PAIR, { pair: true });
      handler.handlePairingPacket(acceptPacket, conn);

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);

      // Trusted cert stored
      const certFile = path.join(trustedCertsDir, `${phoneDeviceId}.pem`);
      expect(fs.existsSync(certFile)).toBe(true);
      const stored = fs.readFileSync(certFile, 'utf-8');
      expect(stored).toBe(phoneCert.cert);
    });

    it('reports failure when phone rejects', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      handler.requestPairing(conn);

      const results: Array<{ deviceId: string; success: boolean }> = [];
      handler.onPairingResult((deviceId, success) => {
        results.push({ deviceId, success });
      });

      const rejectPacket = createPacket(PACKET_TYPE_PAIR, { pair: false });
      handler.handlePairingPacket(rejectPacket, conn);

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);

      // No trusted cert stored
      const certFile = path.join(trustedCertsDir, `${phoneDeviceId}.pem`);
      expect(fs.existsSync(certFile)).toBe(false);
    });

    it('queues phone-initiated pairing requests for user approval', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      // No requestPairing was called, so this is phone-initiated

      const incoming: Array<{ deviceId: string; deviceName: string }> = [];
      handler.onIncomingPairing((request) => {
        incoming.push(request);
      });

      const phoneInitiated = createPacket(PACKET_TYPE_PAIR, { pair: true });
      handler.handlePairingPacket(phoneInitiated, conn);

      // Should NOT send anything back yet
      expect(conn.writtenPackets).toHaveLength(0);

      // Should fire incoming pairing callback
      expect(incoming).toHaveLength(1);
      expect(incoming[0]!.deviceId).toBe(phoneDeviceId);

      // Should be in pending incoming list
      const pending = handler.getPendingIncoming();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.deviceId).toBe(phoneDeviceId);
    });

    it('accepts incoming pairing request and stores cert', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      const phoneInitiated = createPacket(PACKET_TYPE_PAIR, { pair: true });
      handler.handlePairingPacket(phoneInitiated, conn);

      const results: Array<{ deviceId: string; success: boolean }> = [];
      handler.onPairingResult((deviceId, success) => {
        results.push({ deviceId, success });
      });

      handler.acceptIncomingPairing(phoneDeviceId);

      // Should send pair: true back
      expect(conn.writtenPackets).toHaveLength(1);
      const sent = JSON.parse(conn.writtenPackets[0]!.trim());
      expect(sent.body.pair).toBe(true);

      // Should fire pairing result
      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);

      // Cert should be stored
      expect(handler.isPaired(phoneDeviceId)).toBe(true);

      // Pending list should be empty
      expect(handler.getPendingIncoming()).toHaveLength(0);
    });

    it('rejects incoming pairing request and sends rejection', () => {
      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      const phoneInitiated = createPacket(PACKET_TYPE_PAIR, { pair: true });
      handler.handlePairingPacket(phoneInitiated, conn);

      const results: Array<{ deviceId: string; success: boolean }> = [];
      handler.onPairingResult((deviceId, success) => {
        results.push({ deviceId, success });
      });

      handler.rejectIncomingPairing(phoneDeviceId);

      // Should send pair: false back
      expect(conn.writtenPackets).toHaveLength(1);
      const sent = JSON.parse(conn.writtenPackets[0]!.trim());
      expect(sent.body.pair).toBe(false);

      // Should fire pairing result with failure
      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);

      // Cert should NOT be stored
      expect(handler.isPaired(phoneDeviceId)).toBe(false);
    });

    it('handles unpair packet from phone', () => {
      // First, mark as paired
      fs.writeFileSync(
        path.join(trustedCertsDir, `${phoneDeviceId}.pem`),
        phoneCert.cert,
      );
      expect(handler.isPaired(phoneDeviceId)).toBe(true);

      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      const unpairPacket = createPacket(PACKET_TYPE_PAIR, { pair: false });
      handler.handlePairingPacket(unpairPacket, conn);

      // Trusted cert should be removed
      expect(handler.isPaired(phoneDeviceId)).toBe(false);
    });
  });

  describe('unpair', () => {
    it('sends unpair packet and removes trusted cert', () => {
      // First, mark as paired
      fs.writeFileSync(
        path.join(trustedCertsDir, `${phoneDeviceId}.pem`),
        phoneCert.cert,
      );

      const conn = createMockConnection(phoneDeviceId, phoneCert.cert);
      handler.unpair(phoneDeviceId, conn);

      expect(conn.writtenPackets).toHaveLength(1);
      const sent = JSON.parse(conn.writtenPackets[0]!.trim());
      expect(sent.type).toBe('kdeconnect.pair');
      expect(sent.body.pair).toBe(false);

      expect(handler.isPaired(phoneDeviceId)).toBe(false);
    });
  });

  describe('isPaired', () => {
    it('returns false for unknown device', () => {
      expect(handler.isPaired('unknown-device-id')).toBe(false);
    });

    it('returns true when trusted cert exists', () => {
      fs.writeFileSync(
        path.join(trustedCertsDir, `${phoneDeviceId}.pem`),
        phoneCert.cert,
      );
      expect(handler.isPaired(phoneDeviceId)).toBe(true);
    });
  });

  describe('loadTrustedDevices', () => {
    it('loads existing trusted device IDs', () => {
      fs.writeFileSync(
        path.join(trustedCertsDir, `${phoneDeviceId}.pem`),
        phoneCert.cert,
      );

      const devices = handler.loadTrustedDevices();
      expect(devices).toContain(phoneDeviceId);
    });

    it('returns empty array when no trusted devices', () => {
      const devices = handler.loadTrustedDevices();
      expect(devices).toHaveLength(0);
    });
  });
});
