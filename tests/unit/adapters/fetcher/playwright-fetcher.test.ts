import { describe, expect, it, vi } from 'vitest'
import { PlaywrightFetcher } from '../../../../src/adapters/fetcher/playwright-fetcher.adapter.js'
import type { BrowserPool } from '../../../../src/adapters/fetcher/browser-pool.service.js'

// Mock das dependências externas que exigem browser real.
vi.mock('../../../../src/adapters/fetcher/turnstile.service.js', () => ({
  solvePxChallengeIfPresent: vi.fn().mockResolvedValue('absent'),
}))
vi.mock('../../../../src/adapters/fetcher/session-warmer.service.js', () => ({
  warmUpSession: vi.fn().mockResolvedValue(undefined),
}))

const MERCHANT_ID = '5938ca36-c5ee-455b-b0ce-8211f1921be5'
const ITEM_ID = 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd'
const ITEM_API_URL = `https://www.ifood.com.br/site-api/v1/merchants/${MERCHANT_ID}/items/${ITEM_ID}`

/**
 * Fake `Page` mínimo: imita o que o PlaywrightFetcher usa.
 *
 * `fireItemResponse=true` → simula o React disparando o XHR durante `goto`
 * (caminho primário via `page.on('response', ...)`).
 *
 * `evaluateResult` → resposta para o caminho fallback via `page.evaluate`.
 */
function makeFakePage(opts: {
  gotoStatus?: number
  html?: string
  fireItemResponse?: boolean
  itemStatus?: number
  itemBody?: string
  evaluateThrows?: boolean
}): {
  page: unknown
  releaseSpy: ReturnType<typeof vi.fn>
} {
  const releaseSpy = vi.fn().mockResolvedValue(undefined)
  const responseHandlers: Array<(r: unknown) => Promise<void>> = []

  const page = {
    on: vi.fn().mockImplementation((event: string, handler: (r: unknown) => Promise<void>) => {
      if (event === 'response') responseHandlers.push(handler)
    }),
    off: vi.fn().mockImplementation((_event: string, _handler: unknown) => { /* noop */ }),
    goto: vi.fn().mockImplementation(async () => {
      // Simula o XHR do React sendo interceptado durante a navegação.
      if (opts.fireItemResponse) {
        const status = opts.itemStatus ?? 200
        const body = opts.itemBody ?? '{}'
        const fakeResponse = {
          url: () => ITEM_API_URL,
          status: () => status,
          json: async () => {
            if (status !== 200) throw new Error('not json')
            return JSON.parse(body)
          },
          text: async () => body,
        }
        await Promise.all(responseHandlers.map(h => h(fakeResponse)))
      }
      return { status: () => opts.gotoStatus ?? 200 }
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(opts.html ?? '<html></html>'),
    evaluate: vi.fn().mockImplementation(async () => {
      if (opts.evaluateThrows) throw new Error('aborted')
      return { status: opts.itemStatus ?? 200, text: opts.itemBody ?? '{}' }
    }),
  }

  return { page, releaseSpy }
}

function makeMockPool(page: unknown, releaseSpy: ReturnType<typeof vi.fn>): BrowserPool {
  const acquire = vi.fn().mockResolvedValue({ page, release: releaseSpy })
  return { acquire } as unknown as BrowserPool
}

const VALID_URL =
  'https://www.ifood.com.br/delivery/sp/loja/' +
  `${MERCHANT_ID}` +
  `?item=${ITEM_ID}`

describe('PlaywrightFetcher', () => {
  it('returns parsed itemJson + itemStatus + httpStatus on happy path', async () => {
    const itemBody = JSON.stringify({
      data: { menu: [{ itens: [{ unitPrice: 17.42, availability: 'AVAILABLE' }] }] },
    })
    // Simula o React disparando o XHR durante goto (caminho primário via page.on).
    const { page, releaseSpy } = makeFakePage({ gotoStatus: 200, itemStatus: 200, itemBody, fireItemResponse: true })
    const fetcher = new PlaywrightFetcher({ pool: makeMockPool(page, releaseSpy) })

    const res = await fetcher.fetch(VALID_URL, { timeoutMs: 5000 })

    expect(res.httpStatus).toBe(200)
    expect(res.itemStatus).toBe(200)
    expect(res.itemJson).toMatchObject({
      data: { menu: [{ itens: [{ unitPrice: 17.42 }] }] },
    })
    expect(typeof res.durationMs).toBe('number')
    expect(releaseSpy).toHaveBeenCalledOnce()
  })

  it('propagates itemStatus=404 when item endpoint returns not-found', async () => {
    // Sem interceptação → fallback evaluate retorna {status: 404, text: 'not found'}.
    const { page, releaseSpy } = makeFakePage({ itemStatus: 404, itemBody: 'not found' })
    const fetcher = new PlaywrightFetcher({ pool: makeMockPool(page, releaseSpy) })

    const res = await fetcher.fetch(VALID_URL, { timeoutMs: 5000 })

    expect(res.itemStatus).toBe(404)
    expect(res.itemJson).toBe('not found')
    expect(releaseSpy).toHaveBeenCalledOnce()
  })

  it('skips item-endpoint when URL has no UUIDs and still releases page', async () => {
    const { page, releaseSpy } = makeFakePage({})
    const fetcher = new PlaywrightFetcher({ pool: makeMockPool(page, releaseSpy) })

    const res = await fetcher.fetch('https://www.ifood.com.br/random', { timeoutMs: 5000 })

    expect(res.itemStatus).toBeUndefined()
    expect(res.itemJson).toBeUndefined()
    // evaluate não deve ser chamado quando não há UUIDs na URL
    expect((page as { evaluate: ReturnType<typeof vi.fn> }).evaluate).not.toHaveBeenCalled()
    expect(releaseSpy).toHaveBeenCalledOnce()
  })

  it('releases the page even when item-endpoint throws', async () => {
    const { page, releaseSpy } = makeFakePage({ evaluateThrows: true })
    const fetcher = new PlaywrightFetcher({ pool: makeMockPool(page, releaseSpy) })

    const res = await fetcher.fetch(VALID_URL, { timeoutMs: 5000 })

    expect(res.itemStatus).toBeUndefined()
    expect(releaseSpy).toHaveBeenCalledOnce()
  })
})
