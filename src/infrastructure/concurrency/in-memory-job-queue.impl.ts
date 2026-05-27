// InMemorySemaphoreQueue — implementação primária do port `JobQueue`.
//
// SPEC §6 e ADR-0005 (escalabilidade): N workers compartilhando o mesmo
// pool de browsers, com concorrência limitada por `Semaphore` próprio
// (sem `p-limit`).
//
// Comportamento:
//  - `process(handler, concurrency, jobs)` dispara N workers paralelos.
//  - Erros lançados pelo handler são **contabilizados em `getStats()`**
//    mas NÃO param o batch. A política de retry/erro é responsabilidade
//    do caller (use case).
//  - Determinístico: jobs são consumidos na ordem original.

import { Semaphore } from './semaphore.util.js'
import type { JobQueue, JobQueueStats } from '../../application/ports/job-queue.port.js'

export class InMemorySemaphoreQueue<T> implements JobQueue<T> {
  private pending = 0
  private active = 0
  private completed = 0
  private failed = 0

  async process(
    handler: (job: T) => Promise<void>,
    concurrency: number,
    jobs: T[],
  ): Promise<void> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency must be a positive integer (got ${concurrency})`)
    }
    this.pending = jobs.length
    this.active = 0
    this.completed = 0
    this.failed = 0

    const semaphore = new Semaphore(concurrency)
    const promises: Promise<void>[] = []

    for (const job of jobs) {
      const release = await semaphore.acquire()
      this.pending -= 1
      this.active += 1
      const p = (async () => {
        try {
          await handler(job)
          this.completed += 1
        } catch {
          this.failed += 1
        } finally {
          this.active -= 1
          release()
        }
      })()
      promises.push(p)
    }

    await Promise.all(promises)
    semaphore.close()
  }

  getStats(): JobQueueStats {
    return {
      pending: this.pending,
      active: this.active,
      completed: this.completed,
      failed: this.failed,
    }
  }
}
