import { contextBridge, ipcRenderer } from 'electron'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'
type NotificationCallback = (method: string, params: unknown) => void
type StateChangeCallback = (state: ConnectionState) => void
type UpdateStatusCallback = (status: unknown) => void

const notificationCallbacks = new Set<NotificationCallback>()
const stateChangeCallbacks = new Set<StateChangeCallback>()
const updateStatusCallbacks = new Set<UpdateStatusCallback>()

ipcRenderer.on('daemon:notification', (_event, method: string, params: unknown) => {
  for (const cb of notificationCallbacks) {
    cb(method, params)
  }
})

ipcRenderer.on('daemon:state-changed', (_event, state: ConnectionState) => {
  for (const cb of stateChangeCallbacks) {
    cb(state)
  }
})

ipcRenderer.on('updater:status', (_event, status: unknown) => {
  for (const cb of updateStatusCallbacks) {
    cb(status)
  }
})

const api = {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('daemon:invoke', method, params)
  },

  getConnectionState(): Promise<ConnectionState> {
    return ipcRenderer.invoke('daemon:state') as Promise<ConnectionState>
  },

  log(category: string, message: string, data?: Record<string, unknown>): void {
    ipcRenderer.send('daemon:log', category, message, data)
  },

  onNotification(callback: NotificationCallback): void {
    notificationCallbacks.add(callback)
  },

  offNotification(callback: NotificationCallback): void {
    notificationCallbacks.delete(callback)
  },

  onStateChange(callback: StateChangeCallback): void {
    stateChangeCallbacks.add(callback)
  },

  offStateChange(callback: StateChangeCallback): void {
    stateChangeCallbacks.delete(callback)
  },

  showSaveDialog(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
    return ipcRenderer.invoke('dialog:save', defaultName, filters) as Promise<string | null>
  },

  writeFile(filePath: string, content: string): Promise<void> {
    return ipcRenderer.invoke('fs:writeFile', filePath, content) as Promise<void>
  },

  saveAttachment(partId: number, messageId: number): Promise<{ saved: boolean; path?: string }> {
    return ipcRenderer.invoke('attachment:save', partId, messageId) as Promise<{ saved: boolean; path?: string }>
  },

  showAttachmentContextMenu(partId: number, messageId: number): void {
    ipcRenderer.send('attachment:context-menu', partId, messageId)
  },

  flashTaskbar(flash: boolean): void {
    ipcRenderer.send('window:flash-frame', flash)
  },

  checkForUpdates(): Promise<unknown> {
    return ipcRenderer.invoke('updater:check')
  },

  downloadUpdate(): Promise<unknown> {
    return ipcRenderer.invoke('updater:download')
  },

  installUpdate(): Promise<void> {
    return ipcRenderer.invoke('updater:install') as Promise<void>
  },

  getUpdateStatus(): Promise<unknown> {
    return ipcRenderer.invoke('updater:get-status')
  },

  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('updater:get-version') as Promise<string>
  },

  onUpdateStatus(callback: UpdateStatusCallback): void {
    updateStatusCallbacks.add(callback)
  },

  offUpdateStatus(callback: UpdateStatusCallback): void {
    updateStatusCallbacks.delete(callback)
  },
}

contextBridge.exposeInMainWorld('api', api)
