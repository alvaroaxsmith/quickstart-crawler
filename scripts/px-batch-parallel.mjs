/**
 * px-batch-parallel.mjs — enriquecimento PARALELO com retry automático
 *
 * Estratégia:
 *   • N workers (abas do Chrome) processam itens em paralelo da mesma fila.
 *   • Batch PX Solver: o primeiro worker a receber 403 torna-se o solver;
 *     todos os outros workers registram sua URL na fila e aguardam.
 *     Após o solve, TODAS as URLs são buscadas em paralelo NA ABA DO SOLVER,
 *     antes que o reload da SPA invalide o _px3. Resultado: 1 solve por ciclo.
 *   • Fallback: se o batch fetch falhar, o worker re-navega para XHR fresh.
 *   • Após a 1ª rodada, itens que falharam são re-enfileirados automaticamente.
 *   • Resume: itens já gravados em /tmp/px-batch-results.json são pulados.
 *
 * Uso:
 *   node scripts/px-batch-parallel.mjs [--group pao|carrefour|farmacia|all]
 *                                       [--concurrency 5]
 *                                       [--retry-only]
 */

import { chromium } from 'playwright'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { parseProductUrl, buildItemApiUrl } from '../dist/lib/urls.js'
import { parseItemResponse } from '../dist/lib/parser.js'
import { loadResults, saveResults, mergeAndSave } from '../dist/lib/storage.js'
import { defaultUrlFiles, readUrlFile } from '../dist/lib/input.js'
import { hasFlag, getOption } from './lib/cli.mjs'
import { queueBatchFetch } from './lib/px-solver.mjs'
import { captureItemXhr } from './lib/xhr-capture.mjs'

const __dirname = dirname(fileURLToPath(
    import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Config ───────────────────────────────────────────────────────────────────
const CDP_URL = process.env.CDP_URL ? ? 'http://127.0.0.1:9222'
const RESULTS_FILE = process.env.RESULTS_FILE ? ? '/tmp/px-batch-results.json'
const FAILED_FILE = process.env.FAILED_FILE ? ? '/tmp/px-batch-failed.json'
const ORIGINAL = process.env.ORIGINAL ? ? resolve(PROJECT_ROOT, 'data/products_output.json')
const OUTPUT_FILE = process.env.OUTPUT_FILE ? ? resolve(PROJECT_ROOT, 'data/products_output_enriched.json')

// garante que o diretório de saída existe
mkdirSync(dirname(OUTPUT_FILE), { recursive: true })

const DELAY_BETWEEN_ITEMS_MS = 150 // ms de cortesia entre navegações por worker

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const group = getOption(args, '--group', 'all')
const CONCURRENCY = parseInt(getOption(args, '--concurrency', '5')) || 5
const RETRY_ONLY = hasFlag(args, '--retry-only')

const URL_FILES = defaultUrlFiles(PROJECT_ROOT)

// ── Carga de dados ───────────────────────────────────────────────────────────
const results = loadResults(RESULTS_FILE)

function persistResults() { saveResults(RESULTS_FILE, results) }

// ── Worker — processamento de um item ─────────────────────────────────────────
/**
 * @param {import('playwright').Page} page
 * @param {object} item   { productUrl, name }
 * @param {object} ids    { merchantId, itemId }  (pré-validado pelo caller)
 * @param {number} workerIdx
 * @returns {Promise<{ success: true, normalPrice, discountPrice, title, logoUrl, merchantId, itemId }
 *                  | { success: false, reason: string }>}
 */
async function processItem(page, item, ids, workerIdx) {
    const { merchantId, itemId } = ids
    const pageUrl = item.productUrl ? ? item.product_url
    const apiUrl = buildItemApiUrl(merchantId, itemId)
    const log = msg => process.stdout.write(`  [W${workerIdx}][PX] ${msg}\n`)

    try {
        // Tentativa inicial: navega e captura XHR
        let { status, json } = await captureItemXhr(page, pageUrl, 25 _000)

        // Se 403 (ou sem resposta): Batch Solver
        if (status === 403 || status === null) {
            const fetchResult = await queueBatchFetch(page, apiUrl, log)

            if (fetchResult.status === 200) {
                try {
                    const parsed = JSON.parse(fetchResult.text)
                    if (parsed ? .data ? .menu ? .length > 0) json = parsed
                } catch { /* resposta não era JSON válido */ }
            }

            // Fallback: batch fetch não trouxe dados — re-navega para XHR fresh
            if (!json) {
                const fallback = await captureItemXhr(page, pageUrl, 20 _000)
                json = fallback.json
                status = fallback.status
            }
        }

        const priceData = parseItemResponse(json, itemId)
        if (priceData !== null) {
            return {
                success: true,
                normalPrice: priceData.normalPrice,
                discountPrice: priceData.discountPrice,
                title: priceData.title,
                logoUrl: priceData.logoUrl,
                merchantId,
                itemId,
            }
        }

        return { success: false, reason: json ? 'empty-data' : `status=${status}` }
    } catch (err) {
        return { success: false, reason: `error: ${String(err).slice(0, 80)}` }
    }
}

// ── Runner — processa fila com N workers em paralelo ─────────────────────────
/**
 * @param {import('playwright').Page[]} pages
 * @param {object[]} queue
 * @param {string}   label  ex: 'rodada-1', 'retry'
 * @returns {Promise<object[]>}  itens que falharam
 */
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

                const ids = parseProductUrl(item.productUrl ? ? item.product_url)
                if (!ids) {
                    failCount++;
                    done++;
                    continue
                }

                const key = `${ids.merchantId}:${ids.itemId}`
                done++

                const result = await processItem(page, item, ids, workerIdx)

                if (result.success) {
                    results[key] = {
                        merchantId: result.merchantId,
                        itemId: result.itemId,
                        normalPrice: result.normalPrice,
                        discountPrice: result.discountPrice,
                        title: result.title ? ? null,
                        logoUrl: result.logoUrl ? ? null,
                    }
                    successCount++
                    const lbl = (item.name ? ? ids.itemId ? ? '').slice(0, 32).padEnd(32)
                    console.log(`[W${workerIdx}][${label} ${done}/${total}] ✅ ${lbl} | R$ ${Number(result.normalPrice).toFixed(2)}`)
                    persistResults()
                } else {
                    failCount++
                    const lbl = (item.name ? ? ids.itemId ? ? '').slice(0, 32).padEnd(32)
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

// ── Warm-up ───────────────────────────────────────────────────────────────────
async function warmUp(ctx) {
    const page = await ctx.newPage()
    process.stdout.write('[batch] Warm-up iFood home...\n')
    await page.goto('https://www.ifood.com.br/', { waitUntil: 'domcontentloaded', timeout: 25 _000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 12 _000 }).catch(() => {})
    const cookies = await ctx.cookies('https://www.ifood.com.br')
    const cf = cookies.find(c => c.name === 'cf_clearance')
    const px3 = cookies.find(c => c.name === '_px3')
    console.log(`[batch] warm-up OK | cf_clearance: ${cf ? '✅' : '❌'} | _px3: ${px3 ? '✅' : '❌'}`)
    await page.close()
}

// ── Main ──────────────────────────────────────────────────────────────────────
const urlFile = URL_FILES[group]
if (!urlFile || !existsSync(urlFile)) {
    console.error(`Arquivo não encontrado: ${urlFile}. Execute scripts/px-batch-crawl.mjs uma vez para criar.`)
    process.exit(1)
}

const allItems = readUrlFile(urlFile)

let pendingItems
if (RETRY_ONLY) {
    pendingItems = existsSync(FAILED_FILE) ? readUrlFile(FAILED_FILE) : []
    console.log(`[batch] retry-only: ${pendingItems.length} itens para retentar`)
} else {
    const alreadyDone = new Set(Object.keys(results))
    pendingItems = allItems.filter(item => {
        const ids = parseProductUrl(item.productUrl ? ? item.product_url)
        if (!ids) return false
        return !alreadyDone.has(`${ids.merchantId}:${ids.itemId}`)
    })
    console.log(
        `[batch] group=${group} | total=${allItems.length} | já feitos=${allItems.length - pendingItems.length} | pendentes=${pendingItems.length} | workers=${CONCURRENCY}`
    )
}

if (pendingItems.length === 0) {
    console.log('[batch] Nada a processar.')
    process.exit(0)
}

const browser = await chromium.connectOverCDP(CDP_URL)
const ctx = browser.contexts()[0] ? ? await browser.newContext()

await warmUp(ctx)

// Abre N abas (workers)
const pages = await Promise.all(Array.from({ length: CONCURRENCY }, () => ctx.newPage()))
console.log(`[batch] ${CONCURRENCY} workers (abas) prontos\n`)

// ── Rodada 1 ──────────────────────────────────────────────────────────────────
const failed1 = await runQueue(pages, [...pendingItems], 'rodada-1')

// ── Rodada 2 (retry automático) ───────────────────────────────────────────────
let failed2 = []
if (failed1.length > 0) {
    console.log(`\n[batch] Retry automático: ${failed1.length} itens que falharam...`)
    await pages[0].waitForTimeout(6 _000) // pausa para o PX relaxar entre rodadas
    failed2 = await runQueue(pages, [...failed1], 'retry')
}

// ── Resultado final ───────────────────────────────────────────────────────────
if (failed2.length > 0) {
    writeFileSync(FAILED_FILE, JSON.stringify(failed2, null, 2))
    console.log(`\n[batch] ${failed2.length} itens salvos em ${FAILED_FILE} para análise`)
    console.log(`        Re-execute com --retry-only para tentar novamente`)
} else {
    console.log('\n[batch] Todos os itens processados com sucesso!')
}

await Promise.all(pages.map(p => p.close()))

console.log(`\n[batch] Total enriquecidos: ${Object.keys(results).length}`)
console.log('[batch] Fazendo merge com products_output.json...')
const { mergedCount, total: totalOriginal } = mergeAndSave(ORIGINAL, results, OUTPUT_FILE)
console.log(`[batch] Merge: ${mergedCount}/${totalOriginal} produtos com preço → ${OUTPUT_FILE}`)
process.exit(0)