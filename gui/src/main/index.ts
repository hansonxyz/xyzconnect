import { app, BrowserWindow, Menu, ipcMain, protocol, net, dialog, shell } from 'electron'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { DaemonBridge } from './daemon-bridge'
import { initLogger, log, closeLogger } from './logger'
import { setupAutoUpdater } from './auto-updater'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const data = readFileSync(getWindowStatePath(), 'utf-8')
    return JSON.parse(data) as WindowState
  } catch {
    return { width: 1200, height: 800 }
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds()
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
    }
    mkdirSync(join(app.getPath('userData')), { recursive: true })
    writeFileSync(getWindowStatePath(), JSON.stringify(state))
  } catch {
    // Ignore save errors
  }
}

function getExtensionForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'video/3gpp2': '.3g2',
    'video/mpeg': '.mpeg',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/amr': '.amr',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/3gpp': '.3gp',
    'text/vcard': '.vcf',
    'text/x-vcard': '.vcf',
    'application/pdf': '.pdf',
  }
  return map[mime] ?? ''
}

let mainWindow: BrowserWindow | null = null
let daemonClient: DaemonBridge | null = null

function parseLogFile(): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--log-file=')) {
      return arg.substring('--log-file='.length)
    }
  }
  return null
}

function createWindow(): void {
  log('main', 'Creating browser window')

  const saved = loadWindowState()

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 800,
    minHeight: 500,
    title: 'XYZConnect',
    backgroundColor: '#1a1a2e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (saved.maximized) {
    mainWindow.maximize()
  }

  mainWindow.on('ready-to-show', () => {
    log('main', 'Window ready to show')
    mainWindow?.show()
  })

  // Save window state on close
  mainWindow.on('close', () => {
    if (mainWindow) saveWindowState(mainWindow)
  })

  // Stop taskbar flash when window gains focus
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false)
  })

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL']
    log('main', 'Loading dev URL', { url })
    mainWindow.loadURL(url)
  } else {
    const htmlPath = join(__dirname, '../renderer/index.html')
    log('main', 'Loading production HTML', { path: htmlPath })
    mainWindow.loadFile(htmlPath)
  }
}

function setupDaemonClient(): void {
  daemonClient = new DaemonBridge()

  daemonClient.onNotification((method, params) => {
    log('daemon', 'Notification received', { method })
    mainWindow?.webContents.send('daemon:notification', method, params)
  })

  daemonClient.onStateChange((state) => {
    log('daemon', 'Connection state changed', { state })
    mainWindow?.webContents.send('daemon:state-changed', state)
  })

  log('daemon', 'Starting embedded daemon')
  daemonClient.connect()
}

function setupIpcHandlers(): void {
  ipcMain.handle('daemon:invoke', async (_event, method: string, params?: Record<string, unknown>) => {
    log('ipc', 'Renderer invoke', { method })
    if (!daemonClient || !daemonClient.isConnected()) {
      throw new Error('Daemon not connected')
    }
    return daemonClient.call(method, params)
  })

  ipcMain.handle('daemon:state', () => {
    const state = daemonClient?.getState() ?? 'disconnected'
    log('ipc', 'Renderer getConnectionState', { state })
    return state
  })

  ipcMain.on('daemon:log', (_event, category: string, message: string, data?: Record<string, unknown>) => {
    log(category, message, data)
  })

  ipcMain.handle('dialog:save', async (_event, defaultName: string, filters: { name: string; extensions: string[] }[]) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters,
    })
    return result.canceled ? null : result.filePath ?? null
  })

  ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, content, 'utf-8')
  })

  ipcMain.handle('attachment:save', async (_event, partId: number, messageId: number) => {
    if (!daemonClient || !daemonClient.isConnected()) {
      throw new Error('Daemon not connected')
    }
    if (!mainWindow) return { saved: false }

    const result = (await daemonClient.call('sms.attachment_path', {
      partId,
      messageId,
    })) as { localPath: string; mimeType: string } | null

    if (!result || !result.localPath) {
      throw new Error('Attachment not found')
    }

    const ext = getExtensionForMime(result.mimeType)
    // Use the original filename's extension as fallback, or derive from the file on disk
    const diskExt = extname(result.localPath)
    const finalExt = ext || diskExt || '.bin'
    const defaultName = `attachment_${partId}_${messageId}${finalExt}`

    // Build filters: specific type first, then all files
    const extNoDot = finalExt.slice(1)
    const filters = [
      { name: `${result.mimeType} (*.${extNoDot})`, extensions: [extNoDot] },
      { name: 'All Files', extensions: ['*'] },
    ]

    const dialogResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters,
    })

    if (dialogResult.canceled || !dialogResult.filePath) {
      return { saved: false }
    }

    await copyFile(result.localPath, dialogResult.filePath)
    return { saved: true, path: dialogResult.filePath }
  })

  ipcMain.on('attachment:context-menu', (event, partId: number, messageId: number) => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Save As\u2026',
        click: () => {
          void (async () => {
            try {
              // Reuse the same save logic as the save button
              const result = (await daemonClient.call('sms.attachment_path', {
                partId,
                messageId,
              })) as { localPath: string; mimeType: string } | null

              if (!result || !result.localPath || !mainWindow) return

              const ext = getExtensionForMime(result.mimeType)
              const diskExt = extname(result.localPath)
              const finalExt = ext || diskExt || '.bin'
              const defaultName = `attachment_${partId}_${messageId}${finalExt}`
              const extNoDot = finalExt.slice(1)
              const filters = [
                { name: `${result.mimeType} (*.${extNoDot})`, extensions: [extNoDot] },
                { name: 'All Files', extensions: ['*'] },
              ]

              const dialogResult = await dialog.showSaveDialog(mainWindow, {
                defaultPath: defaultName,
                filters,
              })

              if (!dialogResult.canceled && dialogResult.filePath) {
                await copyFile(result.localPath, dialogResult.filePath)
              }
            } catch (err) {
              log('gui.main', 'Context menu save failed', {
                error: err instanceof Error ? err.message : String(err),
              })
            }
          })()
        },
      },
    ])
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      menu.popup({ window: win })
    }
  })

  ipcMain.on('window:flash-frame', (_event, flash: boolean) => {
    mainWindow?.flashFrame(flash)
  })
}

// Register custom protocol for serving attachment files to the renderer
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'xyzattachment',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

const logFile = parseLogFile()
if (logFile) {
  initLogger(logFile)
} else {
  // Auto-enable logging to userData directory
  const autoLogPath = join(app.getPath('userData'), 'gui-debug.log')
  mkdirSync(join(app.getPath('userData')), { recursive: true })
  initLogger(autoLogPath)
}

log('main', 'App starting', {
  argv: process.argv,
  platform: process.platform,
  packaged: app.isPackaged,
  version: app.getVersion()
})

app.whenReady().then(() => {
  log('main', 'App ready')

  // Hide the default menu bar in production builds, but keep it for dev testing
  // (run.bat passes --dev to indicate a dev build)
  const isDevFlag = process.argv.includes('--dev')
  if (app.isPackaged && !isDevFlag) {
    Menu.setApplicationMenu(null)
  }

  // Handle xyzattachment:// — serves downloaded attachment files and thumbnails
  // URL format: xyzattachment://file/{partId}/{messageId} (full file)
  //             xyzattachment://thumb/{partId}/{messageId} (thumbnail)
  protocol.handle('xyzattachment', async (request) => {
    try {
      const url = new URL(request.url)
      const host = url.hostname // 'file' or 'thumb'
      const parts = url.pathname.split('/').filter(Boolean)
      const partId = parseInt(parts[0] ?? '0', 10)
      const messageId = parseInt(parts[1] ?? '0', 10)

      if (!daemonClient || !daemonClient.isConnected()) {
        return new Response('Daemon not connected', { status: 503 })
      }

      if (host === 'thumb') {
        const result = (await daemonClient.call('sms.attachment_thumbnail_path', {
          partId,
          messageId,
        })) as { thumbnailPath: string; mimeType: string } | null

        if (!result || !result.thumbnailPath) {
          return new Response('Not found', { status: 404 })
        }

        log('protocol', 'xyzattachment serving thumbnail', { partId: String(partId), messageId: String(messageId) })
        return net.fetch(pathToFileURL(result.thumbnailPath).href)
      }

      // Default: serve full file
      const result = (await daemonClient.call('sms.attachment_path', {
        partId,
        messageId,
      })) as { localPath: string; mimeType: string } | null

      if (!result || !result.localPath) {
        log('protocol', 'xyzattachment not found', { partId: String(partId), messageId: String(messageId) })
        return new Response('Not found', { status: 404 })
      }

      log('protocol', 'xyzattachment serving file', { partId: String(partId), messageId: String(messageId), localPath: result.localPath })
      return net.fetch(pathToFileURL(result.localPath).href)
    } catch (err) {
      log('protocol', 'xyzattachment error', {
        url: request.url,
        error: err instanceof Error ? err.message : String(err),
      })
      return new Response('Internal error', { status: 500 })
    }
  })

  setupIpcHandlers()
  createWindow()
  setupDaemonClient()
  setupAutoUpdater(mainWindow!)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  log('main', 'All windows closed, shutting down')
  const shutdown = async (): Promise<void> => {
    try {
      if (daemonClient) {
        // Wait for daemon to stop, but don't hang forever
        await Promise.race([
          daemonClient.disconnect(),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ])
      }
    } catch (err) {
      log('main', 'Error during daemon shutdown', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    closeLogger()
    if (process.platform !== 'darwin') {
      app.quit()
    }
    // Force exit after a short delay — open network handles (TCP/UDP)
    // can prevent the process from exiting on Windows
    setTimeout(() => process.exit(0), 1000)
  }
  void shutdown()
})
