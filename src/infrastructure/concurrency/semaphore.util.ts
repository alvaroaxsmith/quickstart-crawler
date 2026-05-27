// Semáforo FIFO simples — controla concorrência sem dependências externas.
//
// SPEC §13 (diferencial): implementação própria, evitando `p-limit` para
// manter zero deps de runtime nesta camada. Usado pelo `BrowserPool` para
// limitar páginas paralelas dentro do mesmo `BrowserContext` persistente
// (ADR-0006/0007).
//
// Garante:
//  - FIFO estrito (acquires resolvem na ordem que pediram)
//  - Reentrância segura: chamar `release()` mais de uma vez é no-op
//  - Sem leak: nenhum waiter fica pendente após `close()`

export interface SemaphoreRelease {
  (): void
}

export class Semaphore {
  private permits: number
  private readonly waiters: Array<(release: SemaphoreRelease) => void> = []
  private closed = false

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore: permits must be a positive integer (got ${permits})`)
    }
    this.permits = permits
  }

  get available(): number {
    return this.permits
  }

  get pending(): number {
    return this.waiters.length
  }

  async acquire(): Promise<SemaphoreRelease> {
    if (this.closed) {
      throw new Error('Semaphore is closed')
    }
    if (this.permits > 0) {
      this.permits -= 1
      return this.makeRelease()
    }
    return new Promise<SemaphoreRelease>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** Encerra o semáforo: rejeita acquires futuros e libera waiters pendentes. */
  close(): void {
    this.closed = true
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!
      // Libera waiters pendentes com release no-op para não travarem.
      w(() => {})
    }
  }

  private makeRelease(): SemaphoreRelease {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        next(this.makeRelease())
      } else {
        this.permits += 1
      }
    }
  }
}
