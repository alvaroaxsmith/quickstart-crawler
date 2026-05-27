// CapSolver — solver remoto para Cloudflare interstitial JS-challenge.
//
// Contexto (ADR-0009):
//   O iFood usa Cloudflare em dois estagios. O estagio 1 (Turnstile widget)
//   o nosso solver local resolve via ghost-cursor. O estagio 2 e um
//   "Managed Challenge" JS-only (sem iframe, sem widget), impossivel de
//   clicar. Para isso terceirizamos para CapSolver via task
//   `AntiCloudflareTask`, que devolve o cookie `cf_clearance` e o
//   User-Agent que foi usado para resolve-lo.
//
// IMPORTANTE: o cookie `cf_clearance` so e valido se a requisicao seguinte
// ao iFood vier do MESMO IP e MESMO User-Agent que o CapSolver usou para
// resolver. Por isso enviamos nosso `proxyUrl` (IPRoyal residencial BR
// sticky) para o CapSolver e, no callsite, sobrescrevemos o UA do browser
// com o `userAgent` devolvido pelo solver antes do `reload()`.
//
// API: https://docs.capsolver.com/guide/captcha/antiCloudflare.html

import type { CloudflareSolution, CloudflareSolver } from './session-warmer.service.js'

export interface CapSolverConfig {
  /** Chave da conta CapSolver. Obtida em https://capsolver.com (dashboard). */
  apiKey: string
  /** Override do endpoint. Default: https://api.capsolver.com */
  baseUrl?: string
  /** Tempo total esperando o `status: "ready"`. Default 120s. */
  timeoutMs?: number
  /** Intervalo de polling do getTaskResult. Default 3s. */
  pollIntervalMs?: number
  /** `fetch` injetavel para testes. Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

interface CreateTaskResponse {
  errorId: number
  errorCode?: string
  errorDescription?: string
  taskId?: string
}

interface GetTaskResultResponse {
  errorId: number
  errorCode?: string
  errorDescription?: string
  status?: 'idle' | 'processing' | 'ready' | 'failed'
  solution?: {
    // Formato AntiCloudflareTask:
    cookies?: Record<string, string> | Array<{ name: string; value: string }>
    userAgent?: string
    // Formato AntiTurnstileTaskProxyLess (token-only) caso seja usado:
    token?: string
  }
}

/** Cria um solver CapSolver de Cloudflare interstitial.
 *
 *  Uso tipico:
 *    const solver = createCapSolverCloudflareSolver({ apiKey: env.CAPSOLVER_API_KEY })
 *    pool.ensureWarmed({ cloudflareSolver: solver, proxyUrl: '...' })
 */
export function createCapSolverCloudflareSolver(config: CapSolverConfig): CloudflareSolver {
  const baseUrl = (config.baseUrl ?? 'https://api.capsolver.com').replace(/\/+$/u, '')
  const timeoutMs = config.timeoutMs ?? 120_000
  const pollIntervalMs = config.pollIntervalMs ?? 3_000
  const httpFetch = config.fetchImpl ?? globalThis.fetch

  if (!config.apiKey || config.apiKey.length < 8) {
    throw new Error('CapSolver: apiKey vazia ou invalida')
  }

  return {
    async solve(req): Promise<CloudflareSolution> {
      const log = req.log ?? ((): void => {})
      log(`createTask websiteURL=${req.websiteUrl}`)

      const task: Record<string, unknown> = {
        type: 'AntiCloudflareTask',
        websiteURL: req.websiteUrl,
        metadata: { type: 'challenge' },
      }
      if (req.proxyUrl) task['proxy'] = req.proxyUrl
      if (req.userAgent) task['userAgent'] = req.userAgent

      const createRes = await httpJson<CreateTaskResponse>(httpFetch, `${baseUrl}/createTask`, {
        clientKey: config.apiKey,
        task,
      })
      if (createRes.errorId !== 0 || !createRes.taskId) {
        throw new Error(
          `CapSolver createTask falhou: ${createRes.errorCode ?? 'unknown'} - ${createRes.errorDescription ?? ''}`,
        )
      }
      log(`taskId=${createRes.taskId} - aguardando resolucao`)

      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs)
        const poll = await httpJson<GetTaskResultResponse>(
          httpFetch,
          `${baseUrl}/getTaskResult`,
          { clientKey: config.apiKey, taskId: createRes.taskId },
        )
        if (poll.errorId !== 0) {
          throw new Error(
            `CapSolver getTaskResult erro: ${poll.errorCode ?? 'unknown'} - ${poll.errorDescription ?? ''}`,
          )
        }
        if (poll.status === 'ready' && poll.solution) {
          const cookies = normalizeCookies(poll.solution.cookies ?? {})
          if (cookies.length === 0) {
            throw new Error('CapSolver: solution.cookies vazio (challenge nao retornou cf_clearance)')
          }
          const userAgent = poll.solution.userAgent ?? req.userAgent ?? ''
          log(`resolvido: ${cookies.length} cookie(s), ua=${userAgent.slice(0, 40)}...`)
          return { cookies, userAgent }
        }
        if (poll.status === 'failed') {
          throw new Error('CapSolver: task status=failed')
        }
        log(`status=${poll.status ?? 'processing'} - continuando polling`)
      }
      throw new Error(`CapSolver: timeout apos ${timeoutMs}ms aguardando resolucao`)
    },
  }
}

/** Normaliza `cookies` do CapSolver para o formato Playwright esperado. */
function normalizeCookies(
  raw: GetTaskResultResponse['solution'] extends infer S
    ? S extends { cookies?: infer C }
      ? C
      : never
    : never,
): CloudflareSolution['cookies'] {
  if (!raw) return []
  const url = new URL('https://www.ifood.com.br/')
  const out: CloudflareSolution['cookies'] = []
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c && typeof c.name === 'string' && typeof c.value === 'string') {
        out.push({ name: c.name, value: c.value, domain: `.${url.hostname}`, path: '/' })
      }
    }
  } else if (typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        out.push({ name, value, domain: `.${url.hostname}`, path: '/' })
      }
    }
  }
  return out
}

async function httpJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`CapSolver HTTP ${res.status} ${url}: ${txt.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
