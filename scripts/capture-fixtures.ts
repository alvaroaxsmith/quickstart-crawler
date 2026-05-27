// Captura fixtures reais do iFood: HTML, JSON interceptado e screenshot.
// Uso: npx tsx scripts/capture-fixtures.ts [N]
// Lê as primeiras N URLs de input/urls.csv (default 5) e grava em fixtures/.
//
// REQUER fixtures/browser-profile/ criado por scripts/bootstrap-address.ts
// (com endereço setado). Sem isso, o iFood não renderiza preços.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import type { BrowserContext, Page } from 'playwright'
import { openStealthContext } from './_browser.js'
import { solveTurnstileIfPresent } from './_turnstile.service.js'

const ROOT = new URL('..', import.meta.url).pathname
const INPUT = `${ROOT}input/urls.csv`
const OUT = `${ROOT}fixtures/captures`
const PROFILE_DIR = `${ROOT}fixtures/browser-profile`

// Coordenadas da âncora setada por bootstrap-address.ts. Default: Av Paulista, 1000.
const ANCHOR_LAT = process.env.ANCHOR_LAT ?? '-23.564802'
const ANCHOR_LNG = process.env.ANCHOR_LNG ?? '-46.6518207'

interface CaptureResult {
  index: number
  url: string
  status: 'ok' | 'blocked' | 'error' | 'not-found'
  apiHits: { url: string; status: number; bytes: number }[]
  pageStatus: number | null
  title: string | null
  notes: string
  unitPrice?: number
  promotionalPrice?: number
  availability?: string
  merchantAvailable?: boolean
}

async function loadUrls(n: number): Promise<string[]> {
  const raw = await readFile(INPUT, 'utf-8')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  return lines.slice(1, 1 + n)
}

function isApiResponse(url: string): boolean {
  // Captura amplamente: qualquer XHR/fetch JSON do domínio ifood (exceto assets estáticos)
  if (/static-images|googletagmanager|google-analytics|cloudflareinsights|sentry/i.test(url)) {
    return false
  }
  return /\.ifood\.com\.br\//.test(url)
}

// Warm-up humano: simula um usuário chegando na home, olhando, rolando.
// Roda UMA vez por sessão (não por URL) para estabelecer cookies/fingerprint.
async function warmUpSession(ctx: BrowserContext): Promise<void> {
  const page = await ctx.newPage()
  try {
    await page.goto('https://www.ifood.com.br/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await solveTurnstileIfPresent(page, { verbose: true })
    await page.waitForTimeout(1500 + Math.random() * 1500)
    // scroll suave para simular leitura
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(800 + Math.random() * 700)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(800 + Math.random() * 700)
    try {
      await page.waitForLoadState('networkidle', { timeout: 8_000 })
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.warn('warm-up falhou (ignorado):', (err as Error).message)
  } finally {
    await page.close()
  }
}

// Força chamada ao merchant-info/graphql usando os cookies do contexto.
// Garante que sempre teremos o sinal canônico de OUT_OF_DELIVERY_AREA
// (campos `available`, `distance`, `deliveryFee`) mesmo quando a hidratação
// client-side não dispara o XHR sozinha.
async function forceMerchantInfo(
  page: Page,
  refererUrl: string,
): Promise<{ url: string; status: number; bytes: number; body: unknown } | null> {
  const apiUrl =
    `https://www.ifood.com.br/site-api/v1/merchant-info/graphql` +
    `?latitude=${ANCHOR_LAT}&longitude=${ANCHOR_LNG}&channel=IFOOD`
  try {
    const resp = await page.request.get(apiUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: refererUrl,
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: 15_000,
    })
    const text = await resp.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { url: apiUrl, status: resp.status(), bytes: text.length, body }
  } catch {
    return null
  }
}

// Extrai merchantId (4º segmento do path) e itemId (query string ?item=).
// URLs canon: /delivery/{cidade}/{slug}/{merchantId}?item={itemId}
function extractIdsFromUrl(targetUrl: string): { merchantId: string | null; itemId: string | null } {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

// **Endpoint canônico do preço.** Descoberto via probe-catalog.ts.
// Retorna `unitPrice`, `promotionalPrice`, `availability`, `enabled`,
// `description`, `details`, `logoUrl`, `ean`, `externalCode`, `pluCode`.
// 404 = item ou loja inexistente (sinal de MERCHANT_INACTIVE/NOT_FOUND).
async function forceItemEndpoint(
  page: Page,
  merchantId: string,
  itemId: string,
  refererUrl: string,
): Promise<{ url: string; status: number; bytes: number; body: unknown } | null> {
  const apiUrl = `https://www.ifood.com.br/site-api/v1/merchants/${merchantId}/items/${itemId}`
  try {
    const resp = await page.request.get(apiUrl, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: refererUrl,
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      timeout: 15_000,
    })
    const text = await resp.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { url: apiUrl, status: resp.status(), bytes: text.length, body }
  } catch {
    return null
  }
}

async function capturePage(
  ctx: BrowserContext,
  index: number,
  url: string,
): Promise<CaptureResult> {
  const page: Page = await ctx.newPage()
  const apiHits: CaptureResult['apiHits'] = []
  const apiBodies: { url: string; body: unknown }[] = []

  page.on('response', async (resp) => {
    const u = resp.url()
    const ct = resp.headers()['content-type'] ?? ''
    if (!ct.includes('json')) return
    if (!isApiResponse(u)) return
    try {
      const body = (await resp.json()) as unknown
      const bytes = JSON.stringify(body).length
      apiHits.push({ url: u, status: resp.status(), bytes })
      apiBodies.push({ url: u, body })
    } catch {
      /* ignore non-json */
    }
  })

  const prefix = `ifood-product-${String(index).padStart(3, '0')}`
  let pageStatus: number | null = null
  let notes = ''

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    pageStatus = resp?.status() ?? null
    // Tenta resolver Turnstile interativo automaticamente (raro com
    // estratégia direta de API, mas mantemos como salvaguarda).
    const turnstile = await solveTurnstileIfPresent(page, { verbose: true })
    if (turnstile !== 'absent') notes += `turnstile:${turnstile} `
    // Pequena espera para cookies/contexto da loja serem setados.
    try {
      await page.waitForLoadState('networkidle', { timeout: 8_000 })
    } catch {
      notes += 'networkidle-timeout '
    }
  } catch (err) {
    notes += `goto-error:${(err as Error).message.slice(0, 80)} `
  }

  // ===== Estratégia direta de API (descoberta em probe-catalog.ts) =====
  // Em vez de depender da hidratação client-side (atrás de Turnstile e
  // interação humana), chamamos diretamente os endpoints autoritativos
  // usando os cookies aquecidos pelo `page.goto`.
  let unitPrice: number | undefined
  let promotionalPrice: number | undefined
  let availability: string | undefined
  let merchantAvailable: boolean | undefined
  let itemEndpointStatus: number | null = null

  const ids = extractIdsFromUrl(url)
  if (ids.merchantId && ids.itemId) {
    const item = await forceItemEndpoint(page, ids.merchantId, ids.itemId, url)
    if (item) {
      itemEndpointStatus = item.status
      apiHits.push({ url: item.url, status: item.status, bytes: item.bytes })
      apiBodies.push({ url: `${item.url} [forced]`, body: item.body })
      notes += `item-endpoint:${item.status} `
      // Extrai preço/disponibilidade do payload (estrutura conhecida).
      const b = item.body as {
        data?: { menu?: { itens?: { unitPrice?: number; promotionalPrice?: number; availability?: string }[] }[] }
      }
      const first = b?.data?.menu?.[0]?.itens?.[0]
      if (first) {
        unitPrice = first.unitPrice
        promotionalPrice = first.promotionalPrice
        availability = first.availability
      }
    } else {
      notes += 'item-endpoint:error '
    }
  } else {
    notes += 'no-ids-from-url '
  }

  // Sempre busca merchant-info para metadata da loja (available/distance).
  const hasMerchantInfoHit = apiHits.some((h) => /merchant-info\/graphql/.test(h.url))
  if (!hasMerchantInfoHit) {
    const forced = await forceMerchantInfo(page, url)
    if (forced) {
      apiHits.push({ url: forced.url, status: forced.status, bytes: forced.bytes })
      apiBodies.push({ url: `${forced.url} [forced]`, body: forced.body })
      notes += `merchant-info:${forced.status} `
      const mb = forced.body as { data?: { merchant?: { available?: boolean } } }
      merchantAvailable = mb?.data?.merchant?.available
    }
  } else {
    const natural = apiBodies.find((b) => /merchant-info\/graphql/.test(b.url))
    const mb = natural?.body as { data?: { merchant?: { available?: boolean } } } | undefined
    merchantAvailable = mb?.data?.merchant?.available
  }

  const title = await page.title().catch(() => null)
  const html = await page.content()
  await writeFile(`${OUT}/${prefix}.html`, html, 'utf-8')
  await page.screenshot({ path: `${OUT}/${prefix}.png`, fullPage: false }).catch(() => null)
  await writeFile(
    `${OUT}/${prefix}.api.json`,
    JSON.stringify({ url, apiHits: apiBodies }, null, 2),
    'utf-8',
  )

  // Heurística de classificação (item-endpoint é autoritativo):
  //   - 404 no item-endpoint → 'not-found' (loja desativada ou item removido)
  //   - 200 + unitPrice presente → 'ok'
  //   - 200 mas sem unitPrice → 'blocked' (payload incompleto)
  //   - HTTP root >= 400 → 'error'
  //   - resto → 'blocked'
  let status: CaptureResult['status'] = 'blocked'
  if (itemEndpointStatus === 404) {
    status = 'not-found'
    notes += 'item-404 '
  } else if (itemEndpointStatus !== null && itemEndpointStatus >= 200 && itemEndpointStatus < 300) {
    if (unitPrice !== undefined) status = 'ok'
    else notes += 'no-unit-price '
  } else if (pageStatus !== null && pageStatus >= 400) {
    status = 'error'
  }
  if ((title ?? '').toLowerCase().match(/cloudflare|denied|access|block|just a moment/)) {
    status = 'blocked'
  }
  if (html.length < 5000) {
    notes += `tiny-html(${html.length}b) `
  }

  await page.close()
  return {
    index,
    url,
    status,
    apiHits,
    pageStatus,
    title,
    notes: notes.trim(),
    unitPrice,
    promotionalPrice,
    availability,
    merchantAvailable,
  }
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 5)
  await mkdir(OUT, { recursive: true })
  const urls = await loadUrls(n)
  console.log(`Capturando ${urls.length} URLs em ${OUT}`)

  const hasProfile = await access(PROFILE_DIR)
    .then(() => true)
    .catch(() => false)
  if (!hasProfile) {
    console.warn(
      `⚠️  ${PROFILE_DIR} não existe. Rode antes:  npx tsx scripts/bootstrap-address.ts`,
    )
  }

  const ctx = await openStealthContext({ userDataDir: PROFILE_DIR, headless: false })

  console.log('  warm-up: visitando home e simulando navegação humana...')
  await warmUpSession(ctx)

  const results: CaptureResult[] = []
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    if (!url) continue
    process.stdout.write(`  [${i + 1}/${urls.length}] ${url.slice(0, 80)} ... `)
    const r = await capturePage(ctx, i + 1, url)
    results.push(r)
    const priceStr = r.unitPrice !== undefined
      ? ` -> R$ ${r.unitPrice.toFixed(2)}${r.promotionalPrice !== undefined ? ` (promo R$ ${r.promotionalPrice.toFixed(2)})` : ''}`
      : ''
    process.stdout.write(`${r.status} (status=${r.pageStatus}, api=${r.apiHits.length})${priceStr} ${r.notes}\n`)
    // Delay humano entre requests
    await new Promise((res) => setTimeout(res, 1500 + Math.random() * 1000))
  }

  await writeFile(`${OUT}/_summary.json`, JSON.stringify(results, null, 2), 'utf-8')
  await ctx.close()

  const ok = results.filter((r) => r.status === 'ok').length
  console.log(`\nResumo: ${ok}/${results.length} ok. Detalhes em ${OUT}/_summary.json`)
}

try {
  await main()
} catch (err: unknown) {
  console.error('FATAL:', err)
  process.exit(1)
}
