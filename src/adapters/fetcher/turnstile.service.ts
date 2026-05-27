// Auto-solver do Cloudflare Turnstile (Managed Challenge inline).
//
// O widget pode estar embebido de duas formas:
//   (a) <iframe> direto no DOM principal (variante classica)
//   (b) Iframe dentro de Shadow DOM (variante moderna, "Managed Challenge"
//       inline): nesse caso `iframe` no DOM principal = 0, mas
//       `page.frames()` mostra o frame de `challenges.cloudflare.com`.
//
// Estrategia: usamos `page.frames()` (que enxerga atraves de shadow
// boundaries) para localizar o frame Turnstile, depois `frameElement()`
// para obter o handle do <iframe> hospedeiro e calcular bounding box.
// Click no centro com mouse real (input nativo do Chrome, nao JS).

import type { Frame, Page } from 'playwright'
import { createCursor } from 'ghost-cursor-playwright'

export type TurnstileOutcome = 'solved' | 'absent' | 'failed'

export interface SolveTurnstileOptions {
  /** Tempo max. esperando o frame Turnstile aparecer. Default 5s. */
  detectTimeoutMs?: number
  /** Tempo max. esperando o desafio resolver apos o gesto. Default 20s. */
  resolveTimeoutMs?: number
  /** Duracao do press-and-hold. Default 7s. */
  holdMs?: number
  /** Callback de log (opcional). */
  log?: (msg: string) => void
}

function findTurnstileFrame(page: Page): Frame | null {
  for (const f of page.frames()) {
    const u = f.url()
    if (
      u.includes('challenges.cloudflare.com') ||
      u.includes('turnstile') ||
      u.includes('cdn-cgi/challenge-platform')
    ) {
      return f
    }
  }
  return null
}

async function waitForTurnstileFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs
  let frame = findTurnstileFrame(page)
  while (!frame && Date.now() < deadline) {
    await page.waitForTimeout(300).catch(() => undefined)
    frame = findTurnstileFrame(page)
  }
  return frame
}

export async function solveTurnstileIfPresent(
  page: Page,
  opts: SolveTurnstileOptions = {},
): Promise<TurnstileOutcome> {
  const detectTimeoutMs = opts.detectTimeoutMs ?? 5_000
  const resolveTimeoutMs = opts.resolveTimeoutMs ?? 20_000
  const holdMs = opts.holdMs ?? 7_000
  const log = opts.log ?? ((): void => {})

  const frame = await waitForTurnstileFrame(page, detectTimeoutMs)
  if (!frame) return 'absent'

  // Handle do <iframe> hospedeiro (funciona mesmo dentro de Shadow DOM).
  let frameElement
  try {
    frameElement = await frame.frameElement()
  } catch {
    log('frameElement() falhou (frame destacado?)')
    return 'failed'
  }

  // Espera o iframe ter dimensoes utilizaveis.
  let box = await frameElement.boundingBox()
  const dimDeadline = Date.now() + 8_000
  while ((!box || box.width < 20 || box.height < 20) && Date.now() < dimDeadline) {
    await page.waitForTimeout(250)
    box = await frameElement.boundingBox()
  }
  if (!box || box.width === 0 || box.height === 0) {
    log('boundingBox invalido (iframe sem dimensoes)')
    return 'failed'
  }

  log(
    `frame detectado: box=${box.width.toFixed(0)}x${box.height.toFixed(0)} @ (${box.x.toFixed(0)},${box.y.toFixed(0)})`,
  )

  // Duas variantes do widget Turnstile:
  //   (1) Checkbox "Confirme que e humano" — checkbox fica a ~30px da borda
  //       esquerda, clique rapido (~150ms) basta.
  //   (2) Press-and-hold "Pressione e segure" — botao no centro, requer hold
  //       longo (7s) com jitter.
  // Tentamos (1) primeiro; se nao resolver em 6s, caimos pra (2).
  const checkboxX = box.x + 30
  const checkboxY = box.y + box.height / 2
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2

  // Captura o valor atual de cf_clearance para detectar solve genuino.
  // CF pode remover o iframe e emitir um NOVO challenge sem definir o cookie
  // (bot-score ainda alto) — verificamos a mudanca do cookie para distinguir
  // solve real de falso-positivo por recarregamento do frame.
  async function getCfClearanceValue(): Promise<string | null> {
    try {
      const cookies = await page
        .context()
        .cookies(['https://www.ifood.com.br', 'https://ifood.com.br'])
      const cf = cookies.find((c) => c.name === 'cf_clearance')
      return cf?.value ?? null
    } catch {
      return null
    }
  }
  const cfClearanceBefore = await getCfClearanceValue()
  log(`cf_clearance antes: ${cfClearanceBefore ? cfClearanceBefore.slice(0, 20) + '…' : 'ausente'}`)

  async function attemptResolve(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await page.waitForTimeout(500).catch(() => undefined)
      if (!findTurnstileFrame(page)) {
        // Iframe sumiu — verificar se cf_clearance foi atualizado (diagnostico).
        // Retornamos 'true' em ambos os casos: o watcher vai contar o ciclo
        // e escalar para o solver remoto apos MAX_LOCAL_TURNSTILE tentativas.
        // O bypass real do CF e medido pela home aparecer, nao pelo cookie aqui.
        const cfNow = await getCfClearanceValue()
        if (cfNow && cfNow !== cfClearanceBefore) {
          log('frame sumiu E cf_clearance atualizado - solve genuino')
        } else {
          log('frame sumiu (cf_clearance sem alteracao - CF pode re-desafiar)')
        }
        return true
      }
      const title = await page.title().catch(() => '')
      if (title && !/momento|verifica|seguranç/i.test(title)) {
        log(`titulo mudou para "${title}" - solved`)
        return true
      }
    }
    return false
  }

  // (1) Checkbox: clique curto a ~30px da borda esquerda, com trajetoria
  // humana (Bezier) via ghost-cursor — evita assinatura mecanica de
  // page.mouse.move linear que o CF Bot Management detecta.
  log(`tentativa 1 (checkbox): clique humanizado em (${checkboxX.toFixed(0)}, ${checkboxY.toFixed(0)})`)
  const cursor = await createCursor(page, { debug: false })
  // Movimento aleatorio antes (humano explora a pagina).
  try {
    await cursor.actions.randomMove()
  } catch {
    /* best-effort */
  }
  await cursor.actions.click({
    target: { x: checkboxX, y: checkboxY },
    waitBeforeClick: [180, 420],
    waitBetweenClick: [80, 160],
  })
  log('checkbox clicado')

  if (await attemptResolve(6_000)) return 'solved'

  // (2) Press-and-hold: trajetoria humanizada ate o centro, depois
  // mouse.down/up manual com jitter (ghost-cursor nao expoe hold).
  log(`tentativa 2 (press-and-hold): hold ${holdMs}ms em (${centerX.toFixed(0)}, ${centerY.toFixed(0)})`)
  await cursor.actions.move({ x: centerX, y: centerY }, { waitBeforeMove: [120, 280] })
  await page.waitForTimeout(180 + Math.random() * 120)
  await page.mouse.down()
  const jitterEnd = Date.now() + holdMs
  while (Date.now() < jitterEnd) {
    const dx = (Math.random() - 0.5) * 2
    const dy = (Math.random() - 0.5) * 2
    await page.mouse.move(centerX + dx, centerY + dy, { steps: 1 })
    await page.waitForTimeout(120 + Math.random() * 80)
  }
  await page.mouse.up()
  log('mouse.up')

  if (await attemptResolve(resolveTimeoutMs)) return 'solved'
  log('frame ainda presente apos ambas tentativas - failed')
  return 'failed'
}

// ---------------------------------------------------------------------------
// PerimeterX / HUMAN Security — challenge "Pressione e segure"
// ---------------------------------------------------------------------------
//
// O PX injeta o challenge em iframes aninhados com url="about:blank".
// O frame container tem name="px-captcha-modal". O botão NÃO é um <button>
// mas um <div role="button" aria-label="Pressione e segure"> — por isso
// page.locator('button:has-text(...)') NÃO funciona. É preciso varrer
// page.frames() e procurar o role="button" dentro dos frames about:blank.
//
// Estrutura detectada em produção:
//   Frame[2]  name="px-captcha-modal"  (container)
//   Frame[4-8] about:blank             (conteúdo do widget PX)
//     └─ <div role="button" aria-label="Pressione e segure">

export type PxChallengeOutcome = 'solved' | 'absent' | 'failed'

export interface SolvePxChallengeOptions {
  /** Timeout detectando o modal. Default 4s. */
  detectTimeoutMs?: number
  /** Duração do hold no botão. Default 5s. */
  holdMs?: number
  /** Timeout aguardando o modal sumir após o hold. Default 12s. */
  resolveTimeoutMs?: number
  /** Callback de log (opcional). */
  log?: (msg: string) => void
}

// Encontra o locator do botão PX em qualquer frame about:blank.
async function findPxLocator(
  page: Page,
): Promise<import('playwright').Locator | null> {
  for (const frame of page.frames()) {
    if (frame.url() !== 'about:blank') continue
    try {
      const btn = frame.locator(
        '[role="button"][aria-label="Pressione e segure"], [role="button"][aria-label="Press and hold"]',
      )
      const count = await btn.count()
      if (count === 0) continue
      const visible = await btn.first().isVisible().catch(() => false)
      if (!visible) continue
      return btn.first()
    } catch {
      /* frame detached */
    }
  }
  return null
}

// Verifica se o PX mostrou "tente outra vez" / "try again" em algum frame.
// Indica que o hold foi detectado mas não passou a verificação — deve-se
// tentar novamente (hold mais firme ou mais longo).
async function hasPxRetryMessage(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (frame.url() !== 'about:blank') continue
    try {
      const found = await frame.evaluate(() => {
        const RETRY_TEXTS = ['tente outra vez', 'try again', 'tente novamente', 'pressione novamente']
        for (const el of document.querySelectorAll('*')) {
          const t = (el.textContent ?? '').toLowerCase().trim()
          if (el.children.length === 0 && RETRY_TEXTS.some((s) => t.includes(s))) return true
        }
        return false
      })
      if (found) return true
    } catch {
      /* frame detached */
    }
  }
  return false
}

// Abordagem ao botão com trajetória em curva natural (Bezier-like).
async function naturalApproach(page: Page, targetX: number, targetY: number): Promise<void> {
  const side = Math.random() > 0.5 ? 1 : -1
  const startX = targetX + side * (120 + Math.random() * 180)
  const startY = targetY + (Math.random() - 0.5) * 160
  await page.mouse.move(startX, startY)
  await page.waitForTimeout(180 + Math.random() * 280)
  const steps = 14 + Math.floor(Math.random() * 10)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    const curve = Math.sin(t * Math.PI) * (6 + Math.random() * 12) * -side
    const x = startX + (targetX - startX) * eased + curve * (1 - t)
    const y = startY + (targetY - startY) * eased + (Math.random() - 0.5) * 2
    await page.mouse.move(x, y)
    await page.waitForTimeout(18 + Math.random() * 36)
  }
  await page.waitForTimeout(350 + Math.random() * 450)
}

// Simula hold fisiológico: respiração + batimento cardíaco + tremor + micro-ajustes.
// O PX analisa os eventos mousemove durante o hold — um jitter uniforme é detectado.
async function physiologicalHold(
  page: Page,
  cx: number,
  cy: number,
  duration: number,
): Promise<void> {
  const breathPeriodS = 4 + Math.random() * 2
  const breathAmpX = 1.2 + Math.random() * 1.8
  const breathAmpY = 0.8 + Math.random() * 1.2
  const heartPeriodS = 0.7 + Math.random() * 0.25
  let elapsed = 0
  let nextAdjust = 2_500 + Math.random() * 2_500
  let adjustOffX = 0
  let adjustOffY = 0
  while (elapsed < duration) {
    const t = elapsed / 1000
    const bx = Math.sin((2 * Math.PI * t) / breathPeriodS) * breathAmpX
    const by = Math.cos((2 * Math.PI * t) / breathPeriodS) * breathAmpY
    const hx = Math.sin((2 * Math.PI * t) / heartPeriodS) * 0.22
    const tx = (Math.random() - 0.5) * 0.7
    const ty = (Math.random() - 0.5) * 0.7
    if (elapsed >= nextAdjust) {
      adjustOffX = Math.max(-3, Math.min(3, adjustOffX + (Math.random() - 0.5) * 2.5))
      adjustOffY = Math.max(-3, Math.min(3, adjustOffY + (Math.random() - 0.5) * 2.5))
      nextAdjust += 3_000 + Math.random() * 2_500
    }
    await page.mouse.move(cx + bx + hx + tx + adjustOffX, cy + by + ty + adjustOffY)
    const tick = 55 + Math.random() * 65
    await page.waitForTimeout(tick)
    elapsed += tick
  }
}

export async function solvePxChallengeIfPresent(
  page: Page,
  opts: SolvePxChallengeOptions = {},
): Promise<PxChallengeOutcome> {
  const detectTimeoutMs = opts.detectTimeoutMs ?? 4_000
  const holdMs = opts.holdMs ?? 15_000
  const resolveTimeoutMs = opts.resolveTimeoutMs ?? 22_000
  const log = opts.log ?? ((): void => {})

  // Aguarda o botão aparecer em qualquer frame about:blank
  const deadline = Date.now() + detectTimeoutMs
  let btn = await findPxLocator(page)
  while (!btn && Date.now() < deadline) {
    await page.waitForTimeout(300)
    btn = await findPxLocator(page)
  }
  if (!btn) return 'absent'

  // Loop interno: repete o hold quando PX exibe "tente outra vez".
  const MAX_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Re-localiza o botão a cada tentativa (pode ter sido recriado pelo PX).
    if (attempt > 0) {
      // Move mouse para longe antes de re-tentar (comportamento humano)
      const vs = page.viewportSize() ?? { width: 1280, height: 720 }
      await page.mouse.move(
        100 + Math.random() * (vs.width * 0.3),
        100 + Math.random() * (vs.height * 0.3),
      )
      await page.waitForTimeout(2_000 + Math.random() * 1_500)
      btn = await findPxLocator(page)
      if (!btn) {
        const pxModal = page.frames().find((f) => f.name() === 'px-captcha-modal')
        if (!pxModal) {
          log('PX: resolvido (modal removido após tente outra vez)')
          return 'solved'
        }
        log('PX: botão desapareceu sem resolver modal')
        return 'failed'
      }
    }

    // Obtém coordenadas do botão via boundingBox
    const absBox = await btn.boundingBox().catch(() => null)
    if (!absBox) {
      log('PX: boundingBox nulo')
      return 'failed'
    }
    const bcx = absBox.x + absBox.width / 2
    const bcy = absBox.y + absBox.height / 2

    log(`PX challenge: hold ${holdMs}ms em (${bcx.toFixed(0)}, ${bcy.toFixed(0)}) [tentativa ${attempt + 1}/${MAX_ATTEMPTS}]`)

    // Abordagem humana ao botão
    await naturalApproach(page, bcx, bcy)

    // Verificar se botão ainda existe após abordagem
    const stillThere = await findPxLocator(page)
    if (!stillThere) {
      log('PX: botão desapareceu durante abordagem')
      return 'solved'
    }

    await page.mouse.down()

    // Hold com simulação fisiológica (respiração + batimento + tremor)
    await physiologicalHold(page, bcx, bcy, holdMs)

    await page.mouse.up()
    log('PX: mouse.up')

    // Aguarda o modal sumir, "tente outra vez", ou timeout
    const resolveDeadline = Date.now() + resolveTimeoutMs
    let gotRetryMsg = false
    while (Date.now() < resolveDeadline) {
      await page.waitForTimeout(400)

      if (await hasPxRetryMessage(page)) {
        log(`PX: "tente outra vez" detectado (tentativa ${attempt + 1}/${MAX_ATTEMPTS})`)
        gotRetryMsg = true
        break
      }

      const pxModal = page.frames().find((f) => f.name() === 'px-captcha-modal')
      if (!pxModal) {
        log('PX: resolvido (frame px-captcha-modal removido)')
        return 'solved'
      }
      const still = await findPxLocator(page)
      if (!still) {
        log('PX: resolvido (botão removido)')
        return 'solved'
      }
    }

    if (!gotRetryMsg) break
  }

  log('PX: modal ainda presente após todas as tentativas')
  return 'failed'
}
