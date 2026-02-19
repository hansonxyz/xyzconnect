import * as fs from 'node:fs'

let logStream: fs.WriteStream | null = null

export function initLogger(logPath: string): void {
  // Rotate old logs (keep 3 generations)
  if (fs.existsSync(logPath)) {
    for (let i = 2; i >= 1; i--) {
      const src = i === 1 ? logPath : `${logPath}.${i}`
      const dst = `${logPath}.${i + 1}`
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst) } catch { /* ignore */ }
      }
    }
  }

  logStream = fs.createWriteStream(logPath, { flags: 'w' })
  logStream.write(`--- XYZConnect GUI started ${new Date().toISOString()} ---\n`)
}

export function log(category: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const line = data
    ? `${timestamp} [${category}] ${message} ${JSON.stringify(data)}`
    : `${timestamp} [${category}] ${message}`

  if (logStream) {
    logStream.write(line + '\n')
  }
}

export function closeLogger(): void {
  if (logStream) {
    logStream.write(`--- XYZConnect GUI stopped ${new Date().toISOString()} ---\n`)
    logStream.end()
    logStream = null
  }
}
