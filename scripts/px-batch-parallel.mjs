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
import { solvePxChallengeIfPresent } from '../dist/adapters/fetcher/turnstile.service.js'
import { parseProductUrl, buildItemApiUrl } from '../dist/lib/urls.js'
import { parseItemResponse } from '../dist/lib/parser.js'
import { loadResults, saveResults, mergeAndSave } from '../dist/lib/storage.js'
import { defaultUrlFiles, readUrlFile } from '../dist/lib/input.js'

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

const DELAY_BETWEEN_ITEMS_MS = 150 // delay por worker — event-driven elimina espera ociosa

const XHR_CAPTURE_MS = 6 _000 // máximo de espera pela resposta da API

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const group = args[args.indexOf('--group') + 1] ? ? 'all'
const CONCURRENCY = parseInt(args[args.indexOf('--concurrency') + 1] ? ? '5') || 5
const RETRY_ONLY = args.includes('--retry-only')

const URL_FILES = defaultUrlFiles(PROJECT_ROOT)

// ── Carga de dados ───────────────────────────────────────────────────────────
const results = loadResults(RESULTS_FILE)

function persistResults() { saveResults(RESULTS_FILE, results) }

// ── PX Batch Solver ──────────────────────────────────────────────────────────
// Quando múltiplos workers recebem 403 simultaneamente:
//   1. O primeiro worker torna-se o solver (aguarda 60ms para coletar outros).
//   2. Após o solve, TODAS as URLs são buscadas em paralelo NA ABA DO SOLVER,
//      antes que o reload da SPA invalide o _px3 recém-validado.
//   3. Cada worker recebe seu fetchResult diretamente — sem re-navegar.
// Resultado: 1 solve por ciclo, independentemente do número de workers.

const _pxQueue = [] // { apiUrl: string, resolve: fn }
let _pxSolving = false

async function queueBatchFetch(solvingPage, apiUrl, log) {
    return new Promise(resolve => {
        _pxQueue.push({ apiUrl, resolve })

        if (_pxSolving) {
            log('PX: aguardando batch solve em andamento...')
            return
        }

        _pxSolving = true
            // Aguarda 60ms para coletar workers simultâneos antes de iniciar o solve
        setTimeout(() => _doBatchSolve(solvingPage, log), 60)
    })
}

async function _doBatchSolve(page, log) {
    try {
        const outcome = await solvePxChallengeIfPresent(page, {
            detectTimeoutMs: 8 _000,
            holdMs: 12 _000,
            resolveTimeoutMs: 22 _000,
            log,
        })

        const batch = _pxQueue.splice(0)

        if (outcome === 'solved' && batch.length > 0) {
            const count = batch.length
            log(`PX: batch fetch de ${count} URL${count > 1 ? 's' : ''} simultâneas`)

            // Dispara TODOS os fetches da aba do solver ANTES do reload invalidar _px3
            const urls = batch.map(b => b.apiUrl)
            const fetched = await page.evaluate(async urls => {
                return Promise.all(urls.map(async url => {
                    try {
                        const r = await fetch(url, { headers: { Accept: 'application/json' } })
                        const text = await r.text()
                        return { status: r.status, text }
                    } catch (e) {
                        return { status: -1, text: String(e) }
                    }
                }))
            }, urls).catch(() => urls.map(() => ({ status: -1, text: 'context destroyed' })))

            batch.forEach((item, i) => item.resolve(fetched[i]))
        } else {
            // Sem challenge ativo ou solve falhou — workers farão fallback por conta própria
            batch.forEach(item => item.resolve({ status: -1, text: 'no-challenge' }))
        }
    } catch (err) {
        const batch = _pxQueue.splice(0)
        batch.forEach(item => item.resolve({ status: -1, text: `solve-error:${String(err).slice(0, 50)}` }))
    } finally {
        _pxSolving = false
    }
}

// ── Worker ────────────────────────────────────────────────────────────────────
async function processItem(page, item, workerIdx) {
    const ids = parseProductUrl(item.productUrl ? ? item.product_url)
    if (!ids) return { success: false, reason: 'invalid-url' }

    const { merchantId, itemId } = ids
    const pageUrl = item.productUrl ? ? item.product_url
    const apiUrl = buildItemApiUrl(merchantId, itemId)
    const log = msg => process.stdout.write(`  [W${workerIdx}][PX] ${msg}\n`)

    let capturedStatus = null
    let capturedJson = null
    let _signalCapture
    const capturePromise = new Promise(r => { _signalCapture = r })

    const onResponse = async res => {
        const url = res.url()
        if (url.includes('/restaurant/') && url.includes('/items/')) {
            if (capturedJson ? .data ? .menu ? .length > 0) return // já temos dados reais
            capturedStatus = res.status()
            if (capturedStatus === 200) {
                try {
                    const j = await res.json().catch(() => null)
                    if (j ? .data ? .menu ? .length > 0) capturedJson = j
                } catch { /* ignore */ }
            }
            _signalCapture() // desbloqueia o race imediatamente (200 com dados ou 403)
        }
    }

    page.on('response', onResponse)

    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25 _000 }).catch(() => {})
            // Captura event-driven: resolve assim que a API responde, sem polling nem networkidle
        await Promise.race([
            capturePromise,
            new Promise(r => setTimeout(r, XHR_CAPTURE_MS)),
        ])

        // Se 403 (ou sem resposta): batch solver — o primeiro worker faz o solve
        // e todos os demais recebem seus resultados de uma vez, sem solve redundante.
        if (capturedStatus === 403 || capturedStatus === null) {
            const fetchResult = await queueBatchFetch(page, apiUrl, log)

            if (fetchResult.status === 200) {
                try {
                    const parsed = JSON.parse(fetchResult.text)
                    if (parsed ? .data ? .menu ? .length > 0) {
                        capturedJson = parsed
                        capturedStatus = 200
                    }
                } catch { /* ignore */ }
            }

            // Fallback: batch fetch não trouxe dados (no-challenge, context destroyed, etc.)
            // Re-navega nesta aba para capturar XHR fresh com cookie potencialmente renovado.
            if (!capturedJson) {
                page.off('response', onResponse)
                let _sig2
                const cap2 = new Promise(r => { _sig2 = r })
                const onResp2 = async res => {
                    const u = res.url()
                    if (u.includes('/restaurant/') && u.includes('/items/')) {
                        if (capturedJson ? .data ? .menu ? .length > 0) return
                        capturedStatus = res.status()
                        if (capturedStatus === 200) {
                            const j = await res.json().catch(() => null)
                            if (j ? .data ? .menu ? .length > 0) capturedJson = j
                        }
                        _sig2()
                    }
                }
                page.on('response', onResp2)
                try {
                    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20 _000 }).catch(() => {})
                    await Promise.race([cap2, new Promise(r => setTimeout(r, XHR_CAPTURE_MS))])
                } finally {
                    page.off('response', onResp2)
                }
            }
        }
    } catch (err) {
        return { success: false, reason: `error: ${String(err).slice(0, 80)}` }
    } finally {
        page.off('response', onResponse)
    }

    const priceData = parseItemResponse(capturedJson, itemId)
    if (priceData !== null) {
        return { success: true, normalPrice: priceData.normalPrice, discountPrice: priceData.discountPrice, title: priceData.title, logoUrl: priceData.logoUrl, merchantId, itemId }
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

                const ids = parseProductUrl(item.productUrl ? ? item.product_url)
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

// ── Warm-up ──────────────────────────────────────────────────────────────────
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

// ── Main ─────────────────────────────────────────────────────────────────────
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
    console.log(`[batch] group=${group} | total=${allItems.length} | já feitos=${allItems.length - pendingItems.length} | pendentes=${pendingItems.length} | workers=${CONCURRENCY}`)
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

// ── Rodada 1 ─────────────────────────────────────────────────────────────────
const failed1 = await runQueue(pages, [...pendingItems], 'rodada-1')

// ── Rodada 2 (retry automático) ───────────────────────────────────────────────
let failed2 = []
if (failed1.length > 0) {
    console.log(`\n[batch] Retry automático: ${failed1.length} itens que falharam...`)
        // Pausa para o PX relaxar entre rodadas
    await pages[0].waitForTimeout(6 _000)
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
const { mergedCount, total: totalOriginal } = mergeAndSave(ORIGINAL, results, OUTPUT_FILE)
console.log(`[batch] Merge: ${mergedCount}/${totalOriginal} produtos com preço → ${OUTPUT_FILE}`)
process.exit(0)