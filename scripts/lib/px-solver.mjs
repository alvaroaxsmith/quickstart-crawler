/**
 * px-solver.mjs — PX Mutex Solver
 *
 * Mutex simples: apenas UM worker resolve o challenge por vez.
 * Os outros aguardam o mesmo Promise e recebem 'waited' — em seguida
 * fazem fetch imediato na SUA própria aba, aproveitando o _px3 fresco
 * que o cookie compartilhado propagou para todos os contextos.
 *
 * CRÍTICO: o _px3 validado pelo widget tem janela curta (< 2s) antes do
 * reload da SPA emitir um novo _px3 não-validado. Por isso o fetch deve
 * acontecer IMEDIATAMENTE após o solve — sem cooldown entre solve e fetch.
 */

import { solvePxChallengeIfPresent } from '../../dist/adapters/fetcher/turnstile.service.js'

let _pxSolvePromise = null

/**
 * Garante que o challenge PX esteja resolvido antes de tentar o fetch.
 * Se outro worker já está resolvendo, aguarda ele terminar ('waited').
 * Retorna o mesmo valor de `solvePxChallengeIfPresent`: 'solved' | 'waited' | 'absent' | 'failed'.
 *
 * @param {import('playwright').Page} page
 * @param {(msg: string) => void} log
 * @returns {Promise<'solved'|'waited'|'absent'|'failed'>}
 */
export async function ensurePxSolved(page, log) {
    if (_pxSolvePromise) {
        log('PX: outro worker resolvendo — aguardando...')
        await _pxSolvePromise
        log('PX: solve concluído, tentando fetch com _px3 atualizado')
        return 'waited'
    }

    let _resolve
    _pxSolvePromise = new Promise(r => { _resolve = r })
    try {
        return await solvePxChallengeIfPresent(page, {
            detectTimeoutMs: 8_000,
            holdMs: 15_000,
            resolveTimeoutMs: 22_000,
            log,
        })
    } finally {
        _pxSolvePromise = null
        _resolve()
    }
}