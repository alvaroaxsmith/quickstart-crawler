/**
 * renew-cf-clearance.mjs — renova cf_clearance via FlareSolverr
 *
 * Chamado automaticamente pelo pipeline (run-all.mjs) quando FLARESOLVERR_URL
 * está definido. É um no-op se cf_clearance já estiver presente no perfil.
 *
 * Uso standalone:
 *   FLARESOLVERR_URL=http://localhost:8191/v1 node scripts/renew-cf-clearance.mjs
 *
 * Requer:
 *   - Chrome CDP em execução (npm run chrome)
 *   - FlareSolverr em execução (docker compose up -d flaresolverr)
 */

import { chromium } from 'playwright'

const FLARESOLVERR = process.env.FLARESOLVERR_URL ?? 'http://localhost:8191/v1'
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222'
const TARGET = 'https://www.ifood.com.br/'
const log = msg => console.log(`[cf-renew] ${msg}`)

async function main() {
    const browser = await chromium.connectOverCDP(CDP_URL)
    const ctx = browser.contexts()[0] ?? await browser.newContext()

    try {
        // Verifica se cf_clearance já está presente e válido (> 5 min restantes)
        const cookies = await ctx.cookies(TARGET)
        const cf = cookies.find(c => c.name === 'cf_clearance')

        if (cf && cf.expires > Date.now() / 1000 + 300) {
            log(`cf_clearance presente (expira em ${new Date(cf.expires * 1000).toISOString()}) — sem ação`)
            return
        }

        log(`cf_clearance ${cf ? 'expirado' : 'ausente'} — solicitando ao FlareSolverr...`)

        let resp
        try {
            resp = await fetch(FLARESOLVERR, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmd: 'request.get', url: TARGET, maxTimeout: 60000 }),
                signal: AbortSignal.timeout(65000),
            })
        } catch (err) {
            log(`❌ FlareSolverr inacessível: ${String(err).slice(0, 80)}`)
            log('   Certifique-se que o container está em execução: docker compose up -d flaresolverr')
            process.exitCode = 1
            return
        }

        if (!resp.ok) {
            log(`❌ FlareSolverr HTTP ${resp.status}`)
            process.exitCode = 1
            return
        }

        const result = await resp.json()

        if (result.status !== 'ok' || !result.solution ?.cookies ?.length) {
            log(`❌ FlareSolverr falhou: ${result.message ?? 'sem cookies'}`)
            process.exitCode = 1
            return
        }

        const cfCookies = result.solution.cookies.filter(
            c => c.name === 'cf_clearance' || c.name === '__cf_bm' || c.name === '__cflb'
        )

        if (cfCookies.length === 0) {
            log('⚠️  FlareSolverr retornou resposta OK mas sem cookies Cloudflare')
            return
        }

        // Injeta cookies no contexto do Chrome
        await ctx.addCookies(cfCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
            path: c.path ?? '/',
            expires: c.expires === -1 ? undefined : c.expires,
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? true,
            sameSite: 'None',
        })))

        log(`✅ ${cfCookies.length} cookie(s) injetado(s): ${cfCookies.map(c => c.name).join(', ')}`)
    } finally {
        await browser.close()
    }
}

main().catch(err => {
    console.error(`[cf-renew] ❌ Erro não tratado: ${String(err)}`)
    process.exit(1)
})