import { describe, expect, it, vi } from 'vitest'
import { createCapSolverCloudflareSolver } from '../../../../src/adapters/fetcher/capsolver-cloudflare.adapter.js'

function mockFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>): {
  fetch: typeof fetch
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  let i = 0
  const fakeFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]!
    i++
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response
  }) as unknown as typeof fetch
  return { fetch: fakeFetch, calls }
}

describe('createCapSolverCloudflareSolver', () => {
  it('rejeita apiKey vazia', () => {
    expect(() => createCapSolverCloudflareSolver({ apiKey: '' })).toThrow(/apiKey/u)
  })

  it('cria task e devolve cookies + userAgent quando status=ready', async () => {
    const { fetch: f, calls } = mockFetch([
      { body: { errorId: 0, taskId: 'task-123' } },
      {
        body: {
          errorId: 0,
          status: 'ready',
          solution: {
            cookies: { cf_clearance: 'abc.def.123' },
            userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/120',
          },
        },
      },
    ])
    const solver = createCapSolverCloudflareSolver({
      apiKey: 'CAP-TEST-123456',
      fetchImpl: f,
      pollIntervalMs: 1,
    })
    const out = await solver.solve({
      websiteUrl: 'https://www.ifood.com.br/',
      proxyUrl: 'http://u:p@host:1234',
      userAgent: 'Mozilla/5.0 original',
    })
    expect(out.cookies).toHaveLength(1)
    expect(out.cookies[0]).toMatchObject({
      name: 'cf_clearance',
      value: 'abc.def.123',
      domain: '.www.ifood.com.br',
      path: '/',
    })
    expect(out.userAgent).toBe('Mozilla/5.0 (X11; Linux) Chrome/120')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toMatch(/createTask$/u)
    const createBody = calls[0]!.body as { task: Record<string, unknown> }
    expect(createBody.task['type']).toBe('AntiCloudflareTask')
    expect(createBody.task['websiteURL']).toBe('https://www.ifood.com.br/')
    expect(createBody.task['proxy']).toBe('http://u:p@host:1234')
    expect(createBody.task['userAgent']).toBe('Mozilla/5.0 original')
    expect(calls[1]!.url).toMatch(/getTaskResult$/u)
  })

  it('aceita cookies como array', async () => {
    const { fetch: f } = mockFetch([
      { body: { errorId: 0, taskId: 't1' } },
      {
        body: {
          errorId: 0,
          status: 'ready',
          solution: {
            cookies: [{ name: 'cf_clearance', value: 'xxx' }],
            userAgent: 'UA',
          },
        },
      },
    ])
    const solver = createCapSolverCloudflareSolver({
      apiKey: 'CAP-TEST-123456',
      fetchImpl: f,
      pollIntervalMs: 1,
    })
    const out = await solver.solve({ websiteUrl: 'https://www.ifood.com.br/' })
    expect(out.cookies).toHaveLength(1)
    expect(out.cookies[0]!.value).toBe('xxx')
  })

  it('lanca quando createTask retorna errorId != 0', async () => {
    const { fetch: f } = mockFetch([
      { body: { errorId: 1, errorCode: 'ERROR_KEY_INVALID', errorDescription: 'bad key' } },
    ])
    const solver = createCapSolverCloudflareSolver({ apiKey: 'CAP-TEST-123456', fetchImpl: f })
    await expect(solver.solve({ websiteUrl: 'https://x/' })).rejects.toThrow(/ERROR_KEY_INVALID/u)
  })

  it('lanca quando status=failed', async () => {
    const { fetch: f } = mockFetch([
      { body: { errorId: 0, taskId: 't1' } },
      { body: { errorId: 0, status: 'failed' } },
    ])
    const solver = createCapSolverCloudflareSolver({
      apiKey: 'CAP-TEST-123456',
      fetchImpl: f,
      pollIntervalMs: 1,
    })
    await expect(solver.solve({ websiteUrl: 'https://x/' })).rejects.toThrow(/failed/u)
  })

  it('faz polling ate status=ready', async () => {
    const { fetch: f, calls } = mockFetch([
      { body: { errorId: 0, taskId: 't1' } },
      { body: { errorId: 0, status: 'processing' } },
      { body: { errorId: 0, status: 'processing' } },
      {
        body: {
          errorId: 0,
          status: 'ready',
          solution: { cookies: { cf_clearance: 'v' }, userAgent: 'UA' },
        },
      },
    ])
    const solver = createCapSolverCloudflareSolver({
      apiKey: 'CAP-TEST-123456',
      fetchImpl: f,
      pollIntervalMs: 1,
    })
    const out = await solver.solve({ websiteUrl: 'https://www.ifood.com.br/' })
    expect(out.cookies).toHaveLength(1)
    expect(calls).toHaveLength(4)
  })

  it('respeita timeout total', async () => {
    const { fetch: f } = mockFetch([
      { body: { errorId: 0, taskId: 't1' } },
      { body: { errorId: 0, status: 'processing' } },
    ])
    const solver = createCapSolverCloudflareSolver({
      apiKey: 'CAP-TEST-123456',
      fetchImpl: f,
      pollIntervalMs: 5,
      timeoutMs: 20,
    })
    await expect(solver.solve({ websiteUrl: 'https://x/' })).rejects.toThrow(/timeout/u)
  })
})
