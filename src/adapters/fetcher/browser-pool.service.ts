// Pool de páginas dentro de UM BrowserContext persistente.
//
// Arquitetura (ADR-0006 + ADR-0007):
//
//  - Um único `launchPersistentContext('fixtures/browser-profile/')` por
//    execução. Não dá para abrir N contextos paralelos no mesmo profile
//    (Chrome trava com "profile in use"), e ter cookies compartilhados é
//    justamente o que queremos: cada Page herda o `cf_clearance` aquecido.
//
//  - Concorrência via N páginas (tabs) dentro do mesmo contexto, limitadas
//    por `Semaphore`. Páginas são criadas sob demanda no `acquire()` e
//    fechadas no `release()` para evitar leak de memória.
//
//  - Headful obrigatório (`headless: false`). Em headless puro o endpoint
//    `/site-api/v1/merchants/{m}/items/{i}` retorna 403 mesmo com cookies.
//
// O pool é o único ponto que conhece o profileDir. Adapters de Fetcher
// recebem o pool por injeção e nunca chamam Playwright diretamente.

import type { BrowserContext, Page } from 'playwright'
import { Semaphore } from '../../infrastructure/concurrency/semaphore.util.js'
import { openStealthContext, type ProxyConfig } from './chrome-context.service.js'
import { warmUpSession, type WarmUpOptions, type WarmUpOutcome } from './session-warmer.service.js'

export interface BrowserPoolOptions {
  /** Diretório do profile persistente (criado pelo bootstrap-address.ts). */
  userDataDir: string
  /** Quantas páginas (tabs) podem ficar abertas em paralelo. Default: 3. */
  size?: number
  /** Headless. Default: false (obrigatório em produção, ADR-0007). */
  headless?: boolean
  /** Proxy residencial/datacenter — ADR-0008. Quando setado, todo o tráfego
   *  do contexto (incluindo `page.request.get`) passa pelo proxy. */
  proxy?: ProxyConfig
  /** URL do CDP de um Chrome externo (ex.: http://localhost:9222).
   *  Quando definido, o pool se conecta ao Chrome externo em vez de
   *  lançar um novo processo patchright. */
  cdpUrl?: string
}

export interface LeasedPage {
  page: Page
  /** Devolve a página ao pool (fecha a tab e libera permit). Idempotente. */
  release: () => Promise<void>
}

export class BrowserPool {
  private readonly userDataDir: string
  private readonly size: number
  private readonly headless: boolean
  private readonly proxy: ProxyConfig | undefined
  private readonly cdpUrl: string | undefined
  private readonly semaphore: Semaphore
  private context: BrowserContext | null = null
  private initPromise: Promise<void> | null = null
  private warmPromise: Promise<WarmUpOutcome> | null = null
  private warmed = false
  private closed = false

  constructor(opts: BrowserPoolOptions) {
    this.userDataDir = opts.userDataDir
    this.size = opts.size ?? 3
    this.headless = opts.headless ?? false
    this.proxy = opts.proxy
    this.cdpUrl = opts.cdpUrl
    this.semaphore = new Semaphore(this.size)
  }

  /** Idempotente: pode ser chamado várias vezes; só abre o contexto na 1ª. */
  async init(): Promise<void> {
    if (this.context) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    this.initPromise = (async () => {
      this.context = await openStealthContext({
        userDataDir: this.userDataDir,
        headless: this.headless,
        ...(this.proxy ? { proxy: this.proxy } : {}),
        ...(this.cdpUrl ? { cdpUrl: this.cdpUrl } : {}),
      })
    })()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  /** Pega uma página do pool. Bloqueia se o limite estiver saturado. */
  async acquire(): Promise<LeasedPage> {
    if (this.closed) throw new Error('BrowserPool is closed')
    await this.init()
    const release = await this.semaphore.acquire()
    let page: Page
    try {
      page = await this.context!.newPage()
    } catch (err) {
      release()
      throw err
    }

    let released = false
    const releaseLeased = async (): Promise<void> => {
      if (released) return
      released = true
      try {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false })
      } catch {
        /* tab já fechada por crash — ok */
      } finally {
        release()
      }
    }

    return { page, release: releaseLeased }
  }

  /**
   * Garante que a sessao iFood esta aquecida (cookies CF + endereco-ancora
   * setado). Idempotente: roda no maximo uma vez por instancia do pool.
   * Chamadas concorrentes compartilham a mesma promessa.
   *
   * Deve ser chamado APOS `init()` e ANTES do primeiro `acquire()` real.
   * Aloca temporariamente 1 permit do semaforo (usa 1 das `size` paginas).
   */
  async ensureWarmed(opts: WarmUpOptions = {}): Promise<WarmUpOutcome> {
    if (this.warmed) return 'already-warm'
    if (this.warmPromise) return this.warmPromise
    this.warmPromise = (async () => {
      const lease = await this.acquire()
      try {
        const outcome = await warmUpSession(lease.page, opts)
        if (outcome !== 'failed') this.warmed = true
        return outcome
      } finally {
        await lease.release()
      }
    })()
    try {
      return await this.warmPromise
    } finally {
      this.warmPromise = null
    }
  }

  /** Aguarda todas as leases livres e fecha o contexto. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.semaphore.close()
    if (this.context) {
      try {
        await this.context.close()
      } catch {
        /* contexto já morto — ok */
      }
      this.context = null
    }
  }

  get capacity(): number {
    return this.size
  }
}
