// Carrega AppConfig a partir de process.env (preenchido por `node --env-file=.env`).
// Validação inline, sem dependência externa (zod removido — KISS).

export interface AppConfig {
  inputFile: string
  outputDir: string
  outputFormats: ReadonlyArray<'json' | 'csv' | 'xlsx'>
  concurrency: number
  browserPoolSize: number
  maxRetries: number
  timeoutMs: number
  delayMinMs: number
  delayMaxMs: number
  headless: boolean
  userAgent: string
  checkpointInterval: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  resume: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Config inválida: ${message}`)
    this.name = 'ConfigError'
  }
}

const VALID_FORMATS = new Set(['json', 'csv', 'xlsx'])
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function readString(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const v = env[key]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new ConfigError(`${key} é obrigatório`)
  }
  return v
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} deve ser inteiro entre ${min} e ${max}, recebido ${raw}`)
  }
  return n
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ConfigError(`${key} deve ser true|false|1|0, recebido ${raw}`)
}

function readFormats(env: NodeJS.ProcessEnv): ReadonlyArray<'json' | 'csv' | 'xlsx'> {
  const raw = env['OUTPUT_FORMATS'] ?? 'json,csv'
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  if (parts.length === 0) {
    throw new ConfigError('OUTPUT_FORMATS não pode ser vazio')
  }
  for (const p of parts) {
    if (!VALID_FORMATS.has(p)) {
      throw new ConfigError(`OUTPUT_FORMATS contém valor inválido: ${p}. Permitidos: json,csv,xlsx`)
    }
  }
  return parts as ReadonlyArray<'json' | 'csv' | 'xlsx'>
}

function readLogLevel(env: NodeJS.ProcessEnv): AppConfig['logLevel'] {
  const raw = (env['LOG_LEVEL'] ?? 'info').toLowerCase()
  if (!VALID_LOG_LEVELS.has(raw)) {
    throw new ConfigError(`LOG_LEVEL inválido: ${raw}. Permitidos: debug,info,warn,error`)
  }
  return raw as AppConfig['logLevel']
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const concurrency = readInt(env, 'CONCURRENCY', 8, 1, 64)
  const browserPoolSize = readInt(env, 'BROWSER_POOL_SIZE', 3, 1, 10)
  const delayMinMs = readInt(env, 'DELAY_MIN_MS', 500, 0, 60_000)
  const delayMaxMs = readInt(env, 'DELAY_MAX_MS', 1500, 0, 60_000)

  if (delayMinMs > delayMaxMs) {
    throw new ConfigError(`DELAY_MIN_MS (${delayMinMs}) > DELAY_MAX_MS (${delayMaxMs})`)
  }
  if (browserPoolSize > concurrency) {
    throw new ConfigError(
      `BROWSER_POOL_SIZE (${browserPoolSize}) > CONCURRENCY (${concurrency}) é desperdício`,
    )
  }

  return {
    inputFile: readString(env, 'INPUT_FILE', 'input/urls.csv'),
    outputDir: readString(env, 'OUTPUT_DIR', 'output'),
    outputFormats: readFormats(env),
    concurrency,
    browserPoolSize,
    maxRetries: readInt(env, 'MAX_RETRIES', 3, 0, 10),
    timeoutMs: readInt(env, 'TIMEOUT_MS', 30_000, 1_000, 300_000),
    delayMinMs,
    delayMaxMs,
    headless: readBool(env, 'HEADLESS', true),
    userAgent: readString(
      env,
      'USER_AGENT',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ),
    checkpointInterval: readInt(env, 'CHECKPOINT_INTERVAL', 25, 1, 10_000),
    logLevel: readLogLevel(env),
    resume: readBool(env, 'RESUME', false),
  }
}

export function configSnapshot(c: AppConfig): { concurrency: number; max_retries: number; timeout_ms: number } {
  return {
    concurrency: c.concurrency,
    max_retries: c.maxRetries,
    timeout_ms: c.timeoutMs,
  }
}
