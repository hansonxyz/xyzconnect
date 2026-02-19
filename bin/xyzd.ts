#!/usr/bin/env node
/**
 * XYZConnect Daemon Entry Point
 *
 * Starts the daemon process which manages KDE Connect protocol,
 * database, and IPC server.
 */

import { Daemon } from '../src/core/daemon.js';
import { createLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const daemon = new Daemon();

  try {
    await daemon.init();
    await daemon.start();

    const logger = createLogger('xyzd');
    const status = daemon.getStatus();
    logger.info('core.entry', 'XYZConnect daemon running', {
      pid: status.pid,
      state: status.state,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({
      level: 'fatal',
      msg: 'Daemon failed to start',
      error: message,
    }) + '\n');
    process.exit(1);
  }
}

main();
