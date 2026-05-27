// JsonResultSink — array JSON único; products[] + { execution_report }.
// Acumula em memória e grava 1 vez em close(). Adequado a <100k URLs.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Product } from '../../domain/product.types.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'
import type { ResultSink } from '../../application/ports/result-sink.port.js'

export class JsonResultSink implements ResultSink {
  private products: Product[] = []

  constructor(private readonly filePath: string) {}

  async open(): Promise<void> {
    this.products = []
    await mkdir(dirname(this.filePath), { recursive: true })
  }

  write(product: Product): Promise<void> {
    this.products.push(product)
    return Promise.resolve()
  }

  async close(report: ExecutionReport): Promise<void> {
    const payload = { products: this.products, execution_report: report }
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), 'utf-8')
  }
}
