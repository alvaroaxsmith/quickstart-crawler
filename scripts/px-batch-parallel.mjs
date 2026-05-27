/**
 * px-batch-parallel.mjs — enriquecimento PARALELO com retry automático
 *
 * Estratégia:
 *   • N workers (abas do Chrome) processam itens em paralelo da mesma fila.
 *   • Mutex de PX: apenas UM worker resolve o desafio "Pressione e segure"
 *     por vez — quando termina, todos os outros que aguardavam recebem o
 *     cookie atualizado e fazem fetch direto.
 *   • Após a 1ª rodada, itens que falharam são re-enfileirados automaticamente.
 *   • Resume: itens já gravados em /tmp/px-batch-results.json são pulados.
 *
 * Uso:
 *   node scripts/px-batch-parallel.mjs [--group pao|carrefour|farmacia|all]
 *                                       [--concurrency 3]
 *                                       [--retry-only]
 */

import { chromium } from 'playwright'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { solvePxChallengeIfPresent } from '../dist/adapters/fetcher/turnstile.service.js'

const __dirname = dirname(fileURLToPath(
    import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Config ───────────────────────────────────────────────────────────────────
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const RESULTS_FILE = process.env.RESULTS_FILE ?? '/tmp/px-batch-results.json'
const FAILED_FILE = process.env.FAILED_FILE ?? '/tmp/px-batch-failed.json'
const ORIGINAL = process.env.ORIGINAL ?? resolve(PROJECT_ROOT, 'data/products_output.json')
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? resolve(PROJECT_ROOT, 'data/products_output_enriched.json')

// garante que o diretório de saída existe
mkdirSync(dirname(OUTPUT_FILE), { recursive: true })

const DELAY_BETWEEN_ITEMS_MS = 150 // delay por worker — event-driven elimina espera ociosa

const XHR_CAPTURE_MS = 6_000 // máximo de espera pela resposta da API

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const group = args[args.indexOf('--group') + 1] ?? 'all'
const CONCURRENCY = parseInt(args[args.indexOf('--concurrency') + 1] ?? '3') || 3
const RETRY_ONLY = args.includes('--retry-only')

const URL_FILES = {
    pao: process.env.URL_FILE_PAO ?? resolve(PROJECT_ROOT, 'data/groups/urls-pao.json'),
    carrefour: process.env.URL_FILE_CARREFOUR ?? resolve(PROJECT_ROOT, 'data/groups/urls-carrefour.json'),
    farmacia: process.env.URL_FILE_FARMACIA ?? resolve(PROJECT_ROOT, 'data/groups/urls-farmacia.json'),
    all: process.env.URL_FILE_ALL ?? resolve(PROJECT_ROOT, 'data/groups/urls-all.json'),
}

// ── Carga de dados ───────────────────────────────────────────────────────────
const results = existsSync(RESULTS_FILE) ?
    JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : {}

function persistResults() {
    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
}

function parseProductUrl(url) {
    const m = url ?.match(/\/([0-9a-f-]{36})\?.tem=([0-9a-f-]{36})/)
    return m ? { merchantId: m[1], itemId: m[2] } : null
}

function extractPrice(capturedJson, itemId) {
    if (!capturedJson || capturedJson.code !== '00') return { normalPrice: null, discountPrice: null, title: null }
    const menu = capturedJson.data ?.menu ?? []
    for (const cat of menu) {
        for (const it of(cat.itens ?? [])) {
            if (it.id === itemId || it.id === itemId ?.replace(/-/g, '')) {
                const normal = it.originalPrice ?? it.unitPrice ?? null
                const discount = (it.originalPrice != null && it.unitPrice != null && it.originalPrice !== it.unitPrice) ? it.unitPrice : null
                return { normalPrice: normal, discountPrice: discount, title: it.description ?? null }
            }
        }
    }
    // Fallback: primeiro item da resposta
    const first = menu[0] ?.itens ?.[0]
    if (!first) return { normalPrice: null, discountPrice: null, title: null }
    const normal = first.originalPrice ?? first.unitPrice ?? null
    const discount = (first.originalPrice != null && first.unitPrice != null && first.originalPrice !== first.unitPrice) ? first.unitPrice : null
    return { normalPrice: normal, discountPrice: discount, title: first.description ?? null }
}

function formatBRL(val) {
    if (val == null) return null
    return 'R$ ' + Number(val).toFixed(2).replace('.', ',')
}

// ── PX Mutex ─────────────────────────────────────────────────────────────────
// Apenas UM worker resolve o challenge por vez.
// Os outros fazem await neste mesmo Promise e recebem 'waited' como resultado.
let _pxSolvePromise = null

async function ensurePxSolved(page, log) {
    if (_pxSolvePromise) {
        log('PX: outro worker resolvendo — aguardando cookie...')
        await _pxSolvePromise
        log('PX: cookie atualizado pelo outro worker, tentando fetch direto')
        return 'waited'
    }

    let _resolve
    _pxSolvePromise = new Promise(r => { _resolve = r })

    try {
        return await solvePxChallengeIfPresent(page, {
            detectTimeoutMs: 8_000,
            holdMs: 12_000,
            resolveTimeoutMs: 22_000,
            log,
        })
    } finally {
        _pxSolvePromise = null
        _resolve()
    }
}

// ── Worker ────────────────────────────────────────────────────────────────────
async function processItem(page, item, workerIdx) {
    const ids = parseProductUrl(item.productUrl ?? item.product_url)
    if (!ids) return { success: false, reason: 'invalid-url' }

    const { merchantId, itemId } = ids
    const pageUrl = item.productUrl ?? item.product_url
    const apiUrl = `https://www.ifood.com.br/site-api/v1/merchants/restaurant/${merchantId}/items/${itemId}`
    const log = msg => process.stdout.write(`  [W${workerIdx}][PX] ${msg}\n`)

    let capturedStatus = null
    let capturedJson = null
    let _signalCapture
    const capturePromise = new Promise(r => { _signalCapture = r })

    const onResponse = async res => {
        const url = res.url()
        if (url.includes('/restaurant/') && url.includes('/items/')) {
            if (capturedJson ?.data ?.menu ?.length > 0) return // já temos dados reais
            capturedStatus = res.status()
            if (capturedStatus === 200) {
                try {
                    const j = await res.json().catch(() => null)
                    if (j ?.data ?.menu ?.length > 0) capturedJson = j
                } catch { /* ignore */ }
            }
            _signalCapture() // desbloqueia o race imediatamente (200 com dados ou 403)
        }
    }

    page.on('response', onResponse)

    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
            // Captura event-driven: resolve assim que a API responde, sem polling nem networkidle
        await Promise.race([
            capturePromise,
            new Promise(r => setTimeout(r, XHR_CAPTURE_MS)),
        ])

        // Se 403 (ou sem resposta), tenta resolver PX
        if (capturedStatus === 403 || capturedStatus === null) {
            const outcome = await ensurePxSolved(page, log)

            if (outcome === 'solved' || outcome === 'waited') {
                // CRÍTICO: buscar IMEDIATAMENTE após o solve, antes do reload da página.
                // O _px3 validado só é válido por um breve instante — após o reload, um novo
                // _px3 não-validado é emitido e o fetch retorna 403 novamente.
                await page.waitForTimeout(400)
                const fetchResult = await page.evaluate(async url => {
                    try {
                        const r = await fetch(url, { headers: { Accept: 'application/json' } })
                        const text = await r.text()
                        return { status: r.status, text }
                    } catch (e) { return { status: -1, text: String(e) } }
                }, apiUrl).catch(() => ({ status: -1, text: 'context destroyed' }))

                if (fetchResult.status === 200) {
                    try {
                        const parsed = JSON.parse(fetchResult.text)
                        if (parsed ?.data ?.menu ?.length > 0) {
                            capturedJson = parsed
                            capturedStatus = 200
                        }
                    } catch { /* ignore */ }
                }

                // Se contexto destruído (reload durante fetch) ou ainda sem dados,
                // espera o reload estabilizar e tenta capturar pelo onResponse
                if (fetchResult.status === -1 || !capturedJson) {
                    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
                    await page.waitForTimeout(500)
                }
            }
        }
    } catch (err) {
        return { success: false, reason: `error: ${String(err).slice(0, 80)}` }
    } finally {
        page.off('response', onResponse)
    }

    const { normalPrice, discountPrice, title } = extractPrice(capturedJson, itemId)
    if (normalPrice !== null) {
        return { success: true, normalPrice, discountPrice, title, merchantId, itemId }
    }
    return {
        success: false,
        reason: capturedJson ? 'empty-data' : `status=${capturedStatus}`,
    }
}

// ── Runner (processa fila com N workers) ─────────────────────────────────────
async function runQueue(pages, queue, label) {
    const failed = []
    let done = 0,
        successCount = 0,
        failCount = 0
    const total = queue.length

    async function runWorker(page, workerIdx) {
        try {
            while (queue.length > 0) {
                const item = queue.shift()
                if (!item) break

                const ids = parseProductUrl(item.productUrl ?? item.product_url)
                if (!ids) {
                    failCount++;
                    done++;
                    continue
                }

                const key = `${ids.merchantId}:${ids.itemId}`
                done++

                const result = await processItem(page, item, workerIdx)

                if (result.success) {
                    results[key] = {
                        merchantId: result.merchantId,
                        itemId: result.itemId,
                        normalPrice: result.normalPrice,
                        discountPrice: result.discountPrice,
                        title: result.title ?? '',
                    }
                    successCount++
                    const lbl = (item.name ?? ids.itemId ?? '').slice(0, 32).padEnd(32)
                    console.log(`[W${workerIdx}][${label} ${done}/${total}] ✅ ${lbl} | R$ ${Number(result.normalPrice).toFixed(2)}`)
                    persistResults()
                } else {
                    failCount++
                    const lbl = (item.name ?? ids.itemId ?? '').slice(0, 32).padEnd(32)
                    console.log(`[W${workerIdx}][${label} ${done}/${total}] ❌ ${lbl} | ${result.reason}`)
                    failed.push(item)
                }

                await page.waitForTimeout(DELAY_BETWEEN_ITEMS_MS + Math.random() * 150).catch(() => {})
            }
        } catch (workerErr) {
            const msg = String(workerErr)
            if (msg.includes('closed') || msg.includes('destroyed')) {
                console.log(`[W${workerIdx}] ⚠️  aba fechada inesperadamente — worker encerrado`)
            } else {
                console.log(`[W${workerIdx}] ❌ erro fatal no worker: ${msg.slice(0, 120)}`)
            }
        }
    }

    await Promise.all(pages.map((page, i) => runWorker(page, i + 1)))
    console.log(`\n[batch] ${label} concluída: ✅ ${successCount} | ❌ ${failCount} | total ${done}/${total}`)
    return failed
}

// ── Warm-up ──────────────────────────────────────────────────────────────────
async function warmUp(ctx) {
    const page = await ctx.newPage()
    process.stdout.write('[batch] Warm-up iFood home...\n')
    await page.goto('https://www.ifood.com.br/', { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    const cookies = await ctx.cookies('https://www.ifood.com.br')
    const cf = cookies.find(c => c.name === 'cf_clearance')
    const px3 = cookies.find(c => c.name === '_px3')
    console.log(`[batch] warm-up OK | cf_clearance: ${cf ? '✅' : '❌'} | _px3: ${px3 ? '✅' : '❌'}`)
    await page.close()
}

// ── Main ─────────────────────────────────────────────────────────────────────
const urlFile = URL_FILES[group]
if (!urlFile || !existsSync(urlFile)) {
    console.error(`Arquivo não encontrado: ${urlFile}. Execute scripts/px-batch-crawl.mjs uma vez para criar.`)
    process.exit(1)
}

const allItems = JSON.parse(readFileSync(urlFile, 'utf8'))

let pendingItems
if (RETRY_ONLY) {
    pendingItems = existsSync(FAILED_FILE) ? JSON.parse(readFileSync(FAILED_FILE, 'utf8')) : []
    console.log(`[batch] retry-only: ${pendingItems.length} itens para retentar`)
} else {
    const alreadyDone = new Set(Object.keys(results))
    pendingItems = allItems.filter(item => {
        const ids = parseProductUrl(item.productUrl ?? item.product_url)
        if (!ids) return false
        return !alreadyDone.has(`${ids.merchantId}:${ids.itemId}`)
    })
    console.log(`[batch] group=${group} | total=${allItems.length} | já feitos=${allItems.length - pendingItems.length} | pendentes=${pendingItems.length} | workers=${CONCURRENCY}`)
}

if (pendingItems.length === 0) {
    console.log('[batch] Nada a processar.')
    process.exit(0)
}

const browser = await chromium.connectOverCDP(CDP_URL)
const ctx = browser.contexts()[0] ?? await browser.newContext()

await warmUp(ctx)

// Abre N abas (workers)
const pages = await Promise.all(Array.from({ length: CONCURRENCY }, () => ctx.newPage()))
console.log(`[batch] ${CONCURRENCY} workers (abas) prontos\n`)

// ── Rodada 1 ─────────────────────────────────────────────────────────────────
const failed1 = await runQueue(pages, [...pendingItems], 'rodada-1')

// ── Rodada 2 (retry automático) ───────────────────────────────────────────────
let failed2 = []
if (failed1.length > 0) {
    console.log(`\n[batch] Retry automático: ${failed1.length} itens que falharam...`)
        // Pausa para o PX relaxar entre rodadas
    await pages[0].waitForTimeout(6_000)
    failed2 = await runQueue(pages, [...failed1], 'retry')
}

// Salva itens que persistiram na falha para análise posterior
if (failed2.length > 0) {
    writeFileSync(FAILED_FILE, JSON.stringify(failed2, null, 2))
    console.log(`\n[batch] ${failed2.length} itens salvos em ${FAILED_FILE} para análise`)
    console.log(`        Re-execute com --retry-only para tentar novamente`)
} else {
    console.log('\n[batch] Todos os itens processados com sucesso!')
}

// ── Fecha workers ─────────────────────────────────────────────────────────────
await Promise.all(pages.map(p => p.close()))

// ── Merge final ───────────────────────────────────────────────────────────────
console.log(`\n[batch] Total enriquecidos: ${Object.keys(results).length}`)
console.log('[batch] Fazendo merge com products_output.json...')

const original = JSON.parse(readFileSync(ORIGINAL, 'utf8'))
let mergedCount = 0

// Normaliza chaves antigas com '|' para ':'
const normalizedResults = {}
for (const [k, v] of Object.entries(results)) {
    normalizedResults[k.replace('|', ':')] = v
}

const enriched = original.map(p => {
    const ids = parseProductUrl(p.product_url)
    if (!ids) return p
    const key = `${ids.merchantId}:${ids.itemId}`
    const r = normalizedResults[key]
    if (!r) {
        return {...p, normal_price: null, discount_price: null, status: 'error', error_message: 'Preço não encontrado' }
    }
    mergedCount++
    // Para resultados antigos: se discountPrice === normalPrice, não é desconto real
    const discountVal = (r.discountPrice != null && r.discountPrice !== r.normalPrice) ? r.discountPrice : null
    return {
        ...p,
        title: r.title || p.title || '',
        normal_price: formatBRL(r.normalPrice),
        discount_price: formatBRL(discountVal),
        status: 'success',
        error_message: null,
    }
})

writeFileSync(OUTPUT_FILE, JSON.stringify(enriched, null, 2))
console.log(`[batch] Merge: ${mergedCount}/${original.length} produtos com preço → ${OUTPUT_FILE}`)
process.exit(0)