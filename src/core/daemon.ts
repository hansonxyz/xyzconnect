/**
 * Daemon Lifecycle
 *
 * Coordinates startup and shutdown of the daemon process:
 * data directory creation, configuration loading, logger
 * initialization, state machine management, PID file handling,
 * signal handling, and network service wiring.
 *
 * Network integration (Phase 2):
 * - Device identity and certificate management
 * - TCP connection manager (incoming + outgoing)
 * - UDP discovery service (broadcast + listen)
 * - Pairing handler with verification keys
 * - Packet router for incoming TLS data
 *
 * IPC integration (Phase 3):
 * - JSON-RPC 2.0 IPC server over Unix socket / named pipe
 * - Method handlers for daemon status, pairing, discovery
 * - Notification broadcast for state changes, device events
 *
 * Wiring:
 * - Discovery finds device → auto-connect if trusted, else available for pairing
 * - Connection established → route TLS data through packet router
 * - Pairing success → store cert, transition to CONNECTED
 * - Connection lost → transition to DISCONNECTED, restart discovery
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCode, DaemonError } from './errors.js';
import { StateMachine, AppState } from './state-machine.js';
import { loadConfig } from '../config/config.js';
import type { DaemonConfig } from '../config/config.js';
import {
  initializeLogger,
  createLogger,
  shutdownLogger,
  resetLogger,
} from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import { getDataDir, getConfigPath, getTrustedCertsDir, getSocketPath, getAttachmentsDir } from '../utils/paths.js';
import { DatabaseService } from '../database/database.js';
import {
  loadOrCreateDeviceId,
  loadOrCreateCertificate,
} from '../utils/crypto.js';
import { getCertificatePath, getPrivateKeyPath } from '../utils/paths.js';
import { loadKnownDevices } from '../config/known-devices.js';
import { ConnectionManager } from '../network/connection-manager.js';
import { DiscoveryService } from '../network/discovery.js';
import { PairingHandler } from '../protocol/pairing-handler.js';
import { PacketRouter } from '../protocol/packet-router.js';
import { PACKET_TYPE_PAIR, PACKET_TYPE_PING } from '../network/packet.js';
import { IpcServer } from '../ipc/server.js';
import { registerHandlers, registerNotifications } from '../ipc/handlers.js';
import { SmsHandler } from '../protocol/sms-handler.js';
import { ContactsHandler } from '../protocol/contacts-handler.js';
import { NotificationHandler } from '../protocol/notification-handler.js';
import { SyncOrchestrator } from '../protocol/sync-orchestrator.js';
import {
  PACKET_TYPE_SMS_MESSAGES,
  PACKET_TYPE_SMS_ATTACHMENT_FILE,
  PACKET_TYPE_CONTACTS_RESPONSE_UIDS,
  PACKET_TYPE_CONTACTS_RESPONSE_VCARDS,
  PACKET_TYPE_NOTIFICATION,
} from '../network/packet.js';

export interface DaemonOptions {
  dataDir?: string;
  configPath?: string;
  /** Force logging to daemon.log file (for embedded mode where stdout is lost) */
  logToFile?: boolean;
}

export interface StartOptions {
  /** Skip PID file management (for embedded mode) */
  skipPidFile?: boolean;
  /** Skip SIGTERM/SIGINT signal handlers (for embedded mode) */
  skipSignalHandlers?: boolean;
  /** Skip IPC server startup (for embedded mode where host handles IPC) */
  skipIpcServer?: boolean;
  /** Skip keepalive interval (for embedded mode where host keeps process alive) */
  skipKeepalive?: boolean;
}

export interface DaemonStatus {
  state: AppState;
  pid: number;
  uptime: number;
  config: DaemonConfig;
}

export class Daemon {
  private stateMachine: StateMachine | undefined;
  private config: DaemonConfig | undefined;
  private logger: Logger | undefined;
  private dataDir: string | undefined;
  private pidPath: string | undefined;
  private keepaliveInterval: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private started = false;

  // Network services (Phase 2)
  private deviceId: string | undefined;
  private connectionManager: ConnectionManager | undefined;
  private discoveryService: DiscoveryService | undefined;
  private pairingHandler: PairingHandler | undefined;
  private packetRouter: PacketRouter | undefined;

  // IPC server (Phase 3)
  private ipcServer: IpcServer | undefined;

  // Database (Phase 4)
  private databaseService: DatabaseService | undefined;

  // Protocol handlers (Phase 5)
  private smsHandler: SmsHandler | undefined;
  private contactsHandler: ContactsHandler | undefined;
  private notificationHandler: NotificationHandler | undefined;
  private syncOrchestrator: SyncOrchestrator | undefined;

  // Reconnect timers for known devices
  private reconnectTimers = new Map<string, ReturnType<typeof setInterval>>();

  // Track whether initial sync has been done this session (prevents re-syncing on every reconnect)
  private sessionSynced = false;

  async init(options?: DaemonOptions): Promise<void> {
    // Resolve data directory
    this.dataDir = options?.dataDir ?? getDataDir();

    // Create data directory if needed
    fs.mkdirSync(this.dataDir, { recursive: true });

    // Load configuration
    const configPath = options?.configPath ?? getConfigPath();
    this.config = loadConfig(configPath);

    // Initialize logger — rotate old logs (keep 3 generations)
    const logPath = path.join(this.dataDir, 'daemon.log');
    if (fs.existsSync(logPath)) {
      for (let i = 2; i >= 1; i--) {
        const src = i === 1 ? logPath : `${logPath}.${i}`;
        const dst = `${logPath}.${i + 1}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dst);
        }
      }
    }
    const forceFile = options?.logToFile === true;
    const isPretty = !forceFile && process.env['NODE_ENV'] !== 'production';
    initializeLogger({
      level: this.config.daemon.logLevel,
      filePath: forceFile || !isPretty ? logPath : undefined,
      pretty: isPretty,
    });

    this.logger = createLogger('daemon');

    // Create state machine
    this.stateMachine = new StateMachine();

    // Load or create device identity and certificate
    this.deviceId = loadOrCreateDeviceId(this.dataDir);
    const cert = loadOrCreateCertificate(
      getCertificatePath(),
      getPrivateKeyPath(),
      this.deviceId,
    );

    // Create trusted certs directory
    const trustedCertsDir = getTrustedCertsDir();
    fs.mkdirSync(trustedCertsDir, { recursive: true });

    // Create network services
    this.connectionManager = new ConnectionManager();
    this.discoveryService = new DiscoveryService();
    this.pairingHandler = new PairingHandler({
      ourCertPem: cert.cert,
      trustedCertsDir,
    });
    this.packetRouter = new PacketRouter();

    // Register packet handlers
    this.packetRouter.registerHandler(PACKET_TYPE_PAIR, (packet, connection) => {
      this.pairingHandler!.handlePairingPacket(packet, connection);
    });
    this.packetRouter.registerHandler(PACKET_TYPE_PING, (_packet, connection) => {
      this.logger!.debug('core.daemon', 'Ping received', {
        deviceId: connection.deviceId,
      });
    });

    // Wire pairing results → state machine
    this.pairingHandler.onPairingResult((deviceId, success) => {
      if (success) {
        this.logger!.info('core.daemon', 'Pairing successful', { deviceId });
        if (this.stateMachine!.canTransition(AppState.CONNECTED)) {
          this.stateMachine!.transition(AppState.CONNECTED, { deviceId });
        }
        // Auto-sync after pairing (first time this session)
        if (this.config!.sync.autoSync && this.syncOrchestrator && !this.sessionSynced) {
          this.syncOrchestrator.startSync();
        }
      } else {
        this.logger!.info('core.daemon', 'Pairing failed', { deviceId });
        if (this.stateMachine!.canTransition(AppState.DISCONNECTED)) {
          this.stateMachine!.transition(AppState.DISCONNECTED);
        }
        // Discovery is still running, go back to DISCOVERING
        if (this.stateMachine!.canTransition(AppState.DISCOVERING)) {
          this.stateMachine!.transition(AppState.DISCOVERING);
        }
      }
    });

    // Wire connections → packet routing and state machine
    this.connectionManager.onConnection((connection) => {
      this.logger!.info('core.daemon', 'Device connected', {
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
      });

      // Clear any reconnect timer for this device
      this.clearReconnectTimer(connection.deviceId);

      // Route incoming TLS data through packet router
      connection.socket.on('data', (data) => {
        this.packetRouter!.route(data.toString(), connection);
      });

      // If device is already paired, transition to CONNECTED and start sync
      if (this.pairingHandler!.isPaired(connection.deviceId)) {
        if (this.stateMachine!.canTransition(AppState.CONNECTED)) {
          this.stateMachine!.transition(AppState.CONNECTED, {
            deviceId: connection.deviceId,
            deviceName: connection.deviceName,
          });
        }

        // Re-request contacts on every reconnection (lightweight — one packet).
        // Handles the case where the user grants contacts permission on the phone
        // after the initial sync already ran.
        if (this.contactsHandler) {
          this.contactsHandler.requestAllUidsTimestamps();
        }

        // Resume any queued attachment downloads that were waiting for connection
        if (this.smsHandler) {
          this.smsHandler.resumeDownloads();
        }

        // Auto-sync on first connection this session only (not on every reconnect).
        // sessionSynced is set on sync *completion*, not start — so if the phone
        // disconnects mid-sync, we retry on the next reconnection.
        if (this.config!.sync.autoSync && this.syncOrchestrator && !this.sessionSynced) {
          this.syncOrchestrator.startSync();
        }
      }
    });

    // Wire unpair → close connection, wipe data, and transition state
    this.pairingHandler.onUnpaired((deviceId) => {
      this.logger!.info('core.daemon', 'Device unpaired', { deviceId });

      // Reset session sync flag so next pairing triggers a fresh sync
      this.sessionSynced = false;

      // Close the connection if still active
      const conn = this.connectionManager!.getConnection(deviceId);
      if (conn) {
        conn.socket.destroy();
      }

      // Wipe cached attachments from disk
      const attachDir = getAttachmentsDir();
      fs.rmSync(attachDir, { recursive: true, force: true });
      this.logger!.info('core.daemon', 'Attachment cache wiped', { dir: attachDir });

      // Wipe all synced data from database (preserves sync_state)
      if (this.databaseService?.isOpen()) {
        this.databaseService.wipeAllData();
        this.logger!.info('core.daemon', 'Database data wiped on unpair');
      }

      // onDisconnection handler below will handle state transition
    });

    // Wire disconnections → state machine, buffer cleanup, sync stop, and reconnect
    this.connectionManager.onDisconnection((deviceId) => {
      this.logger!.info('core.daemon', 'Device disconnected', { deviceId });
      this.packetRouter!.resetBuffer(deviceId);

      if (this.stateMachine!.canTransition(AppState.DISCONNECTED)) {
        this.stateMachine!.transition(AppState.DISCONNECTED);
      }
      // Discovery is still running, transition back to DISCOVERING
      if (this.stateMachine!.canTransition(AppState.DISCOVERING)) {
        this.stateMachine!.transition(AppState.DISCOVERING);
      }

      // Auto-reconnect if this is a known paired device
      this.startReconnectTimer(deviceId);
    });

    // Wire discovery → auto-connect trusted devices
    this.discoveryService.onDeviceFound((device) => {
      this.logger!.info('core.daemon', 'Device discovered', {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      });

      if (this.pairingHandler!.isPaired(device.deviceId)) {
        this.logger!.info('core.daemon', 'Auto-connecting to trusted device', {
          deviceId: device.deviceId,
        });
        this.connectionManager!.connectToDevice(device);
      }
    });

    // Start connection manager (TCP server)
    await this.connectionManager.start(
      this.deviceId,
      cert.cert,
      cert.private,
      this.config.kdeConnect.deviceName,
    );

    // Create IPC server
    this.ipcServer = new IpcServer(getSocketPath());

    // Open database
    this.databaseService = new DatabaseService(path.join(this.dataDir, 'xyzconnect.db'));
    this.databaseService.open();

    // Create protocol handlers (Phase 5)
    const getConnection = () => {
      const devices = this.connectionManager!.getConnectedDevices();
      if (devices.length === 0) return undefined;
      return this.connectionManager!.getConnection(devices[0]!.deviceId);
    };

    this.smsHandler = new SmsHandler({
      db: this.databaseService,
      getConnection,
      getCert: () => cert.cert,
      getKey: () => cert.private,
    });
    this.contactsHandler = new ContactsHandler({
      db: this.databaseService,
      getConnection,
    });
    this.notificationHandler = new NotificationHandler({
      db: this.databaseService,
    });
    this.syncOrchestrator = new SyncOrchestrator({
      smsHandler: this.smsHandler,
      contactsHandler: this.contactsHandler,
      stateMachine: this.stateMachine,
      config: this.config,
      db: this.databaseService,
    });

    // Only mark session as synced once sync actually completes
    this.syncOrchestrator.onSyncComplete(() => {
      this.sessionSynced = true;
      this.logger!.info('core.daemon', 'Session sync completed, will not auto-sync again until unpair');
    });

    // Register protocol packet handlers
    this.packetRouter.registerHandler(PACKET_TYPE_SMS_MESSAGES, (packet, connection) => {
      this.smsHandler!.handleMessages(packet, connection);
    });
    this.packetRouter.registerHandler(PACKET_TYPE_SMS_ATTACHMENT_FILE, (packet, connection) => {
      this.smsHandler!.handleAttachmentFile(packet, connection);
    });
    this.packetRouter.registerHandler(PACKET_TYPE_CONTACTS_RESPONSE_UIDS, (packet, connection) => {
      this.contactsHandler!.handleUidsResponse(packet, connection);
    });
    this.packetRouter.registerHandler(PACKET_TYPE_CONTACTS_RESPONSE_VCARDS, (packet, connection) => {
      this.contactsHandler!.handleVcardsResponse(packet, connection);
    });
    this.packetRouter.registerHandler(PACKET_TYPE_NOTIFICATION, (packet, connection) => {
      this.notificationHandler!.handleNotification(packet, connection);
    });

    this.logger.info('core.daemon', 'Daemon initialized', {
      dataDir: this.dataDir,
      logLevel: this.config.daemon.logLevel,
      deviceId: this.deviceId,
      tcpPort: this.connectionManager.getTcpPort(),
    });
  }

  async start(options?: StartOptions): Promise<void> {
    if (!this.stateMachine || !this.config || !this.logger || !this.dataDir ||
        !this.deviceId || !this.connectionManager || !this.discoveryService) {
      throw new DaemonError(
        ErrorCode.DAEMON_INIT_FAILED,
        'Daemon not initialized. Call init() first.',
      );
    }

    if (this.started) {
      throw new DaemonError(
        ErrorCode.DAEMON_ALREADY_RUNNING,
        'Daemon already started',
      );
    }

    // PID file management
    if (!options?.skipPidFile) {
      this.pidPath = path.join(this.dataDir, 'daemon.pid');
      this.checkStalePid();
      fs.writeFileSync(this.pidPath, String(process.pid), 'utf-8');
    }

    // Register signal handlers
    if (!options?.skipSignalHandlers) {
      const shutdown = () => {
        void this.stop().then(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }

    // Transition to DISCONNECTED
    this.stateMachine.transition(AppState.DISCONNECTED);
    this.started = true;

    // Start discovery (broadcasting and listening)
    this.stateMachine.transition(AppState.DISCOVERING);
    this.discoveryService.start(
      this.deviceId,
      this.config.kdeConnect.deviceName,
      this.connectionManager.getTcpPort(),
    );

    // Auto-connect to known paired devices (IP-based reconnect)
    this.connectKnownDevices();

    // Start IPC server and register handlers
    if (!options?.skipIpcServer) {
      if (this.ipcServer) {
        registerHandlers(this.ipcServer, this);
        registerNotifications(this.ipcServer, this);
        await this.ipcServer.start();
      }
    }

    // Keepalive to prevent Node from exiting
    if (!options?.skipKeepalive) {
      this.keepaliveInterval = setInterval(() => {}, 60000);
    }

    this.logger.info('core.daemon', 'Daemon started', {
      pid: process.pid,
      state: this.stateMachine.getState(),
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.logger) {
      this.logger.info('core.daemon', 'Daemon shutting down');
    }

    // Stop IPC server
    if (this.ipcServer) {
      await this.ipcServer.stop();
    }

    // Stop discovery
    if (this.discoveryService) {
      this.discoveryService.stop();
    }

    // Stop connection manager (closes all connections and TCP server)
    if (this.connectionManager) {
      await this.connectionManager.stop();
    }

    // Stop sync orchestrator
    if (this.syncOrchestrator) {
      this.syncOrchestrator.destroy();
    }

    // Clear reconnect timers
    for (const [, timer] of this.reconnectTimers) {
      clearInterval(timer);
    }
    this.reconnectTimers.clear();

    // Close database
    if (this.databaseService) {
      this.databaseService.close();
    }

    // Cleanup pairing handler timers
    if (this.pairingHandler) {
      this.pairingHandler.cleanup();
    }

    // Clear keepalive
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = undefined;
    }

    // Remove PID file
    if (this.pidPath) {
      try {
        if (fs.existsSync(this.pidPath)) {
          fs.unlinkSync(this.pidPath);
        }
      } catch {
        // Best effort cleanup
      }
    }

    // Destroy state machine
    if (this.stateMachine) {
      this.stateMachine.destroy();
    }

    // Flush and reset logger
    await shutdownLogger();
    resetLogger();
  }

  getStatus(): DaemonStatus {
    if (!this.stateMachine || !this.config) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }

    return {
      state: this.stateMachine.getState(),
      pid: process.pid,
      uptime: this.stateMachine.getContext().uptime,
      config: this.config,
    };
  }

  getStateMachine(): StateMachine {
    if (!this.stateMachine) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.stateMachine;
  }

  getConfig(): DaemonConfig {
    if (!this.config) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.config;
  }

  getConnectionManager(): ConnectionManager {
    if (!this.connectionManager) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.connectionManager;
  }

  getDiscoveryService(): DiscoveryService {
    if (!this.discoveryService) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.discoveryService;
  }

  getPairingHandler(): PairingHandler {
    if (!this.pairingHandler) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.pairingHandler;
  }

  getDatabaseService(): DatabaseService {
    if (!this.databaseService) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.databaseService;
  }

  getSmsHandler(): SmsHandler {
    if (!this.smsHandler) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.smsHandler;
  }

  getContactsHandler(): ContactsHandler {
    if (!this.contactsHandler) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.contactsHandler;
  }

  getNotificationHandler(): NotificationHandler {
    if (!this.notificationHandler) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.notificationHandler;
  }

  getSyncOrchestrator(): SyncOrchestrator {
    if (!this.syncOrchestrator) {
      throw new DaemonError(
        ErrorCode.DAEMON_NOT_RUNNING,
        'Daemon not initialized',
      );
    }
    return this.syncOrchestrator;
  }

  /**
   * On startup, connect to known devices that are also paired.
   */
  private connectKnownDevices(): void {
    const knownDevices = loadKnownDevices();
    if (knownDevices.length === 0) return;

    for (const device of knownDevices) {
      if (this.pairingHandler!.isPaired(device.deviceId)) {
        this.logger!.info('core.daemon', 'Auto-connecting to known device', {
          deviceId: device.deviceId,
          address: device.address,
          port: device.port,
        });
        this.discoveryService!.sendDirectIdentity(device.address, device.port);
      }
    }
  }

  /**
   * Start a reconnect timer for a known paired device.
   * Sends directed UDP identity every 15 seconds to trigger
   * the phone to TCP-connect back to us.
   */
  private startReconnectTimer(deviceId: string): void {
    if (this.reconnectTimers.has(deviceId)) return;

    const knownDevices = loadKnownDevices();
    const known = knownDevices.find((d) => d.deviceId === deviceId);
    if (!known) return;

    if (!this.pairingHandler!.isPaired(deviceId)) return;

    this.logger!.info('core.daemon', 'Starting reconnect timer', {
      deviceId,
      address: known.address,
      intervalMs: 15000,
    });

    const timer = setInterval(() => {
      if (this.stopped) {
        this.clearReconnectTimer(deviceId);
        return;
      }

      if (this.connectionManager!.getConnection(deviceId)) {
        this.clearReconnectTimer(deviceId);
        return;
      }

      this.logger!.debug('core.daemon', 'Reconnect attempt via directed UDP', {
        deviceId,
        address: known.address,
      });
      this.discoveryService!.sendDirectIdentity(known.address, known.port);
    }, 15000);

    this.reconnectTimers.set(deviceId, timer);
  }

  /**
   * Clear a reconnect timer for a device.
   */
  private clearReconnectTimer(deviceId: string): void {
    const timer = this.reconnectTimers.get(deviceId);
    if (timer) {
      clearInterval(timer);
      this.reconnectTimers.delete(deviceId);
      this.logger?.debug('core.daemon', 'Reconnect timer cleared', { deviceId });
    }
  }

  /**
   * Check for a stale PID file. If a PID file exists and the process
   * is still alive, throw. If the process is dead, the PID is stale
   * and we can overwrite it.
   */
  private checkStalePid(): void {
    if (!this.pidPath || !fs.existsSync(this.pidPath)) {
      return;
    }

    const pidStr = fs.readFileSync(this.pidPath, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
      return; // Invalid PID file, overwrite
    }

    try {
      process.kill(pid, 0); // Signal 0 checks if process exists
      throw new DaemonError(
        ErrorCode.DAEMON_ALREADY_RUNNING,
        `Daemon already running with PID ${pid}`,
        { pid },
      );
    } catch (err) {
      if (err instanceof DaemonError) {
        throw err; // Re-throw our own error
      }
      // Process does not exist, PID is stale - safe to overwrite
    }
  }
}
