// XlsxResultSink — aba "products" com 7 colunas + aba "execution_report" key/value.
// Acumula em memória, grava em close(). Adequado a <50k URLs (limite prático ExcelJS).

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import ExcelJS from 'exceljs'
import type { Product } from '../../domain/product.types.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'
import type { ResultSink } from '../../application/ports/result-sink.port.js'

const HEADERS = [
  'title',
  'normal_price',
  'discount_price',
  'product_url',
  'image_url',
  'status',
  'error_message',
]

export class XlsxResultSink implements ResultSink {
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
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('products')
    ws.addRow(HEADERS)
    for (const p of this.products) {
      ws.addRow([
        p.title,
        p.normal_price,
        p.discount_price,
        p.product_url,
        p.image_url,
        p.status,
        p.error_message,
      ])
    }
    const rs = wb.addWorksheet('execution_report')
    rs.addRow(['key', 'value'])
    for (const [k, v] of Object.entries(report)) {
      rs.addRow([k, typeof v === 'object' ? JSON.stringify(v) : v])
    }
    await wb.xlsx.writeFile(this.filePath)
  }
}
