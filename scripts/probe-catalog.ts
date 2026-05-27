// Sonda endpoints candidatos para o catálogo/preço do item iFood.
// Uso: npx tsx scripts/probe-catalog.ts
//
// Estratégia: usa o mesmo contexto/cookies do profile (já bootstrapped),
// extrai IDs conhecidos da captura #1 do _summary, monta uma lista de URLs
// candidatas e dispara GET em cada uma via page.request. Reporta status,
// tamanho e se o body contém marcadores de preço.

import { openStealthContext } from './_browser.js'
import { solveTurnstileIfPresent } from './_turnstile.service.js'
import { writeFile, mkdir } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url).pathname
const PROFILE_DIR = `${ROOT}fixtures/browser-profile`

const ANCHOR_LAT = process.env.ANCHOR_LAT ?? '-23.564802'
const ANCHOR_LNG = process.env.ANCHOR_LNG ?? '-46.6518207'

// IDs conhecidos da captura #1 (Pão de Açúcar - Águas Claras / Veja Limão 500ml)
const MERCHANT_ID = '5938ca36-c5ee-455b-b0ce-8211f1921be5'
const ITEM_ID = 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd'
const CATALOG_GROUP = 'ffca0022-eb43-4205-9a1b-73a72f8e3f95'
const REGION_GROUP = 'e1dbd9d8-45d6-4b33-aafc-417b8d69b06d'
const REFERER = `https://www.ifood.com.br/delivery/brasilia-df/pao-de-acucar---aguas-claras-sul-a/${MERCHANT_ID}?item=${ITEM_ID}`

const COORDS = `latitude=${ANCHOR_LAT}&longitude=${ANCHOR_LNG}`
void REGION_GROUP // reservado p/ variantes futuras

const CANDIDATES: string[] = [
  // v2/categories — confirmado capturado antes (486b, lista simples)
  `https://www.ifood.com.br/site-api/v2/categories?merchantUuid=${MERCHANT_ID}`,
  `https://www.ifood.com.br/site-api/v2/categories?merchantId=${MERCHANT_ID}`,
  // catálogo por merchant
  `https://www.ifood.com.br/site-api/v1/catalog/${MERCHANT_ID}`,
  `https://www.ifood.com.br/site-api/v2/catalog/${MERCHANT_ID}`,
  `https://www.ifood.com.br/site-api/v3/catalog/${MERCHANT_ID}`,
  `https://www.ifood.com.br/site-api/v1/merchants/${MERCHANT_ID}/catalog`,
  `https://www.ifood.com.br/site-api/v1/merchant/${MERCHANT_ID}/catalog`,
  `https://www.ifood.com.br/site-api/v3/merchants/${MERCHANT_ID}/catalog?${COORDS}`,
  // menu por merchant
  `https://www.ifood.com.br/site-api/v1/merchant-menu/${MERCHANT_ID}`,
  `https://www.ifood.com.br/site-api/v1/merchants/${MERCHANT_ID}/menu`,
  `https://www.ifood.com.br/site-api/v3/merchants/${MERCHANT_ID}/menu?${COORDS}`,
  // item direto
  `https://www.ifood.com.br/site-api/v1/items/${ITEM_ID}`,
  `https://www.ifood.com.br/site-api/v1/item/${ITEM_ID}`,
  `https://www.ifood.com.br/site-api/v2/items/${ITEM_ID}`,
  `https://www.ifood.com.br/site-api/v3/items/${ITEM_ID}`,
  `https://www.ifood.com.br/site-api/v1/merchants/${MERCHANT_ID}/items/${ITEM_ID}`,
  `https://www.ifood.com.br/site-api/v3/merchants/${MERCHANT_ID}/items/${ITEM_ID}?${COORDS}`,
  // catalog-group
  `https://www.ifood.com.br/site-api/v1/catalog-group/${CATALOG_GROUP}`,
  `https://www.ifood.com.br/site-api/v1/catalog-groups/${CATALOG_GROUP}/items/${ITEM_ID}`,
  `https://www.ifood.com.br/site-api/v1/catalogs/${CATALOG_GROUP}/items/${ITEM_ID}`,
  // graphql variants
  `https://www.ifood.com.br/site-api/v1/menu/graphql?merchantId=${MERCHANT_ID}&${COORDS}`,
  `https://www.ifood.com.br/site-api/v1/item-info/graphql?itemId=${ITEM_ID}&${COORDS}`,
  `https://www.ifood.com.br/site-api/v1/item/graphql?itemId=${ITEM_ID}&merchantId=${MERCHANT_ID}&${COORDS}`,
  // consumer-api (algumas chamadas do app vão direto pro consumer-api)
  `https://consumer-api.ifood.com.br/items/${ITEM_ID}`,
  `https://consumer-api.ifood.com.br/v1/items/${ITEM_ID}`,
  `https://consumer-api.ifood.com.br/merchants/${MERCHANT_ID}/items/${ITEM_ID}`,
  `https://consumer-api.ifood.com.br/v1/merchants/${MERCHANT_ID}/catalog`,
  `https://consumer-api.ifood.com.br/merchants/${MERCHANT_ID}/catalog?${COORDS}`,
]

const PRICE_MARKERS = /price|unitPrice|originalPrice|menuPrice|"value":\s*\d/i

function summarize(text: string): { hasPrice: boolean; sample: string } {
  const hasPrice = PRICE_MARKERS.test(text)
  const sample = text.slice(0, 200).replace(/\s+/g, ' ')
  return { hasPrice, sample }
}

async function main(): Promise<void> {
  const ctx = await openStealthContext({ userDataDir: PROFILE_DIR, headless: false })
  const page = await ctx.newPage()
  // Visita a página real do item para estabelecer cookies/contexto.
  console.log(`▶ Aquecendo contexto em: ${REFERER}`)
  try {
    await page.goto(REFERER, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await solveTurnstileIfPresent(page, { verbose: true })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined)
  } catch (err) {
    console.warn('aquecimento falhou:', (err as Error).message)
  }
  console.log(`\n▶ Sondando ${CANDIDATES.length} endpoints candidatos...\n`)

  const results: { url: string; status: number; bytes: number; hasPrice: boolean; sample: string }[] = []
  for (const url of CANDIDATES) {
    try {
      const resp = await page.request.get(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: REFERER,
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        timeout: 10_000,
      })
      const text = await resp.text()
      const { hasPrice, sample } = summarize(text)
      results.push({ url, status: resp.status(), bytes: text.length, hasPrice, sample })
      const flag = hasPrice ? ' 💰' : ''
      console.log(`  [${resp.status()}] ${String(text.length).padStart(7)}b${flag}  ${url.replace('https://www.ifood.com.br', '').replace('https://consumer-api.ifood.com.br', '[consumer]')}`)
      if (hasPrice) console.log(`    ↳ sample: ${sample}`)
      if (resp.status() >= 200 && resp.status() < 300) {
        await mkdir(`${ROOT}fixtures/probes`, { recursive: true })
        const slug = url
          .replace(/^https?:\/\//, '')
          .replace(/[^a-z0-9]+/gi, '_')
          .slice(0, 120)
        await writeFile(`${ROOT}fixtures/probes/${slug}.json`, text, 'utf-8')
      }
    } catch (err) {
      console.log(`  [ERR]            ${url}  → ${(err as Error).message.slice(0, 60)}`)
      results.push({ url, status: -1, bytes: 0, hasPrice: false, sample: (err as Error).message })
    }
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 400))
  }

  console.log('\n=== ENDPOINTS COM SINAL DE PREÇO ===')
  const hits = results.filter((r) => r.hasPrice && r.status >= 200 && r.status < 300)
  if (hits.length === 0) {
    console.log('  (nenhum)')
  } else {
    for (const h of hits) {
      console.log(`  ${h.status}  ${h.bytes}b  ${h.url}`)
      console.log(`    ${h.sample}`)
    }
  }
  console.log('\n=== ENDPOINTS 2xx (mesmo sem price marker) ===')
  for (const r of results.filter((x) => x.status >= 200 && x.status < 300)) {
    console.log(`  ${r.status}  ${String(r.bytes).padStart(7)}b  ${r.url}`)
  }

  await ctx.close()
}

try {
  await main()
} catch (err) {
  console.error('FATAL:', err)
  process.exit(1)
}
