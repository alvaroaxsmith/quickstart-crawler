// MetricsCollector — agrega contadores e latências para o ExecutionReport.
// Sem deps externas: p50/p95/p99/avg via array sort.

import type { CrawlErrorCategory } from '../../domain/errors.types.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'
import { emptyErrorsByCategory } from '../../domain/execution-report.types.js'

export interface MetricsConfig {
  concurrency: number
  maxRetries: number
  timeoutMs: number
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, idx)]!
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0
  return Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2))
}

export class MetricsCollector {
  private total = 0
  private success = 0
  private failed = 0
  private readonly errorsByCategory = emptyErrorsByCategory()
  private readonly durations: number[] = []
  private startedAt = Date.now()

  start(): void {
    this.startedAt = Date.now()
  }

  recordSuccess(durationMs: number): void {
    this.total++
    this.success++
    this.durations.push(durationMs)
  }

  recordFailure(category: CrawlErrorCategory, durationMs: number): void {
    this.total++
    this.failed++
    this.errorsByCategory[category]++
    this.durations.push(durationMs)
  }

  build(cfg: MetricsConfig, outputFiles: string[] = []): ExecutionReport {
    const elapsedMs = Date.now() - this.startedAt
    const sorted = [...this.durations].sort((a, b) => a - b)
    const rate =
      this.total === 0 ? 0 : Number(((this.success / this.total) * 100).toFixed(2))
    const throughput =
      elapsedMs === 0 ? 0 : Number(((this.total / (elapsedMs / 1000)) * 60).toFixed(2))

    return {
      started_at: new Date(this.startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_seconds: Number((elapsedMs / 1000).toFixed(2)),
      total_urls: this.total,
      successes: this.success,
      failures: this.failed,
      success_rate_percent: rate,
      errors_by_category: { ...this.errorsByCategory },
      latency_ms: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        avg: average(this.durations),
      },
      throughput_urls_per_minute: throughput,
      output_files: outputFiles,
      config_snapshot: {
        concurrency: cfg.concurrency,
        max_retries: cfg.maxRetries,
        timeout_ms: cfg.timeoutMs,
      },
    }
  }
}
