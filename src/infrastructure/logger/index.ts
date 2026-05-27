// Logger estruturado JSON nativo. Sem deps (pino removido).
// Produção: 1 linha JSON por evento em stdout.
// Dev (NODE_ENV=development): formato pretty com cores ANSI mínimas.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

interface LoggerOptions {
  level: LogLevel
  pretty?: boolean
  bindings?: Record<string, unknown>
  write?: (line: string) => void
  now?: () => Date
}

const PRETTY_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const RESET = '\x1b[0m'

function formatPretty(level: LogLevel, ts: string, msg: string, fields: Record<string, unknown>): string {
  const color = PRETTY_COLORS[level]
  const rest = Object.keys(fields).length > 0 ? ' ' + JSON.stringify(fields) : ''
  return `${ts} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${msg}${rest}`
}

export function createLogger(opts: LoggerOptions): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'))
  const now = opts.now ?? (() => new Date())
  const pretty = opts.pretty ?? process.env['NODE_ENV'] === 'development'
  const baseBindings = opts.bindings ?? {}
  const minPriority = LEVEL_PRIORITY[opts.level]

  function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return
    const ts = now().toISOString()
    const merged = { ...baseBindings, ...(fields ?? {}) }
    if (pretty) {
      write(formatPretty(level, ts, msg, merged))
    } else {
      write(JSON.stringify({ timestamp: ts, level, msg, ...merged }))
    }
  }

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (b) =>
      createLogger({
        level: opts.level,
        pretty,
        bindings: { ...baseBindings, ...b },
        write,
        now,
      }),
  }
}
