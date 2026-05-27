// SessionWarmer — aquece a sessão do iFood numa Page existente.
//
// Pré-requisito do ADR-0007: o item-endpoint `/site-api/v1/merchants/{m}/items/{i}`
// só retorna 200 se o profile tiver:
//   1. Cookie `cf_clearance` (resolvido via JS challenge + Turnstile)
//   2. Endereço-âncora setado na sessão (selecionado no modal de home)
//
// Esta função é **idempotente** — se a home renderizar imediatamente com
// endereço já persistido no profile (cookies do warm-up anterior), retorna
// 'already-warm' em poucos segundos. Caso contrário, executa o fluxo completo
// (digitar endereço + confirmar localização) e retorna 'warmed'.
//
// Diferente do `scripts/bootstrap-address.ts` (que abre seu próprio contexto),
// este warmer recebe uma Page já aberta — para ser chamado pelo BrowserPool
// sem conflito de profile.

import type { Page } from 'playwright'
import { solveTurnstileIfPresent } from './turnstile.service.js'

export type WarmUpOutcome = 'already-warm' | 'warmed' | 'failed'

/** Cookie pronto para `BrowserContext.addCookies()`. */
export interface CloudflareCookie {
  name: string
  value: string
  domain: string
  path: string
  /** Unix timestamp em segundos. Undefined = cookie de sessao. */
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  /** sameSite=None exige secure=true (Chrome 80+). */
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** Output de um solver remoto de Cloudflare challenge (ADR-0009).
 *  `userAgent` DEVE ser o mesmo usado para resolver o challenge (CF amarra
 *  o cf_clearance ao UA + IP). */
export interface CloudflareSolution {
  cookies: CloudflareCookie[]
  userAgent: string
}

/** Contrato do solver remoto. Implementado por `capsolver-cloudflare.ts`.
 *  Mantemos como uma porta utilitaria (nao no `application/ports/`) porque
 *  o consumidor unico esta no proprio session-warmer (camada de adapter). */
export interface CloudflareSolver {
  solve(req: {
    websiteUrl: string
    /** URL completa http://user:pass@host:port. Obrigatoria quando o
     *  browser esta atras de proxy residencial (cf_clearance amarra IP). */
    proxyUrl?: string
    userAgent?: string
    log?: (msg: string) => void
  }): Promise<CloudflareSolution>
}

export interface WarmUpOptions {
  /** Endereco-ancora. Default: Av. Paulista, 1000, SP. */
  address?: string
  /** Tempo max. esperando Cloudflare liberar. Default 180s. */
  cloudflareTimeoutMs?: number
  /** Delay entre teclas (ms). Default 80ms. */
  typeDelayMs?: number
  /** Solver remoto opcional para Cloudflare interstitial JS-only (ADR-0009).
   *  Quando setado, o warmer delega o estagio 2 do CF a este solver ao
   *  detectar challenge sem widget. */
  cloudflareSolver?: CloudflareSolver
  /** URL completa do proxy (http://user:pass@host:port) enviada ao solver
   *  remoto. Necessaria para que o CF aceite o cf_clearance no mesmo IP. */
  proxyUrl?: string
  /** Callback de log (opcional). */
  log?: (msg: string) => void
}

const DEFAULT_ADDRESS = 'Avenida Paulista, 1000, São Paulo'

export async function warmUpSession(page: Page, opts: WarmUpOptions = {}): Promise<WarmUpOutcome> {
  const address = opts.address ?? DEFAULT_ADDRESS
  const cfTimeoutMs = opts.cloudflareTimeoutMs ?? 180_000
  const typeDelayMs = opts.typeDelayMs ?? 80
  const log = opts.log ?? ((): void => {})
  const remoteSolver = opts.cloudflareSolver
  const proxyUrl = opts.proxyUrl

  // Pré-aquecimento: navegar por um site neutro antes do iFood para
  // estabelecer referrer orgânico + contexto de sessão realista.
  // CF Bot Management usa ML que considera padrões de tráfego — sessões
  // que chegam direto (sem histórico) têm bot-score mais alto.
  log('pre-warm: visitando site neutro para sessao de navegacao organica...')
  await page
    .goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 })
    .catch(() => { /* best-effort — nao bloqueia o fluxo principal */ })
  // Simular leitura breve: aguardar e mover o mouse aleatoriamente.
  await page.waitForTimeout(1_200 + Math.random() * 800).catch(() => undefined)
  await page.mouse
    .move(350 + Math.random() * 350, 200 + Math.random() * 200, { steps: 12 })
    .catch(() => undefined)
  await page.waitForTimeout(600 + Math.random() * 400).catch(() => undefined)

  log(`abrindo home iFood (endereco-alvo: ${address})`)
  await page.goto('https://www.ifood.com.br/', { waitUntil: 'domcontentloaded' })

  // Cloudflare pode renderizar o Turnstile com atraso (alguns segundos apos o
  // DOM carregar). Em vez de uma unica tentativa de detect, rodamos um
  // watcher em loop ate a home ficar pronta ou o timeout estourar.
  //
  // Estrategia 2-estagios (ADR-0008/0009):
  //   1. Tenta solver Turnstile LOCAL (ghost-cursor) -> resolve o widget.
  //   2. Se nao tem widget mas titulo continua "Um momento" (challenge
  //      JS-only sem iframe), delega ao `remoteSolver` (CapSolver), que
  //      devolve `cf_clearance` + UA para injetarmos via context.addCookies.
  const watcherDeadline = Date.now() + cfTimeoutMs
  let watcherStop = false
  let remoteSolverConsumed = false
  // Conta quantas vezes o Turnstile foi "resolvido" localmente sem que a
  // pagina tenha carregado de fato. Apos MAX_LOCAL_TURNSTILE tentativas,
  // assume que o CF esta em loop e delega ao solver remoto (FlareSolverr).
  const MAX_LOCAL_TURNSTILE = 3
  let consecutiveSolvedWithoutProgress = 0
  const turnstileWatcher = (async (): Promise<void> => {
    while (!watcherStop && Date.now() < watcherDeadline) {
      const outcome = await solveTurnstileIfPresent(page, {
        detectTimeoutMs: 3_000,
        resolveTimeoutMs: 20_000,
        log: (m) => log(`turnstile: ${m}`),
      }).catch(() => 'failed' as const)
      if (outcome === 'solved') {
        consecutiveSolvedWithoutProgress++
        log(
          `turnstile resolvido pelo watcher (tentativa ${consecutiveSolvedWithoutProgress}/${MAX_LOCAL_TURNSTILE}) - aguardando CF processar redirect`,
        )
        // Apos resolver, CF roda mais um round de JS challenge silencioso
        // (spinner "Verificando se voce e humano"). Da uma janela para o
        // redirect final acontecer antes de tentar detectar novo desafio.
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
        await page.waitForTimeout(3_000).catch(() => undefined)
        // Se ficamos em loop (CF continua apresentando Turnstile apos varias
        // tentativas locais), delegar ao solver remoto mesmo com iframe visivel.
        if (
          consecutiveSolvedWithoutProgress >= MAX_LOCAL_TURNSTILE &&
          remoteSolver &&
          !remoteSolverConsumed
        ) {
          log(
            `turnstile em loop (${consecutiveSolvedWithoutProgress}x sem progresso) - tentando solver remoto`,
          )
          const consumed = await tryRemoteSolverForced(page, { remoteSolver, proxyUrl, log })
          if (consumed === 'solved') {
            remoteSolverConsumed = true
            consecutiveSolvedWithoutProgress = 0
          }
        }
      } else if (outcome === 'failed') {
        await page.waitForTimeout(1_500).catch(() => undefined)
      } else if (outcome === 'absent' && remoteSolver && !remoteSolverConsumed) {
        consecutiveSolvedWithoutProgress = 0
        const consumed = await tryRemoteSolver(page, { remoteSolver, proxyUrl, log })
        if (consumed === 'solved') remoteSolverConsumed = true
        else if (consumed === 'no-challenge') await page.waitForTimeout(1_000).catch(() => undefined)
        // 'failed' -> deixa remoteSolverConsumed=false para nova tentativa
      } else if (outcome === 'absent') {
        consecutiveSolvedWithoutProgress = 0
      }
    }
  })()

  const homeReady = page.getByRole('link', { name: /mercados|restaurantes/i }).first()
  const addressInput = page
    .getByPlaceholder(/endereço|endereco|onde você está|onde voc[eê] est[áa]|qual o seu endere/i)
    .first()

  log('aguardando Cloudflare liberar...')
  let winner: 'ready' | 'needs-address' | undefined
  try {
    winner = await Promise.race([
      homeReady.waitFor({ state: 'visible', timeout: cfTimeoutMs }).then(() => 'ready' as const),
      addressInput
        .waitFor({ state: 'visible', timeout: cfTimeoutMs })
        .then(() => 'needs-address' as const),
    ])
  } catch {
    watcherStop = true
    await turnstileWatcher.catch(() => undefined)
    log('timeout aguardando home ou input de endereco (tentativas automaticas esgotadas)')

    // Fallback de ultimo recurso: aguardar resolucao MANUAL no browser
    // visivel (headless: false). O usuario ve o Turnstile na janela aberta
    // e clica manualmente — clique humano em Chrome real passa no CF.
    // Aguardamos 120s extra antes de desistir definitivamente.
    winner = (await waitForManualCfSolve(page, 120_000, { log })) ?? undefined

    if (!winner) {
      // Diagnostico: salva screenshot + URL + titulo + lista de frames.
      try {
        const url = page.url()
        const title = await page.title()
        log(`diag: url=${url} title="${title}"`)
        const frames = page.frames()
        log(`diag: total frames=${frames.length}`)
        for (const f of frames) {
          log(`diag:   frame url=${f.url()} name=${f.name()}`)
        }
        const iframeCount = await page.locator('iframe').count()
        log(`diag: <iframe> elements no DOM=${iframeCount}`)
        const dumpPath = `out/warmup-fail-${Date.now()}.png`
        await page.screenshot({ path: dumpPath, fullPage: false })
        log(`diag: screenshot salvo em ${dumpPath}`)
      } catch {
        /* diag best-effort */
      }
      return 'failed'
    }
  }
  watcherStop = true
  await turnstileWatcher.catch(() => undefined)

  if (winner === 'ready') {
    log('profile ja contem endereco - skip')
    return 'already-warm'
  }
  if (!winner) return 'failed' // type guard — nunca deve chegar aqui

  log(`digitando endereco: "${address}"`)
  try {
    await addressInput.click()
    await addressInput.fill('')
    await addressInput.pressSequentially(address, { delay: typeDelayMs })

    log('aguardando sugestoes do autocomplete')
    const firstSuggestion = page
      .locator('[role="option"], [data-testid*="suggestion" i], li[role="listitem"] button, ul li')
      .first()
    await firstSuggestion.waitFor({ state: 'visible', timeout: 15_000 })
    await firstSuggestion.click()
    log('sugestao selecionada')

    log('aguardando modal de confirmacao (opcional)')
    const confirmBtn = page.getByRole('button', {
      name: /confirmar localização|confirmar localizacao|confirmar endere/i,
    })
    const confirmAppeared = await confirmBtn
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (confirmAppeared) {
      await confirmBtn.click()
      log('localizacao confirmada')
    } else {
      log('modal nao apareceu - autocomplete setou direto')
    }

    log('aguardando home re-renderizar')
    const homeSignals = [
      page.getByRole('link', { name: /mercados|restaurantes|farm[áa]cias|lojas/i }).first(),
      page.getByRole('button', { name: /buscar|pesquisar/i }).first(),
      page.locator('[data-testid*="header" i], [data-testid*="address" i]').first(),
    ]
    const homeOk = await Promise.race(
      homeSignals.map((s) =>
        s
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => true)
          .catch(() => false),
      ),
    )
    if (!homeOk) {
      log('nenhum sinal explicito de home - seguindo mesmo assim')
    }
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
    await page.waitForTimeout(2_000)
    log('sessao aquecida')
    return 'warmed'
  } catch (err) {
    log(`falha no warm-up: ${(err as Error).message}`)
    return 'failed'
  }
}

/** Aguarda resolucao MANUAL do CF challenge no browser visivel.
 *
 *  Util quando todos os solvers automaticos falharam. Como o warm-up roda
 *  com headless=false, o usuario ve a janela do Chrome e pode clicar no
 *  Turnstile diretamente. Esta funcao polja ate a home ou o input de
 *  endereco ficarem visiveis, indicando que o CF foi resolvido.
 *
 *  Exibe mensagens de countdown no log a cada 20s para orientar o usuario.
 */
async function waitForManualCfSolve(
  page: import('playwright').Page,
  timeoutMs: number,
  ctx: { log: (m: string) => void },
): Promise<'ready' | 'needs-address' | null> {
  const deadline = Date.now() + timeoutMs
  const homeReady = page.getByRole('link', { name: /mercados|restaurantes/i }).first()
  const addressInput = page
    .getByPlaceholder(/endere[çc]o|endereco|onde voc[êe]/i)
    .first()

  ctx.log(``)
  ctx.log(`╔═══════════════════════════════════════════════════════════╗`)
  ctx.log(`║  ACAO NECESSARIA: Resolva o Turnstile no browser aberto   ║`)
  ctx.log(`║  O Chrome ja esta visivel na tela — clique em "Confirmar  ║`)
  ctx.log(`║  que e humano" e aguarde a pagina do iFood carregar.      ║`)
  ctx.log(`║  Aguardando ate ${Math.ceil(timeoutMs / 1000)}s...                           ║`)
  ctx.log(`╚═══════════════════════════════════════════════════════════╝`)
  ctx.log(``)

  let lastCountdownLog = Date.now()
  while (Date.now() < deadline) {
    const homeVisible = await homeReady.isVisible().catch(() => false)
    if (homeVisible) {
      ctx.log('manual-solve: home detectada — CF resolvido!')
      return 'ready'
    }
    const addrVisible = await addressInput.isVisible().catch(() => false)
    if (addrVisible) {
      ctx.log('manual-solve: input de endereco detectado — CF resolvido!')
      return 'needs-address'
    }
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    if (Date.now() - lastCountdownLog >= 20_000) {
      ctx.log(`manual-solve: aguardando... ${remaining}s restantes. (Resolva o Turnstile no browser)`)
      lastCountdownLog = Date.now()
    }
    await page.waitForTimeout(1_500).catch(() => undefined)
  }
  ctx.log('manual-solve: timeout atingido sem resolucao')
  return null
}

/** Heuristica para detectar o estagio 2 do CF (Managed Challenge JS-only):
 *   - Titulo contem "momento", "verifica" ou "seguranc"
 *   - Nenhum `<iframe>` no DOM (estagio 1 sempre tem o iframe Turnstile)
 *   - URL ainda no host iFood (challenge nao redirecionou para fora) */
async function detectJsChallenge(page: import('playwright').Page): Promise<boolean> {
  const title = await page.title().catch(() => '')
  if (!/momento|verifica|seguran/iu.test(title)) return false
  const iframeCount = await page.locator('iframe').count().catch(() => 0)
  if (iframeCount > 0) return false
  return true
}

/** Resultado de uma tentativa do solver remoto:
 *   'solved'        -> cookies injetados, nao tentar de novo
 *   'failed'        -> tentou e errou (deixa tentar novamente)
 *   'no-challenge'  -> nao havia JS-challenge para resolver */
type RemoteSolveResult = 'solved' | 'failed' | 'no-challenge'

async function tryRemoteSolver(
  page: import('playwright').Page,
  ctx: { remoteSolver: CloudflareSolver; proxyUrl?: string; log: (m: string) => void },
): Promise<RemoteSolveResult> {
  const inJsChallenge = await detectJsChallenge(page).catch(() => false)
  if (!inJsChallenge) return 'no-challenge'
  return tryRemoteSolverForced(page, ctx)
}

/** Versao forcada do solver remoto: nao exige JS-only challenge.
 *  Usada quando o Turnstile fica em loop e as tentativas locais falharam. */
async function tryRemoteSolverForced(
  page: import('playwright').Page,
  ctx: { remoteSolver: CloudflareSolver; proxyUrl?: string; log: (m: string) => void },
): Promise<RemoteSolveResult> {
  try {
    ctx.log('JS-challenge sem widget detectado - delegando para solver remoto')
    const currentUa = await page.evaluate(() => navigator.userAgent).catch(() => undefined)
    const solution = await ctx.remoteSolver.solve({
      websiteUrl: page.url(),
      ...(ctx.proxyUrl ? { proxyUrl: ctx.proxyUrl } : {}),
      ...(currentUa ? { userAgent: currentUa } : {}),
      log: (m) => ctx.log(`capsolver: ${m}`),
    })
    ctx.log(`solver remoto resolveu (${solution.cookies.length} cookie(s))`)
    await page.context().addCookies(
      solution.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        ...(c.expires != null ? { expires: c.expires } : {}),
        ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
        // secure=true obrigatorio quando sameSite=None (Chrome 80+ rejeita se ausente)
        ...(c.secure != null ? { secure: c.secure } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      })),
    )
    // O cf_clearance e amarrado ao (IP + User-Agent) do FlareSolverr.
    // Para que o patchright use esse cookie valido, todos os requests
    // devem sair com o mesmo UA que o FlareSolverr usou ao resolver.
    // Sem isso, o CF detecta UA mismatch e emite novo Turnstile.
    if (solution.userAgent) {
      await page
        .context()
        .setExtraHTTPHeaders({
          'User-Agent': solution.userAgent,
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        })
        .catch((e: unknown) => ctx.log(`setExtraHTTPHeaders falhou: ${(e as Error).message}`))
      ctx.log(`UA do contexto ajustado para ua do solver: ${solution.userAgent.slice(0, 60)}`)
    }
    await page
      .reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch((e: unknown) => ctx.log(`reload pos-solver falhou: ${(e as Error).message}`))
    return 'solved'
  } catch (err) {
    ctx.log(`solver remoto falhou: ${(err as Error).message}`)
    await page.waitForTimeout(2_000).catch(() => undefined)
    return 'failed'
  }
}
