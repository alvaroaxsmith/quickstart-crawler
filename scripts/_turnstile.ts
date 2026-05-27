// Auto-solver para Cloudflare Turnstile "Pressione e segure" (managed challenge).
//
// O Turnstile interativo do iFood renderiza num iframe cross-origin de
// `challenges.cloudflare.com`. O usuário precisa pressionar e segurar o botão
// por ~5-8 segundos para validar. Este módulo automatiza esse gesto via
// `page.mouse.down/up` (movimentos reais do ponteiro do navegador, não JS click).
//
// Estratégia:
//   1. Esperar o iframe do Turnstile aparecer (timeout curto — se ausente,
//      retorna 'absent' e a chamada segue normalmente).
//   2. Calcular o centro do iframe via boundingBox.
//   3. Mover o mouse com `steps` (trajetória humana), pressionar, segurar
//      ~7s, soltar.
//   4. Esperar o iframe sumir (ou marcar 'failed' se persistir).
//
// Reaproveitável: chamado pelo `capture-fixtures.ts` e (futuramente) pelo
// `PlaywrightFetcher` antes de aguardar o endpoint de catálogo.

import type { Page } from 'playwright'

export type TurnstileOutcome = 'solved' | 'absent' | 'failed'

interface SolveOptions {
  /** Tempo máx. esperando o iframe aparecer. Default 5s. */
  detectTimeoutMs?: number
  /** Tempo máx. esperando o iframe sumir após o gesto. Default 15s. */
  resolveTimeoutMs?: number
  /** Duração do press-and-hold. Default 7s (Turnstile costuma exigir 5-8s). */
  holdMs?: number
  /** Habilita logs no stdout. Default true. */
  verbose?: boolean
}

const IFRAME_SELECTOR =
  'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge" i], iframe[title*="verifica" i]'

export async function solveTurnstileIfPresent(
  page: Page,
  opts: SolveOptions = {},
): Promise<TurnstileOutcome> {
  const detectTimeoutMs = opts.detectTimeoutMs ?? 5_000
  const resolveTimeoutMs = opts.resolveTimeoutMs ?? 15_000
  const holdMs = opts.holdMs ?? 7_000
  const log = (m: string): void => {
    if (opts.verbose !== false) process.stdout.write(`    [turnstile] ${m}\n`)
  }

  // 1. Detecção
  const iframe = page.locator(IFRAME_SELECTOR).first()
  try {
    await iframe.waitFor({ state: 'visible', timeout: detectTimeoutMs })
  } catch {
    return 'absent'
  }

  log('iframe detectado, calculando bounding box...')
  const box = await iframe.boundingBox()
  if (!box || box.width === 0 || box.height === 0) {
    log('boundingBox inválido — falha')
    return 'failed'
  }

  // 2. Centro do iframe (o botão "Pressione e segure" fica centralizado dentro
  //    do iframe). Como o iframe é cross-origin, não dá pra inspecionar o
  //    botão interno via DOM — pressionamos no centro, que cobre o widget.
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // 3. Movimento humano até o alvo: 3 paradas com 'steps' (interpolação
  //    suave) — Cloudflare detecta teleportes do cursor.
  log(`movendo mouse para (${cx.toFixed(0)}, ${cy.toFixed(0)})`)
  await page.mouse.move(cx - 80, cy - 40, { steps: 10 })
  await page.waitForTimeout(180 + Math.random() * 120)
  await page.mouse.move(cx - 20, cy - 10, { steps: 8 })
  await page.waitForTimeout(120 + Math.random() * 80)
  await page.mouse.move(cx, cy, { steps: 6 })
  await page.waitForTimeout(150 + Math.random() * 100)

  // 4. Press and hold
  log(`mouse.down, segurando ${holdMs}ms...`)
  await page.mouse.down()
  // Micro-jitter durante o hold (alguns desafios checam ausência total de
  // movimento como sinal de bot). Mantemos perto do centro.
  const jitterEnd = Date.now() + holdMs
  while (Date.now() < jitterEnd) {
    const dx = (Math.random() - 0.5) * 2
    const dy = (Math.random() - 0.5) * 2
    await page.mouse.move(cx + dx, cy + dy, { steps: 1 })
    await page.waitForTimeout(120 + Math.random() * 80)
  }
  await page.mouse.up()
  log('mouse.up')

  // 5. Esperar o iframe sumir (sinal de sucesso)
  try {
    await iframe.waitFor({ state: 'hidden', timeout: resolveTimeoutMs })
    log('iframe sumiu — solved')
    return 'solved'
  } catch {
    log('iframe ainda visível após hold — failed')
    return 'failed'
  }
}
