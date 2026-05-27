// CompositeResultSink — fan-out para N sinks em paralelo.
// open() / write() / close() invocam todos via Promise.all.

import type { Product } from '../../domain/product.types.js'
import type { ExecutionReport } from '../../domain/execution-report.types.js'
import type { ResultSink } from '../../application/ports/result-sink.port.js'

export class CompositeResultSink implements ResultSink {
  constructor(private readonly sinks: ResultSink[]) {}

  async open(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.open()))
  }

  async write(product: Product): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.write(product)))
  }

  async close(report: ExecutionReport): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.close(report)))
  }
}
