// Port: persistência de Products + ExecutionReport.
// Impls hoje: JsonResultSink, CsvResultSink, XlsxResultSink, CompositeResultSink.
// Impls futuras: PostgresResultSink, S3ResultSink, KafkaResultSink.

import type { Product } from '../../domain/product.types.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'

export interface ResultSink {
  open(): Promise<void>
  write(product: Product): Promise<void>
  close(report: ExecutionReport): Promise<void>
}
