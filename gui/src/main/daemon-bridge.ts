import { Daemon } from '@daemon/core/daemon'
import { createMethodMap, wireNotifications } from '@daemon/ipc/handlers'
import type { MethodHandler } from '@daemon/ipc/handlers'
import { log } from './logger'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

type NotificationCallback = (method: string, params: unknown) => void
type StateChangeCallback = (state: ConnectionState) => void

/**
 * In-process daemon bridge for embedded mode.
 * Same callback interface as DaemonClient (socket-based),
 * but runs the daemon directly in the Electron main process.
 */
export class DaemonBridge {
  private daemon: Daemon
  private methods: Map<string, MethodHandler> | undefined
  private state: ConnectionState = 'disconnected'
  private notificationCallbacks: NotificationCallback[] = []
  private stateChangeCallbacks: StateChangeCallback[] = []

  constructor() {
    this.daemon = new Daemon()
  }

  connect(): void {
    if (this.state !== 'disconnected') return

    this.setState('connecting')

    // Async init+start — fire and forget, emit state changes
    void this.startDaemon().catch((err) => {
      log('daemon-bridge', 'Failed to start embedded daemon', {
        error: err instanceof Error ? err.message : String(err),
      })
      this.setState('disconnected')
    })
  }

  private async startDaemon(): Promise<void> {
    await this.daemon.init({ logToFile: true })
    await this.daemon.start({
      skipPidFile: true,
      skipSignalHandlers: true,
      skipIpcServer: true,
      skipKeepalive: true,
    })

    this.methods = createMethodMap(this.daemon)
    wireNotifications(this.daemon, (method, params) => {
      for (const cb of this.notificationCallbacks) {
        cb(method, params)
      }
    })

    this.setState('connected')
    log('daemon-bridge', 'Embedded daemon started')
  }

  async disconnect(): Promise<void> {
    this.methods = undefined
    this.setState('disconnected')
    await this.daemon.stop()
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  getState(): ConnectionState {
    return this.state
  }

  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.methods || this.state !== 'connected') {
      return Promise.reject(new Error('Not connected'))
    }
    const handler = this.methods.get(method)
    if (!handler) {
      return Promise.reject(new Error(`Unknown method: ${method}`))
    }
    return handler(params)
  }

  onNotification(callback: NotificationCallback): void {
    this.notificationCallbacks.push(callback)
  }

  onStateChange(callback: StateChangeCallback): void {
    this.stateChangeCallbacks.push(callback)
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const cb of this.stateChangeCallbacks) {
      cb(state)
    }
  }
}
