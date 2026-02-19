/**
 * TLS Handler
 *
 * Upgrades plain TCP sockets to TLS with KDE Connect role inversion:
 * - Incoming TCP connection (phone connects to us) → we act as TLS client
 * - Outgoing TCP connection (we connect to phone) → we act as TLS server
 *
 * All connections use self-signed certificates with requestCert for peer
 * certificate exchange (needed for pairing verification).
 */

import * as tls from 'node:tls';
import type * as net from 'node:net';
import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

export interface TlsUpgradeOptions {
  cert: string;
  key: string;
  isServer: boolean;
  timeout?: number;
}

const DEFAULT_TLS_TIMEOUT = 10000;

const logger: Logger = createLogger('tls');

/**
 * Upgrade a plain TCP socket to TLS.
 *
 * Role inversion is critical for KDE Connect:
 * - isServer=true: wraps socket as TLS server (used for outgoing TCP connections)
 * - isServer=false: wraps socket as TLS client (used for incoming TCP connections)
 */
export function upgradePlainSocketToTls(
  socket: net.Socket,
  options: TlsUpgradeOptions,
): Promise<tls.TLSSocket> {
  const timeout = options.timeout ?? DEFAULT_TLS_TIMEOUT;

  return new Promise<tls.TLSSocket>((resolve, reject) => {
    let tlsSocket: tls.TLSSocket;
    let settled = false;

    if (options.isServer) {
      tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        rejectUnauthorized: false,
        requestCert: true,
        key: options.key,
        cert: options.cert,
      });
    } else {
      tlsSocket = tls.connect({
        socket,
        rejectUnauthorized: false,
        requestCert: true,
        key: options.key,
        cert: options.cert,
      });
    }

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (err) {
        tlsSocket.destroy();
        reject(err);
      } else {
        resolve(tlsSocket);
      }
    };

    const onSecure = () => {
      logger.info('network.tls', 'TLS handshake complete', {
        isServer: options.isServer,
      });
      tlsSocket.removeListener('error', onError);
      settle();
    };

    const onError = (err: Error) => {
      logger.error('network.tls', 'TLS upgrade failed', {
        error: err.message,
        isServer: options.isServer,
      });
      if (options.isServer) {
        tlsSocket.removeListener('secure', onSecure);
      } else {
        tlsSocket.removeListener('secureConnect', onSecure);
      }
      settle(err);
    };

    // Server mode emits 'secure', client mode emits 'secureConnect'
    if (options.isServer) {
      tlsSocket.once('secure', onSecure);
    } else {
      tlsSocket.once('secureConnect', onSecure);
    }
    tlsSocket.once('error', onError);

    const timer = setTimeout(() => {
      if (options.isServer) {
        tlsSocket.removeListener('secure', onSecure);
      } else {
        tlsSocket.removeListener('secureConnect', onSecure);
      }
      tlsSocket.removeListener('error', onError);
      settle(new Error('TLS handshake timeout'));
    }, timeout);
  });
}

/**
 * Extract the peer's certificate as a PEM string from a TLS socket.
 */
export function getPeerCertificatePem(tlsSocket: tls.TLSSocket): string | undefined {
  const peerCert = tlsSocket.getPeerCertificate(false);

  if (!peerCert || !('raw' in peerCert) || !peerCert.raw) {
    return undefined;
  }

  const base64 = peerCert.raw.toString('base64');
  const lines = base64.match(/.{1,64}/g);
  if (!lines) return undefined;

  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----';
}

/**
 * Extract the peer's device ID (CN) from their certificate.
 */
export function getPeerDeviceId(tlsSocket: tls.TLSSocket): string | undefined {
  const peerCert = tlsSocket.getPeerCertificate(false);

  if (!peerCert || !peerCert.subject || !('CN' in peerCert.subject)) {
    return undefined;
  }

  return peerCert.subject.CN || undefined;
}
