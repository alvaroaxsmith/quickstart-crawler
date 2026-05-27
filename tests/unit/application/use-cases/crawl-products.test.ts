import { describe, expect, it, vi } from 'vitest'
import { CrawlProductsUseCase } from '../../../../src/application/use-cases/crawl-products.use-case.js'
import { InMemorySemaphoreQueue } from '../../../../src/infrastructure/concurrency/in-memory-job-queue.impl.js'
import {
  createErrorProduct,
  createSuccessProduct,
  type Product,
} from '../../../../src/domain/product.types.js'
import { CrawlError } from '../../../../src/domain/errors.types.js'
import type { ParsedIfoodUrl } from '../../../../src/domain/parsed-ifood-url.types.js'
import type { FetchResponse, PageFetcher } from '../../../../src/application/ports/page-fetcher.port.js'
import type { ProductExtractor } from '../../../../src/application/ports/product-extractor.port.js'

const validUrl = (item: string): string =>
  `https://www.ifood.com.br/delivery/sao-paulo-sp/loja-x/${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}?item=${item.padStart(8, '0')}-bbbb-bbbb-bbbb-${'b'.repeat(12)}`

function makeDeps(overrides: {
  urls: string[]
  fetcher: PageFetcher
  extractor: ProductExtractor
  written?: Product[]
  processed?: Set<string>
}) {
  const written = overrides.written ?? []
  const processed = overrides.processed ?? new Set<string>()
  return {
    urlSource: { load: async () => overrides.urls },
    fetcher: overrides.fetcher,
    extractor: overrides.extractor,
    sink: {
      open: async () => {},
      write: async (p: Product) => {
        written.push(p)
      },
      close: async () => {},
    },
    checkpoint: {
      load: async () => processed,
      markProcessed: async (urls: string[]) => {
        for (const u of urls) processed.add(u)
      },
      filterUnprocessed: async (urls: string[]) =>
        urls.filter((u) => !processed.has(u)),
      clear: async () => {
        processed.clear()
      },
    },
    jobQueue: new InMemorySemaphoreQueue<ParsedIfoodUrl>(),
    written,
    processed,
  }
}

describe('CrawlProductsUseCase', () => {
  it('happy path: fetch + extract + write + report success', async () => {
    const url = validUrl('1')
    const fakeResponse: FetchResponse = {
      html: '<html></html>',
      httpStatus: 200,
      durationMs: 100,
    }
    const product = createSuccessProduct({
      title: 'Burger',
      normal_price: 'R$ 10,00',
      discount_price: null,
      product_url: url,
      image_url: null,
    })
    const deps = makeDeps({
      urls: [url],
      fetcher: { fetch: vi.fn(async () => fakeResponse) },
      extractor: { extract: vi.fn(() => product) },
    })

    const useCase = new CrawlProductsUseCase(deps, {
      concurrency: 1,
      maxRetries: 0,
      timeoutMs: 30_000,
    })
    const report = await useCase.run()

    expect(deps.written).toHaveLength(1)
    expect(deps.written[0]).toEqual(product)
    expect(report.total_urls).toBe(1)
    expect(report.successes).toBe(1)
    expect(report.failures).toBe(0)
  })

  it('invalid URL goes straight to sink as INVALID_URL error', async () => {
    const deps = makeDeps({
      urls: ['not a url'],
      fetcher: { fetch: vi.fn() },
      extractor: { extract: vi.fn() },
    })
    const useCase = new CrawlProductsUseCase(deps, {
      concurrency: 1,
      maxRetries: 0,
      timeoutMs: 30_000,
    })
    const report = await useCase.run()
    expect(report.failures).toBe(1)
    expect(report.errors_by_category.INVALID_URL).toBe(1)
    expect(deps.written[0]?.status).toBe('error')
    expect(deps.fetcher.fetch).not.toHaveBeenCalled()
  })

  it('retries transient errors up to maxRetries with backoff', async () => {
    const url = validUrl('2')
    const transientErr = createErrorProduct({
      product_url: url,
      error_message: new CrawlError('TIMEOUT').message,
    })
    const success = createSuccessProduct({
      title: 'Burger',
      normal_price: 'R$ 10,00',
      discount_price: null,
      product_url: url,
      image_url: null,
    })
    let calls = 0
    const extractor: ProductExtractor = {
      extract: vi.fn(() => {
        calls += 1
        return calls < 3 ? transientErr : success
      }),
    }
    const deps = makeDeps({
      urls: [url],
      fetcher: { fetch: vi.fn(async () => ({ html: '', httpStatus: 200, durationMs: 1 })) },
      extractor,
    })

    const sleep = vi.fn(async () => {})
    const useCase = new CrawlProductsUseCase(deps, {
      concurrency: 1,
      maxRetries: 3,
      timeoutMs: 30_000,
      sleep,
    })
    const report = await useCase.run()

    expect(extractor.extract).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(report.successes).toBe(1)
  })

  it('does not retry permanent errors', async () => {
    const url = validUrl('3')
    const notFound = createErrorProduct({
      product_url: url,
      error_message: new CrawlError('NOT_FOUND').message,
    })
    const extractor: ProductExtractor = { extract: vi.fn(() => notFound) }
    const deps = makeDeps({
      urls: [url],
      fetcher: { fetch: vi.fn(async () => ({ html: '', httpStatus: 404, durationMs: 1 })) },
      extractor,
    })
    const useCase = new CrawlProductsUseCase(deps, {
      concurrency: 1,
      maxRetries: 3,
      timeoutMs: 30_000,
      sleep: async () => {},
    })
    const report = await useCase.run()
    expect(extractor.extract).toHaveBeenCalledTimes(1)
    expect(report.failures).toBe(1)
    expect(report.errors_by_category.NOT_FOUND).toBe(1)
  })

  it('skips URLs already in checkpoint', async () => {
    const url1 = validUrl('4')
    const url2 = validUrl('5')
    const processed = new Set<string>([url1])
    const extractor: ProductExtractor = {
      extract: vi.fn(() =>
        createSuccessProduct({
          title: 't',
          normal_price: null,
          discount_price: null,
          product_url: url2,
          image_url: null,
        }),
      ),
    }
    const deps = makeDeps({
      urls: [url1, url2],
      fetcher: { fetch: vi.fn(async () => ({ html: '', httpStatus: 200, durationMs: 1 })) },
      extractor,
      processed,
    })
    const useCase = new CrawlProductsUseCase(deps, {
      concurrency: 1,
      maxRetries: 0,
      timeoutMs: 30_000,
    })
    const report = await useCase.run()
    expect(report.total_urls).toBe(1)
    expect(extractor.extract).toHaveBeenCalledTimes(1)
  })
})
