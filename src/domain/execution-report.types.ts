import type { CrawlErrorCategory } from './errors.types.js'

// Relatório agregado emitido ao final da execução. Atende §6.2 (métricas)
// e diferencial §13 (latência p50/p95/p99, throughput).

export interface ExecutionReport {
  started_at: string
  finished_at: string
  duration_seconds: number
  total_urls: number
  successes: number
  failures: number
  success_rate_percent: number
  errors_by_category: Record<CrawlErrorCategory, number>
  latency_ms: {
    p50: number
    p95: number
    p99: number
    avg: number
  }
  throughput_urls_per_minute: number
  output_files: string[]
  config_snapshot: {
    concurrency: number
    max_retries: number
    timeout_ms: number
  }
}

export function emptyErrorsByCategory(): Record<CrawlErrorCategory, number> {
  return {
    TIMEOUT: 0,
    HTTP_ERROR: 0,
    NOT_FOUND: 0,
    BLOCKED: 0,
    INVALID_URL: 0,
    PARSE_FAILURE: 0,
    NETWORK_ERROR: 0,
    OUT_OF_DELIVERY_AREA: 0,
    UNKNOWN: 0,
  }
}
