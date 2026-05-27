/**
 * px-solver.mjs — Batch PX Solver
 *
 * Gerencia o estado compartilhado do solve de desafios PX HUMAN Security.
 * Quando múltiplos workers recebem 403 simultaneamente:
 *   1. O primeiro worker torna-se o solver (aguarda 60ms para coletar outros).
 *   2. Após o solve, TODAS as URLs são buscadas em paralelo NA ABA DO SOLVER,
 *      antes que o reload da SPA invalide o _px3 recém-validado.
 *   3. Cada worker recebe seu fetchResult diretamente — sem re-navegar.
 * Resultado: 1 solve por ciclo, independentemente do número de workers.
 */

import { solvePxChallengeIfPresent } from '../../dist/adapters/fetcher/turnstile.service.js'

/** @type {Array<{ apiUrl: string, resolve: (r: {status: number, text: string}) => void }>} */
const pxQueue = []
let pxSolving = false

/**
 * Enfileira a URL do worker e aguarda o resultado do batch solve.
 * @param {import('playwright').Page} solvingPage
 * @param {string} apiUrl
 * @param {(msg: string) => void} log
 * @returns {Promise<{ status: number, text: string }>}
 */
export function queueBatchFetch(solvingPage, apiUrl, log) {
    return new Promise(resolve => {
        pxQueue.push({ apiUrl, resolve })
        if (pxSolving) {
            log('PX: aguardando batch solve em andamento...')
            return
        }
        pxSolving = true
            // Janela de 60ms para agrupar workers simultâneos antes de iniciar o solve
        setTimeout(() => doBatchSolve(solvingPage, log), 60)
    })
}

async function doBatchSolve(page, log) {
    try {
        const outcome = await solvePxChallengeIfPresent(page, {
            detectTimeoutMs: 8 _000,
            holdMs: 12 _000,
            resolveTimeoutMs: 22 _000,
            log,
        })

        const batch = pxQueue.splice(0)

        if (outcome === 'solved' && batch.length > 0) {
            const count = batch.length
            log(`PX: batch fetch de ${count} URL${count > 1 ? 's' : ''} simultâneas`)

            // Dispara TODOS os fetches da aba do solver ANTES do reload invalidar _px3
            const urls = batch.map(b => b.apiUrl)
            const fetched = await page
                .evaluate(async urls => {
                    return Promise.all(urls.map(async url => {
                        try {
                            const r = await fetch(url, { headers: { Accept: 'application/json' } })
                            const text = await r.text()
                            return { status: r.status, text }
                        } catch (e) {
                            return { status: -1, text: String(e) }
                        }
                    }))
                }, urls)
                .catch(() => urls.map(() => ({ status: -1, text: 'context destroyed' })))

            batch.forEach((item, i) => item.resolve(fetched[i]))
        } else {
            // Sem challenge ativo ou solve falhou — workers farão fallback por conta própria
            batch.forEach(item => item.resolve({ status: -1, text: 'no-challenge' }))
        }
    } catch (err) {
        pxQueue
            .splice(0)
            .forEach(item => item.resolve({ status: -1, text: `solve-error:${String(err).slice(0, 50)}` }))
    } finally {
        pxSolving = false
    }
}