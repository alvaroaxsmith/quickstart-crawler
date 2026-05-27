// CsvResultSink — streaming append, RFC 4180 (escapa aspas duplas e quebras de linha).
// Não persiste o ExecutionReport (CSV é tabular puro). Use JsonResultSink ou
// CompositeResultSink para report.

import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Product } from '../../domain/product.types.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'
import type { ResultSink } from '../../application/ports/result-sink.port.js'

const COLUMNS: (keyof Product)[] = [
  'title',
  'normal_price',
  'discount_price',
  'product_url',
  'image_url',
  'status',
  'error_message',
]

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export class CsvResultSink implements ResultSink {
  private stream: WriteStream | null = null

  constructor(private readonly filePath: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    this.stream = createWriteStream(this.filePath, { encoding: 'utf-8' })
    this.stream.write(COLUMNS.join(',') + '\n')
  }

  write(product: Product): Promise<void> {
    if (!this.stream) throw new Error('CsvResultSink: open() não chamado')
    const line = COLUMNS.map((c) => escapeCell(product[c])).join(',') + '\n'
    this.stream.write(line)
    return Promise.resolve()
  }

  async close(_report: ExecutionReport): Promise<void> {
    const s = this.stream
    if (!s) return
    await new Promise<void>((resolve, reject) => {
      s.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
    this.stream = null
  }
}
