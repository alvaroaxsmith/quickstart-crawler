// CrawlProductsUseCase — orquestra o pipeline completo de crawl.
//
// Fluxo (SPEC §6 + ADRs):
//   1. UrlSource.load()            — origem (CSV/JSON/TXT/XLSX)
//   2. CheckpointStore.filter…    — pula URLs já processadas (--resume)
//   3. valida via parseIfoodUrl    — URLs malformadas viram erro INVALID_URL
//   4. groupByMerchant + split     — buckets para amortizar warm-up
//   5. JobQueue.process            — N workers paralelos
//      por URL: fetch → extract → retry se transient → sink.write → checkpoint
//   6. MetricsCollector.build      — ExecutionReport final
//   7. sink.close(report)          — fecha sinks (escreve report.json, etc.)
//
// O retry é **inline** (KISS-today): se a categoria for transient e ainda
// houver tentativas, aguarda backoff exponencial e tenta de novo. Limite
// configurável via `maxRetries`.

import { createErrorProduct, type Product } from '../../domain/product.types.js'
import { CrawlError, isTransient, type CrawlErrorCategory } from '../../domain/errors.types.js'
import {
  parseIfoodUrl,
  InvalidIfoodUrlError,
  type ParsedIfoodUrl,
} from '../../domain/parsed-ifood-url.types.js'
import { groupByMerchant, splitLargeBuckets } from '../../domain/group-by-merchant.util.js'
import type { UrlSource } from '../ports/url-source.port.js'
import type { PageFetcher } from '../ports/page-fetcher.port.js'
import type { ProductExtractor } from '../ports/product-extractor.port.js'
import type { ResultSink } from '../ports/result-sink.port.js'
import type { CheckpointStore } from '../ports/checkpoint-store.port.js'
import type { JobQueue } from '../ports/job-queue.port.js'
import { MetricsCollector } from '../../infrastructure/metrics/metrics-collector.service.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'

export interface CrawlProductsConfig {
  concurrency: number
  maxRetries: number
  timeoutMs: number
  /** Tamanho máximo de cada bucket de merchant (default: 50). */
  maxBucketSize?: number
  /** Função de espera (injetável para testes). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Lista de arquivos de saída (para `output_files` no report). */
  outputFiles?: string[]
}

export interface CrawlProductsDeps {
  urlSource: UrlSource
  fetcher: PageFetcher
  extractor: ProductExtractor
  sink: ResultSink
  checkpoint: CheckpointStore
  jobQueue: JobQueue<ParsedIfoodUrl>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class CrawlProductsUseCase {
  private readonly deps: CrawlProductsDeps
  private readonly cfg: Required<Omit<CrawlProductsConfig, 'outputFiles'>> & {
    outputFiles: string[]
  }
  private readonly metrics = new MetricsCollector()

  constructor(deps: CrawlProductsDeps, cfg: CrawlProductsConfig) {
    this.deps = deps
    this.cfg = {
      concurrency: cfg.concurrency,
      maxRetries: cfg.maxRetries,
      timeoutMs: cfg.timeoutMs,
      maxBucketSize: cfg.maxBucketSize ?? 50,
      sleep: cfg.sleep ?? defaultSleep,
      outputFiles: cfg.outputFiles ?? [],
    }
  }

  async run(): Promise<ExecutionReport> {
    this.metrics.start()
    await this.deps.sink.open()

    const allUrls = await this.deps.urlSource.load()
    const remaining = await this.deps.checkpoint.filterUnprocessed(allUrls)

    // Particiona URLs em (válidas → buckets ordenados) e (inválidas → erros
    // diretos, contabilizados antes de cair na fila).
    const valid: ParsedIfoodUrl[] = []
    for (const raw of remaining) {
      try {
        valid.push(parseIfoodUrl(raw))
      } catch (err) {
        const startedAt = Date.now()
        const errProduct = createErrorProduct({
          product_url: raw,
          error_message:
            err instanceof InvalidIfoodUrlError
              ? new CrawlError('INVALID_URL').message
              : new CrawlError('UNKNOWN').message,
        })
        await this.deps.sink.write(errProduct)
        this.metrics.recordFailure('INVALID_URL', Date.now() - startedAt)
        await this.deps.checkpoint.markProcessed([raw])
      }
    }

    const buckets = splitLargeBuckets(groupByMerchant(valid), this.cfg.maxBucketSize)
    // Achata buckets em ordem (urls do mesmo merchant ficam adjacentes —
    // workers tendem a herdar cookies aquecidos da URL anterior).
    const ordered: ParsedIfoodUrl[] = buckets.flatMap((b) => b.urls)

    await this.deps.jobQueue.process(
      (parsed) => this.processOne(parsed),
      this.cfg.concurrency,
      ordered,
    )

    const report = this.metrics.build(
      {
        concurrency: this.cfg.concurrency,
        maxRetries: this.cfg.maxRetries,
        timeoutMs: this.cfg.timeoutMs,
      },
      this.cfg.outputFiles,
    )
    await this.deps.sink.close(report)
    return report
  }

  private async processOne(parsed: ParsedIfoodUrl): Promise<void> {
    const startedAt = Date.now()
    let product: Product = createErrorProduct({
      product_url: parsed.raw,
      error_message: new CrawlError('UNKNOWN').message,
    })
    let lastCategory: CrawlErrorCategory = 'UNKNOWN'

    const maxAttempts = this.cfg.maxRetries + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.deps.fetcher.fetch(parsed.raw, { timeoutMs: this.cfg.timeoutMs })
        product = this.deps.extractor.extract(res, parsed.raw)
      } catch (err) {
        lastCategory = categorizeFetchError(err)
        product = createErrorProduct({
          product_url: parsed.raw,
          error_message: new CrawlError(lastCategory, errMsg(err)).message,
        })
      }

      if (product.status === 'success') {
        break
      }

      // Heurística: se a mensagem de erro for de categoria transitória,
      // tenta de novo com backoff.
      const cat = inferCategoryFromMessage(product.error_message ?? '')
      lastCategory = cat
      if (attempt < maxAttempts && isTransient(cat)) {
        const backoffMs = Math.min(2 ** (attempt - 1) * 500, 5_000)
        await this.cfg.sleep(backoffMs)
        continue
      }
      break
    }

    const durationMs = Date.now() - startedAt
    await this.deps.sink.write(product)
    if (product.status === 'success') {
      this.metrics.recordSuccess(durationMs)
    } else {
      this.metrics.recordFailure(lastCategory, durationMs)
    }
    await this.deps.checkpoint.markProcessed([parsed.raw])
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return 'unknown error'
  }
}

function categorizeFetchError(err: unknown): CrawlErrorCategory {
  const msg = errMsg(err).toLowerCase()
  if (msg.includes('timeout')) return 'TIMEOUT'
  if (msg.includes('net::') || msg.includes('econn')) return 'NETWORK_ERROR'
  return 'UNKNOWN'
}

// Recupera a categoria a partir da mensagem (CrawlError formata como
// "<base>: <detail>") — heurística simples mas suficiente para o retry.
function inferCategoryFromMessage(msg: string): CrawlErrorCategory {
  const lower = msg.toLowerCase()
  if (lower.includes('timeout')) return 'TIMEOUT'
  if (lower.includes('bloqueado')) return 'BLOCKED'
  if (lower.includes('http')) return 'HTTP_ERROR'
  if (lower.includes('rede')) return 'NETWORK_ERROR'
  if (lower.includes('indisponível') || lower.includes('removido')) return 'NOT_FOUND'
  if (lower.includes('malformada') || lower.includes('não pertence')) return 'INVALID_URL'
  if (lower.includes('estrutura')) return 'PARSE_FAILURE'
  if (lower.includes('não entrega')) return 'OUT_OF_DELIVERY_AREA'
  return 'UNKNOWN'
}
