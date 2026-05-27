// Port: orquestração paralela de jobs (URLs).
// Impl hoje: InMemorySemaphoreQueue (N workers no mesmo processo).
// Impls futuras: BullMqQueue (Redis-backed), SqsQueue.
// Ver ADR-0005 (Roadmap de Escalabilidade).

export interface JobQueueStats {
  pending: number
  active: number
  completed: number
  failed: number
}

export interface JobQueue<T> {
  process(handler: (job: T) => Promise<void>, concurrency: number, jobs: T[]): Promise<void>
  getStats(): JobQueueStats
}
