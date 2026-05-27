/**
 * px-batch-crawl.mjs
 *
 * Batch crawler com PX "Pressione e segure" automático.
 *
 * Estratégia:
 *   1. Conecta ao Chrome CDP (porta 9222)
 *   2. Warm-up na home do iFood
 *   3. Para cada item: navega para a página do item, espera XHR do items API.
 *      Se a primeira tentativa retorna 403, chama solvePxChallengeIfPresent
 *      e faz fetch() direto após o solve.
 *   4. Persiste resultados incrementalmente em /tmp/px-batch-results.json
 *   5. Ao final, faz merge com products_output.json e salva enriched.
 *
 * Uso:
 *   node scripts/px-batch-crawl.mjs [--from 0] [--to 999] [--group pao|carrefour|farmacia|all]
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { solvePxChallengeIfPresent } from '../dist/adapters/fetcher/turnstile.service.js'
import { buildItemApiUrl } from './lib/urls.mjs'
import { defaultUrlFiles, loadItems } from './lib/input.mjs'
import { loadResults, saveResults, mergeAndSave } from './lib/storage.mjs'
import { parseItemResponse } from './lib/parser.mjs'

const __dirname = dirname(fileURLToPath(
    import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Config ───────────────────────────────────────────────────────────────────
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const RESULTS_FILE = process.env.RESULTS_FILE ?? '/tmp/px-batch-results.json'
const ORIGINAL = process.env.ORIGINAL ?? resolve(PROJECT_ROOT, 'data/products_output.json')
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? resolve(PROJECT_ROOT, 'data/products_output_enriched.json')

mkdirSync(dirname(OUTPUT_FILE), { recursive: true })

// Delay entre itens (ms) — reduz risco de PX re-travar
const DELAY_BETWEEN_ITEMS_MS = 1_800
    // Timeout para captura do XHR do items API
const XHR_CAPTURE_MS = 15_000

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const fromIdx = parseInt(args[args.indexOf('--from') + 1] ?? '0') || 0
const toIdx = parseInt(args[args.indexOf('--to') + 1] ?? '999') || 999
const group = args[args.indexOf('--group') + 1] ?? 'all'

const URL_FILES = defaultUrlFiles(PROJECT_ROOT)
const urlFile = URL_FILES[group] ?? URL_FILES.all
const { items, total: totalItems } = loadItems(urlFile, fromIdx, toIdx)
console.log(`[batch] group=${group} items=${items.length} (${fromIdx}–${Math.min(toIdx, totalItems - 1)})`)

// ── Carrega resultados anteriores (resume) ──────────────────────────────────
const results = loadResults(RESULTS_FILE)
const alreadyDone = Object.keys(results).length
console.log(`[batch] ${alreadyDone} itens já enriquecidos (resume)`)

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

// ── Main ──────────────────────────────────────────────────────────────────────
const browser = await chromium.connectOverCDP(CDP_URL)
const ctx = browser.contexts()[0] ?? await browser.newContext()
const page = await ctx.newPage()

// Warm-up
console.log('[batch] Warm-up iFood home...')
await page.goto('https://www.ifood.com.br/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
await sleep(2_000)

const warmCookies = await ctx.cookies('https://www.ifood.com.br')
const hasCf = warmCookies.some(c => c.name === 'cf_clearance')
console.log(`[batch] warm-up OK | cf_clearance: ${hasCf ? '✅' : '❌'}`)

// ── Crawl loop ────────────────────────────────────────────────────────────────
let successCount = 0
let failCount = 0
let skipCount = 0

for (const [i, item] of items.entries()) {
    const key = `${item.merchantId}:${item.itemId}`

    // Skip se já temos resultado
    if (results[key]) {
        skipCount++
        if (i % 20 === 0) console.log(`[${i+1}/${items.length}] skip (já enriquecido): ${item.name?.slice(0,30)}`)
        continue
    }

    const apiUrl = buildItemApiUrl(item.merchantId, item.itemId)
    const pageUrl = item.productUrl

    let capturedJson = null
    let capturedStatus = null

    // Listener para capturar XHR automaticamente
    // Nota: para de atualizar assim que temos dados reais (evita sobrescrever 200 com 403 tardio)
    const onResponse = async(res) => {
        const u = res.url()
        if (u.includes('/items/') && u.includes(item.itemId)) {
            if (capturedJson ?.data ?.menu ?.length > 0) return // já temos dados reais
            capturedStatus = res.status()
            if (capturedStatus === 200) {
                try {
                    const j = await res.json()
                    if (j ?.data ?.menu ?.length > 0) capturedJson = j
                } catch { /* ignore */ }
            }
        }
    }
    page.on('response', onResponse)

    try {
        // Navega para a página do item
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    } catch (navErr) {
        console.log(`[${i+1}/${items.length}] ERRO navegação: ${String(navErr).slice(0,80)}`)
        page.off('response', onResponse)
        failCount++
        await sleep(DELAY_BETWEEN_ITEMS_MS)
        continue
    }

    try {

        // Aguarda XHR ser capturado (até XHR_CAPTURE_MS)
        const xhrDeadline = Date.now() + XHR_CAPTURE_MS
        while (capturedStatus === null && Date.now() < xhrDeadline) {
            await sleep(300)
        }

        // Se XHR foi 403, tenta solve PX
        if (capturedStatus === 403 || capturedStatus === null) {
            const outcome = await solvePxChallengeIfPresent(page, {
                detectTimeoutMs: 8_000,
                holdMs: 12_000,
                resolveTimeoutMs: 20_000,
                log: msg => process.stdout.write(`  [PX] ${msg}\n`),
            })

            if (outcome === 'solved') {
                // CRÍTICO: buscar IMEDIATAMENTE após o solve, antes do reload da página.
                // O _px3 validado só é válido por um breve instante — após o reload, um novo
                // _px3 não-validado é emitido e o fetch retorna 403 novamente.
                await sleep(400)
                const fetchResult = await page.evaluate(async(url) => {
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

                // Se o contexto foi destruído (reload durante o fetch) ou ainda sem dados,
                // espera o reload estabilizar e tenta capturar pelo onResponse
                if (fetchResult.status === -1 || !capturedJson) {
                    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
                    await sleep(500)
                        // onResponse pode ter capturado durante o reload
                }

                // Último fallback: re-navega para capturar um XHR fresco
                if (!capturedJson) {
                    page.off('response', onResponse)
                    capturedStatus = null
                    capturedJson = null
                    page.on('response', onResponse)
                    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
                    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
                    await sleep(800)
                }
            }
        }
    } catch (itemErr) {
        console.log(`  [ERRO item] ${String(itemErr).slice(0, 120)}`)
    } finally {
        page.off('response', onResponse)
    }

    // Extrai preços do JSON capturado
    const priceData = parseItemResponse(capturedJson, item.itemId)
    const normalPrice = priceData ?.normalPrice ?? null
    const discountPrice = priceData ?.discountPrice ?? null

    const label = (item.name ?? item.itemId ?? '?').toString().slice(0, 35).padEnd(35)
    if (normalPrice !== null) {
        results[key] = { merchantId: item.merchantId, itemId: item.itemId, normalPrice, discountPrice }
        successCount++
        console.log(`[${i+1}/${items.length}] ✅ ${label} | R$ ${Number(normalPrice).toFixed(2)}`)
        saveResults(RESULTS_FILE, results)
    } else {
        failCount++
        const debugBody = capturedJson ? JSON.stringify(capturedJson).slice(0, 200) : '(null)'
        console.log(`[${i+1}/${items.length}] ❌ ${label} | status=${capturedStatus} | json=${debugBody}`)
    }

    await sleep(DELAY_BETWEEN_ITEMS_MS)

    // Progress a cada 50
    if ((i + 1) % 50 === 0) {
        console.log(`\n--- Progress: ${i+1}/${items.length} | ✅ ${successCount} | ❌ ${failCount} | skip ${skipCount} ---\n`)
    }
}

await page.close()
console.log(`\n[batch] FIM: ✅ ${successCount} | ❌ ${failCount} | skip ${skipCount}`)
console.log(`[batch] Total enriquecidos: ${Object.keys(results).length}`)

// ── Merge final ───────────────────────────────────────────────────────────────
console.log('\n[batch] Fazendo merge com products_output.json...')
const { mergedCount, total: totalOriginal } = mergeAndSave(ORIGINAL, results, OUTPUT_FILE)
console.log(`[batch] Merge completo: ${mergedCount}/${totalOriginal} produtos com preço`)
console.log(`[batch] Salvo em: ${OUTPUT_FILE}`)