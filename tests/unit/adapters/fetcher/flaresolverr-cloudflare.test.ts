import { describe, expect, it, vi } from 'vitest'
import { createFlareSolverrCloudflareSolver } from '../../../../src/adapters/fetcher/flaresolverr-cloudflare.adapter.js'

function mockFetch(response: { ok?: boolean; status?: number; body: unknown }): {
  fetch: typeof fetch
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  const fakeFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response
  }) as unknown as typeof fetch
  return { fetch: fakeFetch, calls }
}

describe('createFlareSolverrCloudflareSolver', () => {
  it('rejeita endpoint invalido', () => {
    expect(() => createFlareSolverrCloudflareSolver({ endpoint: '' })).toThrow(/endpoint/u)
    expect(() => createFlareSolverrCloudflareSolver({ endpoint: 'not-a-url' })).toThrow(/endpoint/u)
  })

  it('faz POST /v1 com cmd=request.get e devolve cookies + userAgent', async () => {
    const { fetch: f, calls } = mockFetch({
      body: {
        status: 'ok',
        solution: {
          url: 'https://www.ifood.com.br/',
          status: 200,
          cookies: [
            { name: 'cf_clearance', value: 'abc.def', domain: '.ifood.com.br', path: '/' },
            { name: '_cf_bm', value: 'xyz', domain: '.ifood.com.br', path: '/' },
          ],
          userAgent: 'Mozilla/5.0 FlareSolverr Chrome/120',
        },
      },
    })
    const solver = createFlareSolverrCloudflareSolver({
      endpoint: 'http://localhost:8191/v1',
      fetchImpl: f,
    })
    const out = await solver.solve({
      websiteUrl: 'https://www.ifood.com.br/',
      proxyUrl: 'http://u:p@host:1234',
    })
    expect(out.cookies).toHaveLength(2)
    expect(out.cookies[0]).toMatchObject({ name: 'cf_clearance', value: 'abc.def' })
    expect(out.userAgent).toBe('Mozilla/5.0 FlareSolverr Chrome/120')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://localhost:8191/v1')
    const sentBody = calls[0]!.body as Record<string, unknown>
    expect(sentBody['cmd']).toBe('request.get')
    expect(sentBody['url']).toBe('https://www.ifood.com.br/')
    expect(sentBody['proxy']).toEqual({ url: 'http://u:p@host:1234' })
    expect(sentBody['userAgent']).toBeUndefined()
  })

  it('omite proxy quando nao fornecido', async () => {
    const { fetch: f, calls } = mockFetch({
      body: {
        status: 'ok',
        solution: {
          url: 'https://x/',
          status: 200,
          cookies: [{ name: 'cf_clearance', value: 'v', domain: '.x', path: '/' }],
          userAgent: 'UA',
        },
      },
    })
    const solver = createFlareSolverrCloudflareSolver({
      endpoint: 'http://localhost:8191/v1',
      fetchImpl: f,
    })
    await solver.solve({ websiteUrl: 'https://x/' })
    const sentBody = calls[0]!.body as Record<string, unknown>
    expect(sentBody['proxy']).toBeUndefined()
  })

  it('lanca quando status=error', async () => {
    const { fetch: f } = mockFetch({
      body: { status: 'error', message: 'Challenge detection timed out' },
    })
    const solver = createFlareSolverrCloudflareSolver({
      endpoint: 'http://localhost:8191/v1',
      fetchImpl: f,
    })
    await expect(solver.solve({ websiteUrl: 'https://x/' })).rejects.toThrow(/timed out/u)
  })

  it('lanca quando cookies vazios', async () => {
    const { fetch: f } = mockFetch({
      body: {
        status: 'ok',
        solution: { url: 'https://x/', status: 200, cookies: [], userAgent: 'UA' },
      },
    })
    const solver = createFlareSolverrCloudflareSolver({
      endpoint: 'http://localhost:8191/v1',
      fetchImpl: f,
    })
    await expect(solver.solve({ websiteUrl: 'https://x/' })).rejects.toThrow(/sem cookies/u)
  })

  it('lanca quando HTTP nao-ok', async () => {
    const { fetch: f } = mockFetch({ ok: false, status: 500, body: { message: 'oops' } })
    const solver = createFlareSolverrCloudflareSolver({
      endpoint: 'http://localhost:8191/v1',
      fetchImpl: f,
    })
    await expect(solver.solve({ websiteUrl: 'https://x/' })).rejects.toThrow(/HTTP 500/u)
  })
})
