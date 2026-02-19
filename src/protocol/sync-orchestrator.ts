/**
 * Sync Orchestrator
 *
 * Coordinates the multi-phase data sync after a paired device connects.
 *
 * Sync flow:
 * 1. CONNECTED → SYNCING (contacts phase)
 * 2. Request contacts UIDs → receive vCards
 * 3. On contacts complete → switch to conversations phase
 * 4. Request conversations → receive message batches
 * 5. Silence timeout (no new data) → SYNCING → READY
 *
 * The protocol has no "sync complete" signal, so we use a silence
 * timeout: if no new data arrives within config.sync.silenceTimeout ms,
 * we consider sync done.
 *
 * Periodic re-sync: after reaching READY, re-sync at config.sync.syncInterval.
 */

import { createLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';
import type { StateMachine } from '../core/state-machine.js';
import { AppState } from '../core/state-machine.js';
import type { DaemonConfig } from '../config/config.js';
import type { DatabaseService } from '../database/database.js';
import type { SmsHandler } from './sms-handler.js';
import type { ContactsHandler } from './contacts-handler.js';

export interface SyncOrchestratorOptions {
  smsHandler: SmsHandler;
  contactsHandler: ContactsHandler;
  stateMachine: StateMachine;
  config: DaemonConfig;
  db: DatabaseService;
}

type SyncCallback = () => void;

export class SyncOrchestrator {
  private smsHandler: SmsHandler;
  private contactsHandler: ContactsHandler;
  private stateMachine: StateMachine;
  private config: DaemonConfig;
  private db: DatabaseService;
  private logger: Logger;

  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private resyncInterval: ReturnType<typeof setInterval> | undefined;
  private syncing = false;
  private destroyed = false;

  private syncStartedCallbacks: SyncCallback[] = [];
  private syncCompleteCallbacks: SyncCallback[] = [];

  constructor(options: SyncOrchestratorOptions) {
    this.smsHandler = options.smsHandler;
    this.contactsHandler = options.contactsHandler;
    this.stateMachine = options.stateMachine;
    this.config = options.config;
    this.db = options.db;
    this.logger = createLogger('sync-orchestrator');

    // Wire message callbacks to reset silence timer
    this.smsHandler.onMessages(() => {
      this.resetSilenceTimer();
    });

    // Wire contacts complete → start conversations phase
    this.contactsHandler.onContactsUpdated(() => {
      if (this.syncing) {
        this.startConversationsPhase();
      }
    });
  }

  /**
   * Start a sync cycle. Transitions to SYNCING and begins requesting data.
   */
  startSync(): void {
    if (this.destroyed) return;

    if (this.syncing) {
      this.logger.debug('protocol.sync', 'Sync already in progress');
      return;
    }

    // Check if we can transition to SYNCING
    if (!this.stateMachine.canTransition(AppState.SYNCING)) {
      this.logger.warn('protocol.sync', 'Cannot start sync from current state', {
        state: this.stateMachine.getState(),
      });
      return;
    }

    this.syncing = true;
    this.clearResyncInterval();

    this.stateMachine.transition(AppState.SYNCING, { syncPhase: 'contacts' });
    this.logger.info('protocol.sync', 'Sync started (contacts phase)');
    this.fireSyncStarted();

    // Request both contacts and conversations in parallel.
    // Contacts may be gated by a consent dialog on the phone,
    // but conversations should work independently.
    this.contactsHandler.requestAllUidsTimestamps();
    this.smsHandler.requestConversations();

    // Start silence timer — if nothing responds, sync completes via timeout
    this.resetSilenceTimer();
  }

  /**
   * Stop an in-progress sync. Clears all timers.
   */
  stopSync(): void {
    if (!this.syncing) return;

    this.syncing = false;
    this.clearSilenceTimer();
    this.clearResyncInterval();

    this.logger.info('protocol.sync', 'Sync stopped');
  }

  /**
   * Clean up all resources. Call on daemon shutdown.
   */
  destroy(): void {
    this.destroyed = true;
    this.stopSync();
    this.syncStartedCallbacks = [];
    this.syncCompleteCallbacks = [];
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  // --- Callbacks ---

  onSyncStarted(cb: SyncCallback): void {
    this.syncStartedCallbacks.push(cb);
  }

  onSyncComplete(cb: SyncCallback): void {
    this.syncCompleteCallbacks.push(cb);
  }

  // --- Internal ---

  private startConversationsPhase(): void {
    if (!this.syncing || this.destroyed) return;

    // Update sync phase in state context
    if (this.stateMachine.getState() === AppState.SYNCING) {
      // We can't re-transition to SYNCING from SYNCING, so just update context
      // by using the context in the next transition. For now log it.
      this.logger.info('protocol.sync', 'Sync phase: conversations');
    }

    this.smsHandler.requestConversations();
    this.resetSilenceTimer();
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();

    if (!this.syncing || this.destroyed) return;

    this.silenceTimer = setTimeout(() => {
      this.onSilenceTimeout();
    }, this.config.sync.silenceTimeout);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
  }

  private onSilenceTimeout(): void {
    if (!this.syncing || this.destroyed) return;

    this.syncing = false;
    this.clearSilenceTimer();

    // Transition SYNCING → READY
    if (this.stateMachine.canTransition(AppState.READY)) {
      this.stateMachine.transition(AppState.READY);
    }

    // Record sync timestamp
    this.db.setSyncState('lastSync', Date.now().toString());

    this.logger.info('protocol.sync', 'Sync complete (silence timeout)');
    this.fireSyncComplete();

    // Set up periodic re-sync
    this.startResyncInterval();
  }

  private startResyncInterval(): void {
    this.clearResyncInterval();

    if (this.destroyed || !this.config.sync.autoSync) return;

    this.resyncInterval = setInterval(() => {
      if (this.destroyed) {
        this.clearResyncInterval();
        return;
      }

      if (this.stateMachine.getState() === AppState.READY) {
        this.logger.info('protocol.sync', 'Periodic re-sync triggered');
        this.startSync();
      }
    }, this.config.sync.syncInterval);
  }

  private clearResyncInterval(): void {
    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
      this.resyncInterval = undefined;
    }
  }

  private fireSyncStarted(): void {
    for (const cb of this.syncStartedCallbacks) {
      cb();
    }
  }

  private fireSyncComplete(): void {
    for (const cb of this.syncCompleteCallbacks) {
      cb();
    }
  }
}
