// Entry point — wire-up de todos os adapters.
//
// Uso:
//   node dist/cli/index.js --input fixtures/urls.csv --output out/
//   npm start -- --input fixtures/urls.csv --output out/
//
// Flags:
//   --input <path>          obrigatório (CSV, JSON, TXT ou XLSX)
//   --output <dir>          default: out/
//   --concurrency <N>       default: 3
//   --timeout <ms>          default: 30000
//   --retries <N>           default: 2
//   --resume / --no-resume  ativa/desativa FileCheckpointStore (default: --resume)
//   --headless              força headless (NÃO recomendado, ADR-0007)
//   --profile <dir>         default: fixtures/browser-profile/
//   --anchor-address <s>    endereco-ancora para warm-up (default env ANCHOR_ADDRESS
//                           ou "Avenida Paulista, 1000, São Paulo")
//   --skip-warm             pula o warm-up automatico (NAO recomendado)
//
// Saídas (CompositeResultSink): products.json + products.xlsx + products.csv.

import { mkdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { CrawlProductsUseCase } from '../application/use-cases/crawl-products.use-case.js'
import { InMemorySemaphoreQueue } from '../infrastructure/concurrency/in-memory-job-queue.impl.js'
import { createLogger } from '../infrastructure/logger/index.js'
import { BrowserPool } from '../adapters/fetcher/browser-pool.service.js'
import { createCapSolverCloudflareSolver } from '../adapters/fetcher/capsolver-cloudflare.adapter.js'
import { createFlareSolverrCloudflareSolver } from '../adapters/fetcher/flaresolverr-cloudflare.adapter.js'
import { PlaywrightFetcher } from '../adapters/fetcher/playwright-fetcher.adapter.js'
import { IfoodApiExtractor } from '../adapters/extractor/ifood-api-extractor.adapter.js'
import { FileCheckpointStore } from '../adapters/checkpoint/file-checkpoint-store.adapter.js'
import { CompositeResultSink } from '../adapters/storage/composite-result-sink.adapter.js'
import { JsonResultSink } from '../adapters/storage/json-result-sink.adapter.js'
import { CsvResultSink } from '../adapters/storage/csv-result-sink.adapter.js'
import { XlsxResultSink } from '../adapters/storage/xlsx-result-sink.adapter.js'
import { CsvUrlSource } from '../adapters/input/csv-url-source.adapter.js'
import { JsonUrlSource } from '../adapters/input/json-url-source.adapter.js'
import { TxtUrlSource } from '../adapters/input/txt-url-source.adapter.js'
import { XlsxUrlSource } from '../adapters/input/xlsx-url-source.adapter.js'
import type { UrlSource } from '../application/ports/url-source.port.js'
import type { CheckpointStore } from '../application/ports/checkpoint-store.port.js'
import type { ParsedIfoodUrl } from '../domain/parsed-ifood-url.types.js'

interface CliArgs {
  input: string
  outputDir: string
  concurrency: number
  timeoutMs: number
  maxRetries: number
  resume: boolean
  headless: boolean
  profileDir: string
  anchorAddress: string
  skipWarm: boolean
  proxy: string | undefined
  proxyUsername: string | undefined
  proxyPassword: string | undefined
  capsolverApiKey: string | undefined
  flaresolverrUrl: string | undefined
  cdpUrl: string | undefined
}

/** Parse de proxy URL no formato `http(s)://user:pass@host:port`.
 *  Username/password também podem vir em env vars separadas (mais seguro). */
function parseProxy(
  url: string | undefined,
  envUser: string | undefined,
  envPass: string | undefined,
): { server: string; username?: string; password?: string } | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    const server = `${u.protocol}//${u.host}`
    const username = u.username || envUser
    const password = u.password ? decodeURIComponent(u.password) : envPass
    const out: { server: string; username?: string; password?: string } = { server }
    if (username) out.username = decodeURIComponent(username)
    if (password) out.password = password
    return out
  } catch {
    throw new Error(`--proxy invalido: ${url} (use http://user:pass@host:port)`)
  }
}

/** Reconstroi a URL completa do proxy no formato esperado pelo CapSolver
 *  (`http://user:pass@host:port`). Retorna `undefined` se o proxy nao tem
 *  credenciais ou nao foi configurado. */
function buildProxyUrl(
  cfg: { server: string; username?: string; password?: string } | undefined,
): string | undefined {
  if (!cfg) return undefined
  if (!cfg.username || !cfg.password) return cfg.server
  try {
    const u = new URL(cfg.server)
    u.username = encodeURIComponent(cfg.username)
    u.password = encodeURIComponent(cfg.password)
    return u.toString().replace(/\/$/u, '')
  } catch {
    return cfg.server
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: '',
    outputDir: 'out',
    concurrency: 3,
    timeoutMs: 30_000,
    maxRetries: 2,
    resume: true,
    headless: false,
    profileDir: 'fixtures/browser-profile',
    anchorAddress: process.env['ANCHOR_ADDRESS'] ?? 'Avenida Paulista, 1000, São Paulo',
    skipWarm: false,
    proxy: process.env['PROXY_SERVER'],
    proxyUsername: process.env['PROXY_USERNAME'],
    proxyPassword: process.env['PROXY_PASSWORD'],
    capsolverApiKey: process.env['CAPSOLVER_API_KEY'],
    flaresolverrUrl: process.env['FLARESOLVERR_URL'],
    cdpUrl: process.env['CDP_URL'],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--input':
        args.input = argv[++i] ?? ''
        break
      case '--output':
        args.outputDir = argv[++i] ?? 'out'
        break
      case '--concurrency':
        args.concurrency = Number(argv[++i])
        break
      case '--timeout':
        args.timeoutMs = Number(argv[++i])
        break
      case '--retries':
        args.maxRetries = Number(argv[++i])
        break
      case '--resume':
        args.resume = true
        break
      case '--no-resume':
        args.resume = false
        break
      case '--headless':
        args.headless = true
        break
      case '--profile':
        args.profileDir = argv[++i] ?? args.profileDir
        break
      case '--anchor-address':
        args.anchorAddress = argv[++i] ?? args.anchorAddress
        break
      case '--skip-warm':
        args.skipWarm = true
        break
      case '--proxy':
        args.proxy = argv[++i] ?? args.proxy
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        if (a && a.startsWith('--')) {
          throw new Error(`Flag desconhecida: ${a}`)
        }
    }
  }
  if (!args.input) {
    printHelp()
    throw new Error('--input é obrigatório')
  }
  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      'Uso: node dist/cli/index.js --input <path> [opcoes]',
      '',
      'Opcoes:',
      '  --input <path>          arquivo CSV/JSON/TXT/XLSX com URLs (obrigatorio)',
      '  --output <dir>          diretorio de saida (default: out/)',
      '  --concurrency <N>       paginas simultaneas (default: 3)',
      '  --timeout <ms>          timeout por URL (default: 30000)',
      '  --retries <N>           tentativas extras p/ erros transientes (default: 2)',
      '  --resume / --no-resume  usar checkpoint (default: --resume)',
      '  --headless              roda em headless (NAO recomendado, ADR-0007)',
      '  --profile <dir>         profile persistente (default: fixtures/browser-profile)',
      '  --anchor-address <s>    endereco-ancora para warm-up (default env ANCHOR_ADDRESS)',
      '  --skip-warm             pula o warm-up automatico (NAO recomendado)',
      '  --proxy <url>           proxy residencial http(s)://user:pass@host:port',
      '                          (ou via env PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD)',
      '',
    ].join('\n'),
  )
}

function pickUrlSource(input: string): UrlSource {
  const ext = extname(input).toLowerCase()
  switch (ext) {
    case '.csv':
      return new CsvUrlSource(input)
    case '.json':
      return new JsonUrlSource(input)
    case '.txt':
      return new TxtUrlSource(input)
    case '.xlsx':
      return new XlsxUrlSource(input)
    default:
      throw new Error(`Extensao nao suportada: ${ext} (use .csv/.json/.txt/.xlsx)`)
  }
}

function noopCheckpoint(): CheckpointStore {
  return {
    load: async () => new Set<string>(),
    markProcessed: async () => {},
    filterUnprocessed: async (urls: string[]) => urls,
    clear: async () => {},
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const logger = createLogger({
    level: (process.env['LOG_LEVEL'] as 'info') ?? 'info',
    pretty: process.env['NODE_ENV'] !== 'production',
  })

  const outputDir = resolve(args.outputDir)
  await mkdir(outputDir, { recursive: true })

  const outputFiles = {
    json: join(outputDir, 'products.json'),
    csv: join(outputDir, 'products.csv'),
    xlsx: join(outputDir, 'products.xlsx'),
    checkpoint: join(outputDir, '.checkpoint.json'),
  }

  logger.info('crawl: iniciando', {
    input: args.input,
    output: outputDir,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
    resume: args.resume,
    headless: args.headless,
  })

  const proxyConfig = parseProxy(args.proxy, args.proxyUsername, args.proxyPassword)
  if (proxyConfig) {
    logger.info('proxy: configurado', {
      server: proxyConfig.server,
      auth: proxyConfig.username ? 'sim' : 'nao',
    })
  }

  // ADR-0009/0010: solver remoto de Cloudflare interstitial JS-only.
  // Prioridade: FLARESOLVERR_URL (gratis, self-hosted) > CAPSOLVER_API_KEY
  // (pago, mais robusto). Quando ambos ausentes, o warm-up cai no solver
  // Turnstile local apenas.
  let cloudflareSolver: ReturnType<typeof createCapSolverCloudflareSolver> | undefined
  if (args.flaresolverrUrl) {
    cloudflareSolver = createFlareSolverrCloudflareSolver({ endpoint: args.flaresolverrUrl })
    logger.info('flaresolverr: solver remoto habilitado', { endpoint: args.flaresolverrUrl })
  } else if (args.capsolverApiKey) {
    cloudflareSolver = createCapSolverCloudflareSolver({ apiKey: args.capsolverApiKey })
    logger.info('capsolver: solver remoto habilitado')
  }

  // URL completa do proxy (http://user:pass@host:port) para enviar ao CapSolver.
  // CF amarra cf_clearance ao IP - solver remoto PRECISA resolver pelo mesmo IP.
  const proxyUrlFull = buildProxyUrl(proxyConfig)

  const pool = new BrowserPool({
    userDataDir: resolve(args.profileDir),
    size: args.concurrency,
    headless: args.headless,
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
    ...(args.cdpUrl ? { cdpUrl: args.cdpUrl } : {}),
  })
  if (args.cdpUrl) {
    logger.info('cdp: conectando ao Chrome externo', { url: args.cdpUrl })
  }
  await pool.init()

  // Warm-up automatico: garante cookie cf_clearance + endereco-ancora setado.
  // Idempotente (early-return se profile ja esta quente).
  if (!args.skipWarm) {
    logger.info('warm-up: iniciando', { address: args.anchorAddress })
    const warmStart = Date.now()
    const outcome = await pool.ensureWarmed({
      address: args.anchorAddress,
      log: (m) => logger.info(`warm-up: ${m}`),
      ...(cloudflareSolver ? { cloudflareSolver } : {}),
      ...(proxyUrlFull ? { proxyUrl: proxyUrlFull } : {}),
    })
    const warmDuration = Date.now() - warmStart
    if (outcome === 'failed') {
      logger.warn('warm-up: falhou - prosseguindo mesmo assim', { durationMs: warmDuration })
    } else {
      logger.info('warm-up: concluido', { outcome, durationMs: warmDuration })
    }
  } else {
    logger.warn('warm-up: pulado via --skip-warm')
  }

  const fetcher = new PlaywrightFetcher({ pool })
  const extractor = new IfoodApiExtractor()
  const sink = new CompositeResultSink([
    new JsonResultSink(outputFiles.json),
    new CsvResultSink(outputFiles.csv),
    new XlsxResultSink(outputFiles.xlsx),
  ])
  const checkpoint: CheckpointStore = args.resume
    ? new FileCheckpointStore(outputFiles.checkpoint)
    : noopCheckpoint()
  const jobQueue = new InMemorySemaphoreQueue<ParsedIfoodUrl>()
  const urlSource = pickUrlSource(args.input)

  const useCase = new CrawlProductsUseCase(
    { urlSource, fetcher, extractor, sink, checkpoint, jobQueue },
    {
      concurrency: args.concurrency,
      maxRetries: args.maxRetries,
      timeoutMs: args.timeoutMs,
      outputFiles: [outputFiles.json, outputFiles.csv, outputFiles.xlsx],
    },
  )

  try {
    const report = await useCase.run()
    logger.info('crawl: concluido', {
      total: report.total_urls,
      successes: report.successes,
      failures: report.failures,
      successRate: report.success_rate_percent,
      throughput: report.throughput_urls_per_minute,
      durationSec: report.duration_seconds,
    })
  } finally {
    await pool.close()
  }
}

main().catch((err) => {
  process.stderr.write(`erro fatal: ${(err as Error).stack ?? String(err)}\n`)
  process.exit(1)
})
