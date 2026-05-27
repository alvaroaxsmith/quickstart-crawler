import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { JsonResultSink } from '../../../../src/adapters/storage/json-result-sink.adapter.js'
import { CsvResultSink } from '../../../../src/adapters/storage/csv-result-sink.adapter.js'
import { XlsxResultSink } from '../../../../src/adapters/storage/xlsx-result-sink.adapter.js'
import { CompositeResultSink } from '../../../../src/adapters/storage/composite-result-sink.adapter.js'
import {
  createSuccessProduct,
  createErrorProduct,
  type Product,
} from '../../../../src/domain/product.types.js'
import type { ExecutionReport } from '../../../../src/domain/execution-report.types.js'
import { emptyErrorsByCategory } from '../../../../src/domain/execution-report.types.js'

const PRODUCTS: Product[] = [
  createSuccessProduct({
    title: 'Coca-Cola 2L',
    normal_price: 'R$ 12,99',
    discount_price: 'R$ 9,99',
    product_url: 'https://www.ifood.com.br/x?item=1',
    image_url: 'https://img/1.png',
  }),
  createSuccessProduct({
    title: 'Arroz, com vírgula e "aspas"',
    normal_price: null,
    discount_price: null,
    product_url: 'https://www.ifood.com.br/x?item=2',
    image_url: null,
  }),
  createErrorProduct({
    product_url: 'https://www.ifood.com.br/x?item=3',
    error_message: 'TIMEOUT',
  }),
]

const REPORT: ExecutionReport = {
  started_at: '2026-05-24T00:00:00.000Z',
  finished_at: '2026-05-24T00:01:00.000Z',
  duration_seconds: 60,
  total_urls: 3,
  successes: 2,
  failures: 1,
  success_rate_percent: 66.67,
  errors_by_category: { ...emptyErrorsByCategory(), TIMEOUT: 1 },
  latency_ms: { p50: 100, p95: 200, p99: 200, avg: 130 },
  throughput_urls_per_minute: 3,
  output_files: [],
  config_snapshot: { concurrency: 8, max_retries: 3, timeout_ms: 30_000 },
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/sink-`)
})
afterEach(() => {
  rmSync(dir, { recursive: true })
})

describe('JsonResultSink', () => {
  it('grava products + execution_report', async () => {
    const path = join(dir, 'out.json')
    const sink = new JsonResultSink(path)
    await sink.open()
    for (const p of PRODUCTS) await sink.write(p)
    await sink.close(REPORT)

    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.products).toHaveLength(3)
    expect(parsed.products[0].title).toBe('Coca-Cola 2L')
    expect(parsed.execution_report.successes).toBe(2)
  })
})

describe('CsvResultSink', () => {
  it('grava header + 3 linhas escapando vírgula e aspas', async () => {
    const path = join(dir, 'out.csv')
    const sink = new CsvResultSink(path)
    await sink.open()
    for (const p of PRODUCTS) await sink.write(p)
    await sink.close(REPORT)

    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(
      'title,normal_price,discount_price,product_url,image_url,status,error_message',
    )
    expect(lines[2]).toContain('"Arroz, com vírgula e ""aspas"""')
    expect(lines[3]).toContain('error,TIMEOUT')
  })
})

describe('XlsxResultSink', () => {
  it('grava aba products com 3 linhas e aba execution_report', async () => {
    const path = join(dir, 'out.xlsx')
    const sink = new XlsxResultSink(path)
    await sink.open()
    for (const p of PRODUCTS) await sink.write(p)
    await sink.close(REPORT)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(path)
    const ws = wb.getWorksheet('products')!
    // rowCount inclui header
    expect(ws.rowCount).toBe(4)
    expect(ws.getRow(2).getCell(1).value).toBe('Coca-Cola 2L')
    expect(wb.getWorksheet('execution_report')).toBeDefined()
  })
})

describe('CompositeResultSink', () => {
  it('escreve em N sinks em paralelo', async () => {
    const j = join(dir, 'p.json')
    const c = join(dir, 'p.csv')
    const sink = new CompositeResultSink([new JsonResultSink(j), new CsvResultSink(c)])
    await sink.open()
    for (const p of PRODUCTS) await sink.write(p)
    await sink.close(REPORT)

    expect(JSON.parse(readFileSync(j, 'utf-8')).products).toHaveLength(3)
    expect(readFileSync(c, 'utf-8').split('\n').filter((l) => l.length > 0)).toHaveLength(4)
  })
})
