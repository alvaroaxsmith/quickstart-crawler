/**
 * run-all.mjs — pipeline completa, automatizada e resiliente
 *
 * Fluxo:
 *   1. (--reset) limpa cache e dados anteriores
 *   2. auto-build se dist/ inexistente ou desatualizado
 *   3. split products_output.json → data/groups/*.json
 *   4. verifica Chrome CDP
 *   5. pao → carrefour → farmacia (cada grupo com retry automático interno)
 *   6. retry global: reprocessa o que ainda falhou após todos os grupos
 *   7. merge + relatório final
 *
 * Uso:
 *   npm run crawl                     # todos os grupos (resume automático)
 *   npm run crawl -- --reset          # limpa cache e processa do zero
 *   npm run crawl -- --group pao      # só um grupo
 *   npm run crawl -- --concurrency 4  # N workers (default: 3)
 */

import { execSync } from 'child_process'
import {
    existsSync,
    unlinkSync,
    copyFileSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    statSync,
} from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { run } from './lib/process.mjs'
import { createLogger } from './lib/logger.mjs'
import { hasFlag, getOption } from './lib/cli.mjs'
import { splitIntoGroups } from './lib/groups.mjs'

const __dirname = dirname(fileURLToPath(
    import.meta.url))
const ROOT = resolve(__dirname, '..')

const { header, info: log, warn } = createLogger('pipeline')

// ── Args ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const RESET = hasFlag(args, '--reset')
const specificGroup = getOption(args, '--group')
const CONCURRENCY = getOption(args, '--concurrency', '5')
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const RESULTS_FILE = process.env.RESULTS_FILE || '/tmp/px-batch-results.json'
const FAILED_FILE = process.env.FAILED_FILE || '/tmp/px-batch-failed.json'

// ── 1. Reset opcional ─────────────────────────────────────────────────────────
if (RESET) {
    header('Reset: limpando cache e dados anteriores')
    for (const f of[RESULTS_FILE, FAILED_FILE]) {
        if (existsSync(f)) {
            unlinkSync(f);
            log(`${f} removido`)
        }
    }
    const base = resolve(ROOT, 'data/products_output.json')
    const enriched = resolve(ROOT, 'data/products_output_enriched.json')
    if (existsSync(base)) {
        copyFileSync(base, enriched);
        log('products_output_enriched.json resetado')
    }

    // Esvazia arquivos de grupo para forçar re-split
    mkdirSync(resolve(ROOT, 'data/groups'), { recursive: true })
    for (const g of['pao', 'carrefour', 'farmacia', 'all']) {
        writeFileSync(resolve(ROOT, `data/groups/urls-${g}.json`), '[]')
    }
}

// ── 2. Auto-build se dist/ inexistente ou src/ mais novo ──────────────────────
header('Verificando build')
const distDir = resolve(ROOT, 'dist')
const srcDir = resolve(ROOT, 'src')

function newestMtime(dir) {
    try {
        const out = execSync(`find "${dir}" -name "*.ts" -not -path "*/node_modules/*" -printf "%T@\\n" 2>/dev/null | sort -n | tail -1`, { encoding: 'utf8' }).trim()
        return parseFloat(out) || 0
    } catch { return 0 }
}

const distTurnstile = resolve(distDir, 'adapters/fetcher/turnstile.service.js')
const needsBuild = !existsSync(distTurnstile) || newestMtime(srcDir) > statSync(distTurnstile).mtimeMs / 1000

if (needsBuild) {
    log('dist/ desatualizado — compilando TypeScript...')
    const buildCode = await run('npx', ['tsc'], { cwd: ROOT })
    if (buildCode !== 0) {
        console.error('[pipeline] ❌ Build falhou. Corrija os erros e tente novamente.');
        process.exit(1)
    }
    log('✅ Build concluído')
} else {
    log('✅ Build atualizado')
}

// ── 3. Gera arquivos de grupo a partir de products_output.json ────────────────
header('Preparando grupos de URLs')
mkdirSync(resolve(ROOT, 'data/groups'), { recursive: true })

const SOURCE_FILE = resolve(ROOT, 'data/products_output.json')
if (!existsSync(SOURCE_FILE)) {
    console.error('[pipeline] ❌ data/products_output.json não encontrado');
    process.exit(1)
}

const allProducts = JSON.parse(readFileSync(SOURCE_FILE, 'utf8'))
const groupBuckets = splitIntoGroups(allProducts)

const allItems = [...groupBuckets.pao, ...groupBuckets.carrefour, ...groupBuckets.farmacia]
writeFileSync(resolve(ROOT, 'data/groups/urls-all.json'), JSON.stringify(allItems, null, 2))

let totalSplit = 0
for (const [g, items] of Object.entries(groupBuckets)) {
    const path = resolve(ROOT, `data/groups/urls-${g}.json`)
    const existingRaw = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
    const existing = JSON.parse(existingRaw)
        // Só re-grava se vazio ou reset foi feito
    if (existing.length === 0) {
        writeFileSync(path, JSON.stringify(items, null, 2))
        log(`✅ ${g}: ${items.length} itens → data/groups/urls-${g}.json`)
    } else {
        log(`✅ ${g}: ${existing.length} itens (já existia, mantendo)`)
    }
    totalSplit += (existing.length === 0 ? items.length : existing.length)
}
log(`Total: ${totalSplit} itens / ${allProducts.length} produtos (${allProducts.length - totalSplit} ignorados)`)

// ── 4. Verifica Chrome CDP ────────────────────────────────────────────────────
header('Verificando Chrome CDP')
try {
    const resp = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const info = await resp.json()
    log(`✅ Chrome detectado: ${info.Browser}`)
} catch {
    console.error(`[pipeline] ❌ Chrome CDP não acessível em ${CDP_URL}`)
    console.error(`[pipeline]`)
    console.error(`[pipeline]    Abra o Chrome com CDP em outro terminal:`)
    console.error(`[pipeline]    npm run chrome`)
    console.error(`[pipeline]`)
    process.exit(1)
}

// ── 4.5. Renova cf_clearance via FlareSolverr (opt-in) ───────────────────────
if (process.env.FLARESOLVERR_URL) {
    header('Verificando cf_clearance (FlareSolverr)')
    const cfCode = await run('node', [resolve(ROOT, 'scripts/renew-cf-clearance.mjs')])
    if (cfCode !== 0) warn('Renovação de cf_clearance falhou — continuando assim mesmo')
}

// ── 5. Garante diretório de evidências ────────────────────────────────────────
mkdirSync(resolve(ROOT, 'docs/evidence'), { recursive: true })

// ── 6. Executa grupos com retry por grupo ────────────────────────────────────
const GROUPS = specificGroup ? [specificGroup] : ['pao', 'carrefour', 'farmacia']
const groupResults = {}

async function runGroup(g, { retryOnly = false } = {}) {
    const logFile = resolve(ROOT, `docs/evidence/batch-${g}.log`)
    const extraArgs = retryOnly ? ['--retry-only'] : []
    return run('node', [
        resolve(ROOT, 'scripts/px-batch-parallel.mjs'),
        '--group', g,
        '--concurrency', CONCURRENCY,
        ...extraArgs,
    ], { logFile, append: retryOnly })
}

for (const g of GROUPS) {
    header(`Grupo: ${g.toUpperCase()}`)
    let code = await runGroup(g)

    if (code !== 0) {
        warn(`Grupo ${g} encerrou com código ${code} — tentando retry imediato...`)
        code = await runGroup(g, { retryOnly: true })
        if (code !== 0) {
            warn(`Retry do grupo ${g} também falhou (código ${code}) — continuando para o próximo`)
        }
    }
    groupResults[g] = code
}

// ── 7. Retry global: processa o arquivo FAILED_FILE se ainda houver falhas ────
if (!specificGroup && existsSync(FAILED_FILE)) {
    const failed = JSON.parse(readFileSync(FAILED_FILE, 'utf8'))
    if (failed.length > 0) {
        header(`Retry Global: ${failed.length} itens persistentemente falhos`)
        log('Aguardando 10s para o PX relaxar antes do retry global...')
        await new Promise(r => setTimeout(r, 10000))
        const code = await run('node', [
            resolve(ROOT, 'scripts/px-batch-parallel.mjs'),
            '--group', 'all',
            '--concurrency', CONCURRENCY,
            '--retry-only',
        ], { logFile: resolve(ROOT, 'docs/evidence/batch-retry-global.log') })
        if (code !== 0) warn(`Retry global encerrou com código ${code}`)
        else log('✅ Retry global concluído')
    }
}

// ── 8. Relatório final ────────────────────────────────────────────────────────
header('Gerando relatório final')
await run('node', [resolve(ROOT, 'scripts/generate-report.mjs')])

// ── 9. Resumo ─────────────────────────────────────────────────────────────────
header('Pipeline concluída')
const failedCount = existsSync(FAILED_FILE) ?
    JSON.parse(readFileSync(FAILED_FILE, 'utf8')).length :
    0
if (failedCount > 0) warn(`${failedCount} itens ainda com falha → ${FAILED_FILE}`)
log('→ Dados:      data/products_output_enriched.json')
log('→ CSV:        data/products_output_enriched.csv')
log('→ Relatório:  docs/evidence/report.md')
log('→ Métricas:   docs/evidence/summary.json')
log('→ Logs:       docs/evidence/batch-*.log')
log('')
log('Para ver o relatório: npm run report')