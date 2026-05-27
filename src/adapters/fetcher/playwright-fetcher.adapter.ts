// PlaywrightFetcher — implementação primária do port `PageFetcher` (ADR-0007).
//
// Fluxo por URL:
//   1. Adquire uma página do `BrowserPool` (tab no contexto persistente).
//   2. `page.goto(url, domcontentloaded)` para esquentar cookies da sessão
//      (`cf_clearance`, anti-bot, endereço-âncora).
//   3. Extrai merchantId e itemId determinísticamente da URL (sem DOM).
//   4. `page.request.get('/site-api/v1/merchants/{m}/items/{i}')` — endpoint
//      canônico descoberto via `probe-catalog.ts`. Devolve unitPrice,
//      promotionalPrice, availability, enabled, etc.
//   5. Captura o HTML do SSR como fallback para `__NEXT_DATA__.productData`.
//   6. Libera a página de volta para o pool.
//
// Erros são propagados como exceções tipadas para o caller decidir a
// `CrawlErrorCategory`. Aqui não classificamos — apenas reportamos status.

import type { FetchResponse, PageFetcher } from '../../application/ports/page-fetcher.port.js'
import type { BrowserPool } from './browser-pool.service.js'
import { solvePxChallengeIfPresent } from './turnstile.service.js'
import { warmUpSession } from './session-warmer.service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ITEM_ENDPOINT = (merchantId: string, itemId: string): string =>
  `https://www.ifood.com.br/site-api/v1/merchants/${merchantId}/items/${itemId}`

export interface ExtractedIds {
  merchantId: string | null
  itemId: string | null
}

/**
 * URLs canônicas: `/delivery/{cidade}/{slug}/{merchantId}?item={itemId}`.
 * Retorna `null` em ambos os campos quando a URL não bate com o padrão.
 */
export function extractIdsFromUrl(targetUrl: string): ExtractedIds {
  try {
    const u = new URL(targetUrl)
    const parts = u.pathname.split('/').filter(Boolean)
    const merchantId = parts[3] && UUID_RE.test(parts[3]) ? parts[3] : null
    const itemRaw = u.searchParams.get('item')
    const itemId = itemRaw && UUID_RE.test(itemRaw) ? itemRaw : null
    return { merchantId, itemId }
  } catch {
    return { merchantId: null, itemId: null }
  }
}

export interface PlaywrightFetcherOptions {
  pool: BrowserPool
  /** Tempo extra para networkidle após o goto. Default: 4000ms. */
  networkIdleTimeoutMs?: number
}

export class PlaywrightFetcher implements PageFetcher {
  private readonly pool: BrowserPool
  private readonly networkIdleTimeoutMs: number

  constructor(opts: PlaywrightFetcherOptions) {
    this.pool = opts.pool
    this.networkIdleTimeoutMs = opts.networkIdleTimeoutMs ?? 4_000
  }

  async fetch(url: string, options: { timeoutMs: number }): Promise<FetchResponse> {
    const startedAt = Date.now()
    const lease = await this.pool.acquire()
    try {
      // Intercepta o XHR que o próprio React faz para o item-endpoint.
      // IMPORTANTE: usar page.on('response') em vez de page.request.get() —
      // o React envia Sec-Fetch-Mode/Site/Dest corretos + _px3 cookie que
      // identifica o request como XHR legítimo do browser. Uma chamada direta
      // via page.request.get() não carrega esses headers e é bloqueada pelo
      // PerimeterX após ~17 requests.
      const ids = extractIdsFromUrl(url)
      let capturedItemJson: unknown
      let capturedItemStatus: number | undefined
      let capturedItemUrl: string | undefined

      const onResponse = async (res: import('playwright').Response) => {
        const resUrl = res.url()
        if (
          ids.merchantId &&
          ids.itemId &&
          resUrl.includes(ids.merchantId) &&
          resUrl.includes('/items/') &&
          resUrl.includes(ids.itemId)
        ) {
          capturedItemUrl = resUrl
          capturedItemStatus = res.status()
          if (capturedItemStatus === 200) {
            try {
              capturedItemJson = await res.json()
            } catch {
              capturedItemJson = await res.text().catch(() => '')
            }
          }
        }
      }

      lease.page.on('response', onResponse)

      let resp: import('playwright').Response | null = null
      try {
        resp = await lease.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: options.timeoutMs,
        })
      } finally {
        // Remove listener antes de qualquer await adicional para não vazar.
        // (o listener pode ainda capturar resposta durante networkidle abaixo)
      }

      const httpStatus = resp?.status() ?? 0

      // Resolve challenge PX "Pressione e segure" — pode reaparecer até 3x
      // com hold progressivamente mais longo (PX progressive challenge).
      // Após cada solve, re-aguarda networkidle pois React re-dispara XHRs.
      const PX_HOLD_SCHEDULE = [5_000, 8_000, 12_000]
      for (let pxRound = 0; pxRound < PX_HOLD_SCHEDULE.length; pxRound++) {
        const outcome = await solvePxChallengeIfPresent(lease.page, {
          detectTimeoutMs: 5_000,
          holdMs: PX_HOLD_SCHEDULE[pxRound],
          resolveTimeoutMs: 12_000,
        })
        if (outcome === 'absent') break // sem challenge (ou foi resolvido e não reapareceu)
        if (outcome === 'failed') break // hold não convenceu o PX — desiste
        // outcome === 'solved': aguarda XHRs e verifica reapresentação
        try {
          await lease.page.waitForLoadState('networkidle', {
            timeout: this.networkIdleTimeoutMs + 4_000,
          })
        } catch {
          /* ok */
        }
      }

      // Aguarda React fazer os XHRs (item-endpoint dispara durante hydration).
      try {
        await lease.page.waitForLoadState('networkidle', {
          timeout: this.networkIdleTimeoutMs,
        })
      } catch {
        /* networkidle timeout — ok */
      }

      lease.page.off('response', onResponse)

      let html = await lease.page.content().catch(() => '')

      // Fallback: se o React não fez o XHR (ex.: SSR puro ou produto removido),
      // tenta chamada direta — mas só se ainda não temos dados do interceptor.
      let itemJson = capturedItemJson
      let itemStatus = capturedItemStatus

      if (itemStatus === undefined && ids.merchantId && ids.itemId) {
        // Usa a URL real capturada do XHR do React (tem o merchant-type correto),
        // ou cai no endpoint canônico como fallback.
        const apiUrl = capturedItemUrl ?? ITEM_ENDPOINT(ids.merchantId, ids.itemId)
        try {
          // page.evaluate(fetch) é tratado como XHR legítimo pelo PerimeterX
          // (passa _px3 + Sec-Fetch headers corretos), ao contrário de
          // page.request.get() que não replica o contexto de fetch do browser.
          const result = await lease.page.evaluate(
            async ({ u, referer }: { u: string; referer: string }) => {
              const r = await fetch(u, {
                headers: {
                  Accept: 'application/json, text/plain, */*',
                  Referer: referer,
                  'Accept-Language': 'pt-BR,pt;q=0.9',
                },
              })
              return { status: r.status, text: await r.text() }
            },
            { u: apiUrl, referer: url },
          )
          itemStatus = result.status
          try {
            itemJson = JSON.parse(result.text)
          } catch {
            itemJson = result.text
          }
        } catch {
          /* timeout/abort — caller decide via itemStatus=undefined */
        }
      }

      // Re-warm on 403: sessão queimada pelo PX → re-aquece a sessão e tenta uma vez mais.
      if (itemStatus === 403 && ids.merchantId && ids.itemId) {
        try { await warmUpSession(lease.page) } catch { /* warm falhou — retorna 403 original */ }

        // Reset estado capturado e re-navega
        capturedItemJson = undefined
        capturedItemStatus = undefined
        capturedItemUrl = undefined
        lease.page.on('response', onResponse)

        try {
          await lease.page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
        } catch { /* timeout — continua com o que tiver */ }

        for (const holdMs of PX_HOLD_SCHEDULE) {
          const outcome = await solvePxChallengeIfPresent(lease.page, {
            detectTimeoutMs: 5_000,
            holdMs,
            resolveTimeoutMs: 12_000,
          })
          if (outcome === 'absent' || outcome === 'failed') break
          await lease.page.waitForLoadState('networkidle', { timeout: this.networkIdleTimeoutMs + 4_000 }).catch(() => {})
        }
        await lease.page.waitForLoadState('networkidle', { timeout: this.networkIdleTimeoutMs }).catch(() => {})
        lease.page.off('response', onResponse)

        // Fallback fetch do retry
        if (capturedItemStatus === undefined) {
          const apiUrl = capturedItemUrl ?? ITEM_ENDPOINT(ids.merchantId, ids.itemId)
          try {
            const result = await lease.page.evaluate(
              async ({ u, referer }: { u: string; referer: string }) => {
                const r = await fetch(u, {
                  headers: {
                    Accept: 'application/json, text/plain, */*',
                    Referer: referer,
                    'Accept-Language': 'pt-BR,pt;q=0.9',
                  },
                })
                return { status: r.status, text: await r.text() }
              },
              { u: apiUrl, referer: url },
            )
            capturedItemStatus = result.status
            try { capturedItemJson = JSON.parse(result.text) } catch { capturedItemJson = result.text }
          } catch { /* timeout */ }
        }

        html = await lease.page.content().catch(() => html)
        itemJson = capturedItemJson
        itemStatus = capturedItemStatus
      }

      return {
        html,
        itemJson,
        itemStatus,
        httpStatus,
        durationMs: Date.now() - startedAt,
      }
    } finally {
      await lease.release()
    }
  }
}

