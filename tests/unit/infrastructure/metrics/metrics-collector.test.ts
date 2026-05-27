import { describe, expect, it } from 'vitest'
import { MetricsCollector } from '../../../../src/infrastructure/metrics/metrics-collector.service.js'

const CFG = { concurrency: 8, maxRetries: 3, timeoutMs: 30_000 }

describe('MetricsCollector', () => {
  it('950 success + 50 NOT_FOUND → rate=95.0', () => {
    const m = new MetricsCollector()
    m.start()
    for (let i = 0; i < 950; i++) m.recordSuccess(100)
    for (let i = 0; i < 50; i++) m.recordFailure('NOT_FOUND', 50)
    const r = m.build(CFG)
    expect(r.total_urls).toBe(1000)
    expect(r.successes).toBe(950)
    expect(r.failures).toBe(50)
    expect(r.success_rate_percent).toBe(95.0)
    expect(r.errors_by_category.NOT_FOUND).toBe(50)
    expect(r.errors_by_category.TIMEOUT).toBe(0)
  })

  it('calcula p50/p95/p99 de 100 amostras [1..100]', () => {
    const m = new MetricsCollector()
    m.start()
    for (let i = 1; i <= 100; i++) m.recordSuccess(i)
    const r = m.build(CFG)
    expect(r.latency_ms.p50).toBe(50)
    expect(r.latency_ms.p95).toBe(95)
    expect(r.latency_ms.p99).toBe(99)
    expect(r.latency_ms.avg).toBeCloseTo(50.5, 1)
  })

  it('relatório vazio retorna zeros sem dividir por zero', () => {
    const m = new MetricsCollector()
    m.start()
    const r = m.build(CFG)
    expect(r.total_urls).toBe(0)
    expect(r.success_rate_percent).toBe(0)
    expect(r.latency_ms.p50).toBe(0)
    expect(r.throughput_urls_per_minute).toBe(0)
  })

  it('inclui config_snapshot e output_files', () => {
    const m = new MetricsCollector()
    m.start()
    m.recordSuccess(10)
    const r = m.build(CFG, ['output/products.json', 'output/products.csv'])
    expect(r.config_snapshot).toEqual({ concurrency: 8, max_retries: 3, timeout_ms: 30_000 })
    expect(r.output_files).toHaveLength(2)
  })
})
