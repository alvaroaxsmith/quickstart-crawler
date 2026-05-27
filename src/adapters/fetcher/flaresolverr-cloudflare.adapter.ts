// FlareSolverr — solver self-hosted (gratuito) para Cloudflare challenge.
//
// Alternativa open-source ao CapSolver (ADR-0009). FlareSolverr e um
// servico Docker (https://github.com/FlareSolverr/FlareSolverr) que sobe
// um Chrome stealth internamente, navega a URL alvo, resolve o CF
// challenge e devolve cookies + UA via HTTP.
//
// Trade-offs vs. CapSolver:
//   + Gratuito, self-hosted, sem chamada paga.
//   - Taxa de sucesso menor contra CF moderno (~30-50% em CF Bot Mgmt
//     enterprise vs. ~85-95% do CapSolver).
//   - Latencia 10-30s (mais alta).
//   - Manutencao por sua conta: quando o CF atualiza fingerprints, o
//     servico fica offline ate a comunidade publicar nova release.
//
// Como subir (Docker):
//   docker run -d --name flaresolverr -p 8191:8191 \
//     -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest
//
// Endpoint: POST http://<host>:8191/v1
// Docs: https://github.com/FlareSolverr/FlareSolverr#commands

import type { CloudflareSolution, CloudflareSolver } from './session-warmer.service.js'

export interface FlareSolverrConfig {
  /** URL do servico. Ex.: `http://localhost:8191/v1`. */
  endpoint: string
  /** Timeout maximo enviado ao FlareSolverr (campo `maxTimeout`).
   *  Default 60_000 (60s). */
  maxTimeoutMs?: number
  /** Timeout do fetch HTTP (deve ser >= maxTimeoutMs + folga). Default 90s. */
  httpTimeoutMs?: number
  /** `fetch` injetavel para testes. Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

interface FlareSolverrResponse {
  status: 'ok' | 'error'
  message?: string
  solution?: {
    url: string
    status: number
    cookies?: Array<{
      name: string
      value: string
      domain: string
      path: string
      expiry?: number
      httpOnly?: boolean
      secure?: boolean
      sameSite?: string
    }>
    userAgent?: string
  }
}

/** Cria um solver FlareSolverr de Cloudflare challenge.
 *
 *  Uso tipico:
 *    const solver = createFlareSolverrCloudflareSolver({
 *      endpoint: env.FLARESOLVERR_URL
 *    })
 *    pool.ensureWarmed({ cloudflareSolver: solver, proxyUrl: '...' })
 */
export function createFlareSolverrCloudflareSolver(
  config: FlareSolverrConfig,
): CloudflareSolver {
  if (!config.endpoint || !/^https?:\/\//u.test(config.endpoint)) {
    throw new Error('FlareSolverr: endpoint invalido (use http://host:port/v1)')
  }
  const endpoint = config.endpoint.replace(/\/+$/u, '')
  const maxTimeoutMs = config.maxTimeoutMs ?? 60_000
  const httpTimeoutMs = config.httpTimeoutMs ?? 90_000
  const httpFetch = config.fetchImpl ?? globalThis.fetch

  return {
    async solve(req): Promise<CloudflareSolution> {
      const log = req.log ?? ((): void => {})
      log(`request.get url=${req.websiteUrl}`)

      const body: Record<string, unknown> = {
        cmd: 'request.get',
        url: req.websiteUrl,
        maxTimeout: maxTimeoutMs,
      }
      if (req.proxyUrl) body['proxy'] = { url: req.proxyUrl }
      // userAgent NAO e enviado: FlareSolverr usa o UA do Chrome interno
      // dele. Se sobrescrevermos, CF rejeita por mismatch UA<->fingerprint.

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), httpTimeoutMs)
      let res: Response
      try {
        res = await httpFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`FlareSolverr HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }
      const parsed = (await res.json()) as FlareSolverrResponse
      if (parsed.status !== 'ok' || !parsed.solution) {
        throw new Error(`FlareSolverr erro: ${parsed.message ?? 'unknown'}`)
      }
      const rawCookies = parsed.solution.cookies ?? []
      const cookies: CloudflareSolution['cookies'] = rawCookies
        .filter((c) => typeof c.name === 'string' && typeof c.value === 'string')
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          // Preservar atributos: FlareSolverr usa 'expiry' (Selenium), Playwright usa 'expires'
          ...(c.expiry != null ? { expires: Number(c.expiry) } : {}),
          ...(c.httpOnly != null ? { httpOnly: Boolean(c.httpOnly) } : {}),
          ...(c.secure != null ? { secure: Boolean(c.secure) } : {}),
          // sameSite=None sem secure=true e rejeitado pelo Chrome 80+
          ...(c.sameSite ? { sameSite: c.sameSite as 'Strict' | 'Lax' | 'None' } : {}),
        }))
      if (cookies.length === 0) {
        throw new Error('FlareSolverr: solucao sem cookies (challenge nao resolvido)')
      }
      const userAgent = parsed.solution.userAgent ?? req.userAgent ?? ''
      log(`resolvido: ${cookies.length} cookie(s), ua=${userAgent.slice(0, 40)}...`)
      return { cookies, userAgent }
    },
  }
}
