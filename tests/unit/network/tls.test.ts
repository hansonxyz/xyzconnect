import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as tls from 'node:tls';
import * as net from 'node:net';
import {
  upgradePlainSocketToTls,
  getPeerCertificatePem,
  getPeerDeviceId,
} from '../../../src/network/tls.js';
import { generateCertificate, generateDeviceId } from '../../../src/utils/crypto.js';
import {
  resetLogger,
  initializeLogger,
  shutdownLogger,
} from '../../../src/utils/logger.js';
import { PassThrough } from 'node:stream';

describe('TLS handler', () => {
  let logStream: PassThrough;

  // Generate two certificates for testing (device A and device B)
  const deviceIdA = generateDeviceId();
  const certA = generateCertificate(deviceIdA);
  const deviceIdB = generateDeviceId();
  const certB = generateCertificate(deviceIdB);

  beforeEach(() => {
    resetLogger();
    logStream = new PassThrough();
    initializeLogger({ level: 'debug', stream: logStream });
  });

  afterEach(async () => {
    await shutdownLogger();
    resetLogger();
    logStream.destroy();
  });

  /**
   * Helper: creates a plain TCP socket pair (client <-> server)
   * Returns a promise resolving to { clientSocket, serverSocket }.
   */
  function createSocketPair(): Promise<{ clientSocket: net.Socket; serverSocket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((serverSocket) => {
        server.close();
        resolve({ clientSocket: client, serverSocket });
      });

      server.on('error', reject);

      let client: net.Socket;
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        client = net.connect(addr.port, '127.0.0.1');
        client.on('error', reject);
      });
    });
  }

  it('upgrades to TLS with role inversion (outgoing = server, incoming = client)', async () => {
    const { clientSocket, serverSocket } = await createSocketPair();

    try {
      // Outgoing connection (we connect to phone): we act as TLS server
      const serverUpgrade = upgradePlainSocketToTls(clientSocket, {
        cert: certA.cert,
        key: certA.private,
        isServer: true,
      });

      // Incoming connection (phone connects to us): they act as TLS client
      const clientUpgrade = upgradePlainSocketToTls(serverSocket, {
        cert: certB.cert,
        key: certB.private,
        isServer: false,
      });

      const [tlsServer, tlsClient] = await Promise.all([serverUpgrade, clientUpgrade]);

      expect(tlsServer).toBeInstanceOf(tls.TLSSocket);
      expect(tlsClient).toBeInstanceOf(tls.TLSSocket);
      expect(tlsServer.encrypted).toBe(true);
      expect(tlsClient.encrypted).toBe(true);

      tlsServer.destroy();
      tlsClient.destroy();
    } catch {
      clientSocket.destroy();
      serverSocket.destroy();
      throw new Error('TLS upgrade failed');
    }
  });

  it('can exchange data over upgraded TLS connection', async () => {
    const { clientSocket, serverSocket } = await createSocketPair();

    const serverUpgrade = upgradePlainSocketToTls(clientSocket, {
      cert: certA.cert,
      key: certA.private,
      isServer: true,
    });

    const clientUpgrade = upgradePlainSocketToTls(serverSocket, {
      cert: certB.cert,
      key: certB.private,
      isServer: false,
    });

    const [tlsServer, tlsClient] = await Promise.all([serverUpgrade, clientUpgrade]);

    // Send data from server to client
    const received = new Promise<string>((resolve) => {
      tlsClient.once('data', (data) => resolve(data.toString()));
    });

    tlsServer.write('hello from server');
    const msg = await received;
    expect(msg).toBe('hello from server');

    tlsServer.destroy();
    tlsClient.destroy();
  });

  it('extracts peer certificate PEM', async () => {
    const { clientSocket, serverSocket } = await createSocketPair();

    const serverUpgrade = upgradePlainSocketToTls(clientSocket, {
      cert: certA.cert,
      key: certA.private,
      isServer: true,
    });

    const clientUpgrade = upgradePlainSocketToTls(serverSocket, {
      cert: certB.cert,
      key: certB.private,
      isServer: false,
    });

    const [tlsServer, tlsClient] = await Promise.all([serverUpgrade, clientUpgrade]);

    // Server should see client's cert (certB)
    const peerPemOnServer = getPeerCertificatePem(tlsServer);
    expect(peerPemOnServer).toBeDefined();
    expect(peerPemOnServer!).toContain('-----BEGIN CERTIFICATE-----');

    // Client should see server's cert (certA)
    const peerPemOnClient = getPeerCertificatePem(tlsClient);
    expect(peerPemOnClient).toBeDefined();
    expect(peerPemOnClient!).toContain('-----BEGIN CERTIFICATE-----');

    tlsServer.destroy();
    tlsClient.destroy();
  });

  it('extracts peer device ID from certificate CN', async () => {
    const { clientSocket, serverSocket } = await createSocketPair();

    const serverUpgrade = upgradePlainSocketToTls(clientSocket, {
      cert: certA.cert,
      key: certA.private,
      isServer: true,
    });

    const clientUpgrade = upgradePlainSocketToTls(serverSocket, {
      cert: certB.cert,
      key: certB.private,
      isServer: false,
    });

    const [tlsServer, tlsClient] = await Promise.all([serverUpgrade, clientUpgrade]);

    // Server should see deviceIdB (client's cert)
    const peerIdOnServer = getPeerDeviceId(tlsServer);
    expect(peerIdOnServer).toBe(deviceIdB);

    // Client should see deviceIdA (server's cert)
    const peerIdOnClient = getPeerDeviceId(tlsClient);
    expect(peerIdOnClient).toBe(deviceIdA);

    tlsServer.destroy();
    tlsClient.destroy();
  });

  it('rejects on timeout when peer does not complete handshake', async () => {
    const { clientSocket, serverSocket } = await createSocketPair();

    // Only upgrade one side, let the other hang
    const result = upgradePlainSocketToTls(clientSocket, {
      cert: certA.cert,
      key: certA.private,
      isServer: true,
      timeout: 200,
    });

    await expect(result).rejects.toThrow('TLS handshake timeout');

    serverSocket.destroy();
    clientSocket.destroy();
  });

  it('returns undefined for getPeerDeviceId when no peer cert', () => {
    // Create a mock TLSSocket-like object with no peer cert
    const fakeTls = {
      getPeerCertificate: () => ({}),
    } as unknown as tls.TLSSocket;

    const result = getPeerDeviceId(fakeTls);
    expect(result).toBeUndefined();
  });

  it('returns undefined for getPeerCertificatePem when no peer cert', () => {
    const fakeTls = {
      getPeerCertificate: () => ({}),
    } as unknown as tls.TLSSocket;

    const result = getPeerCertificatePem(fakeTls);
    expect(result).toBeUndefined();
  });
});
