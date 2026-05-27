/**
 * generate-report.mjs — gera métricas detalhadas e dashboard Markdown a partir do output final.
 *
 * Uso:
 *   node scripts/generate-report.mjs
 *
 * Saída:
 *   docs/evidence/summary.json   — métricas estruturadas (machine-readable)
 *   docs/evidence/report.md      — dashboard Markdown (human-readable)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(
    import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const OUTPUT_FILE = process.env.OUTPUT_FILE ?? resolve(PROJECT_ROOT, 'data/products_output_enriched.json')
const REPORT_JSON = resolve(PROJECT_ROOT, 'docs/evidence/summary.json')
const REPORT_MD = resolve(PROJECT_ROOT, 'docs/evidence/report.md')

const LOG_FILES = {
    pao: resolve(PROJECT_ROOT, 'docs/evidence/batch-pao.log'),
    carrefour: resolve(PROJECT_ROOT, 'docs/evidence/batch-carrefour.log'),
    farmacia: resolve(PROJECT_ROOT, 'docs/evidence/batch-farmacia.log'),
}

const GROUP_FILES = {
    pao: resolve(PROJECT_ROOT, 'data/groups/urls-pao.json'),
    carrefour: resolve(PROJECT_ROOT, 'data/groups/urls-carrefour.json'),
    farmacia: resolve(PROJECT_ROOT, 'data/groups/urls-farmacia.json'),
}

if (!existsSync(OUTPUT_FILE)) {
    console.error(`Arquivo de saída não encontrado: ${OUTPUT_FILE}`)
    process.exit(1)
}

mkdirSync(dirname(REPORT_JSON), { recursive: true })

// ── Tempo de execução por log (mtime - birthtime do arquivo) ────────────────
function logDurationMs(file) {
    if (!existsSync(file)) return null
    try {
        const s = statSync(file)
        return s.mtimeMs - s.birthtimeMs
    } catch { return null }
}

function fmtDuration(ms) {
    if (ms == null || ms <= 0) return null
    const totalSec = Math.round(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return m > 0 ? `${m}m ${s}s` : `${s}s`
}

const execTimes = Object.fromEntries(
    Object.entries(LOG_FILES).map(([g, f]) => [g, fmtDuration(logDurationMs(f))])
)
const totalDurationMs = Object.values(LOG_FILES)
    .map(logDurationMs)
    .filter(v => v !== null)
    .reduce((a, b) => a + b, 0)

// ── Carga de dados ──────────────────────────────────────────────────────────
const products = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'))

// Constrói mapa "merchantId:itemId" → grupo a partir dos arquivos de grupo
const groupMap = {}
for (const [group, file] of Object.entries(GROUP_FILES)) {
    if (!existsSync(file)) continue
    const items = JSON.parse(readFileSync(file, 'utf8'))
    for (const item of items) {
        const url = item.productUrl ?? item.product_url ?? ''
        const m = url.match(/\/([0-9a-f-]{36})\?.tem=([0-9a-f-]{36})/)
        if (m) groupMap[`${m[1]}:${m[2]}`] = group
    }
}

// ── Métricas globais ────────────────────────────────────────────────────────
const total = products.length
const success = products.filter(p => p.status === 'success').length
const errors = products.filter(p => p.status === 'error').length
const rate = total > 0 ? (success / total) * 100 : 0

// Converte "R$ XX,XX" ou número → número; devolve null se não puder
function parsePrice(str) {
    if (str === null || str === undefined) return null
    if (typeof str === 'number') return isNaN(str) ? null : str
    const n = parseFloat(String(str).replace('R$', '').replace(',', '.').trim())
    return isNaN(n) ? null : n
}

const prices = products.map(p => parsePrice(p.normal_price)).filter(v => v !== null)
const discountPairs = products
    .map(p => ({ normal: parsePrice(p.normal_price), discount: parsePrice(p.discount_price) }))
    .filter(p => p.discount !== null && p.normal !== null)

const priceMin = prices.length ? Math.min(...prices) : null
const priceMax = prices.length ? Math.max(...prices) : null
const priceAvg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null
const priceMed = prices.length ? [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)] :
    null

const discountCount = discountPairs.length
const discountRates = discountPairs.map(p => ((p.normal - p.discount) / p.normal) * 100)
const discountAvgPct = discountRates.length ?
    discountRates.reduce((a, b) => a + b, 0) / discountRates.length :
    null

// ── Cobertura de campos ─────────────────────────────────────────────────────
const fieldCoverage = {
    title: products.filter(p => p.title).length,
    normal_price: products.filter(p => p.normal_price).length,
    discount_price: products.filter(p => p.discount_price).length,
    image_url: products.filter(p => p.image_url).length,
}

// ── Breakdown de erros ──────────────────────────────────────────────────────
const errorBreakdown = {}
for (const p of products.filter(p => p.status === 'error')) {
    const msg = p.error_message ?? 'unknown'
    errorBreakdown[msg] = (errorBreakdown[msg] ?? 0) + 1
}

// ── Breakdown por grupo ─────────────────────────────────────────────────────
const groupStats = {}
for (const p of products) {
    const url = p.product_url ?? ''
    const m = url.match(/\/([0-9a-f-]{36})\?.tem=([0-9a-f-]{36})/)
    const group = m ? (groupMap[`${m[1]}:${m[2]}`] ?? 'unknown') : 'unknown'
    if (!groupStats[group]) groupStats[group] = { total: 0, success: 0, error: 0 }
    groupStats[group].total++
        if (p.status === 'success') groupStats[group].success++
            else groupStats[group].error++
}

// ── Amostra de descontos ────────────────────────────────────────────────────
const sampleDiscounted = products
    .filter(p => p.discount_price && p.normal_price)
    .slice(0, 5)
    .map(p => ({
        title: (p.title ?? '').slice(0, 45),
        normal_price: p.normal_price,
        discount_price: p.discount_price,
        saving_pct: (() => {
            const n = parsePrice(p.normal_price),
                d = parsePrice(p.discount_price)
            return n && d ? `${(((n - d) / n) * 100).toFixed(0)}%` : null
        })(),
    }))

// ── Helpers de formatação ───────────────────────────────────────────────────
const fmt2 = v => v != null ? parseFloat(v.toFixed(2)) : null
const fmtBRL = v => v != null ? `R$ ${v.toFixed(2).replace('.', ',')}` : null
const pct = (v, t) => t > 0 ? `${((v / t) * 100).toFixed(1)}%` : '–'
const bar = (pctVal, width = 20) => {
    const filled = Math.round(Math.max(0, Math.min(100, pctVal)) / 100 * width)
    return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// ── Objeto de resumo (JSON) ─────────────────────────────────────────────────
const summary = {
    generated_at: new Date().toISOString(),
    source_file: OUTPUT_FILE,
    execution_time: {
        by_group: execTimes,
        total: fmtDuration(totalDurationMs),
    },
    totals: {
        total_urls: total,
        success,
        errors,
        success_rate_pct: fmt2(rate),
        meets_95pct_target: rate >= 95,
    },
    price_stats: {
        min: fmtBRL(priceMin),
        max: fmtBRL(priceMax),
        avg: fmtBRL(priceAvg),
        median: fmtBRL(priceMed),
        with_discount: discountCount,
        with_discount_pct: fmt2(total > 0 ? (discountCount / total) * 100 : 0),
        avg_discount_pct: fmt2(discountAvgPct),
    },
    field_coverage: Object.fromEntries(
        Object.entries(fieldCoverage).map(([k, v]) => [k, { count: v, pct: fmt2((v / total) * 100) }])
    ),
    by_group: Object.fromEntries(
        Object.entries(groupStats).map(([g, s]) => [g, {
            ...s,
            rate_pct: fmt2(s.total > 0 ? (s.success / s.total) * 100 : 0),
        }])
    ),
    error_breakdown: errorBreakdown,
    sample_discounted: sampleDiscounted,
}

writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2))

// ── Dashboard Markdown ──────────────────────────────────────────────────────
const groupLabels = { pao: 'Pão de Açúcar', carrefour: 'Carrefour', farmacia: 'Farmácias', unknown: 'Outros' }

const groupRows = Object.entries(groupStats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, s]) => {
        const r = s.total > 0 ? (s.success / s.total) * 100 : 0
        const t = execTimes[g] ?? '–'
        return `| ${groupLabels[g] ?? g} | ${s.total} | ${s.success} | ${s.error} | ${r.toFixed(1)}% | ${t} |`
    })
    .join('\n')

const errorRows = Object.entries(errorBreakdown)
    .sort(([, a], [, b]) => b - a)
    .map(([msg, count]) => `| ${msg} | ${count} | ${pct(count, errors)} |`)
    .join('\n')

const discountRows = sampleDiscounted
    .map(p => `| ${p.title} | ${p.normal_price} | ${p.discount_price} | ${p.saving_pct} |`)
    .join('\n')

const fieldRows = Object.entries(fieldCoverage)
    .map(([field, count]) => `| \`${field}\` | ${count} / ${total} | ${pct(count, total)} | ${bar((count / total) * 100, 15)} |`)
    .join('\n')

const md = `# Relatório de Execução — Crawler iFood

> **Gerado em:** ${new Date().toISOString()}
> **Fonte:** \`${OUTPUT_FILE}\`

---

## Resumo Executivo

| Métrica | Valor |
|---|---|
| Total de URLs processadas | **${total}** |
| Produtos com preço capturado | **${success}** |
| Falhas | **${errors}** |
| **Taxa de sucesso** | **${rate.toFixed(1)}%** |
| Meta ≥ 95% | ${rate >= 95 ? '✅ ATINGIDA' : '❌ NÃO ATINGIDA'} |
| Tempo total de execução | ${fmtDuration(totalDurationMs) ?? '–'} |

\`\`\`
Sucesso  [${bar(rate, 30)}] ${rate.toFixed(1)}%
Falha    [${bar(100 - rate, 30)}] ${(100 - rate).toFixed(1)}%
\`\`\`

---

## Por Grupo de Loja

| Grupo | Total | Sucesso | Falha | Taxa | Tempo |
|---|---|---|---|---|---|
${groupRows}

---

## Análise de Preços

| Métrica | Valor |
|---|---|
| Preço mínimo | ${fmtBRL(priceMin) ?? '–'} |
| Preço máximo | ${fmtBRL(priceMax) ?? '–'} |
| Preço médio | ${fmtBRL(priceAvg) ?? '–'} |
| Mediana de preço | ${fmtBRL(priceMed) ?? '–'} |
| Produtos com desconto | ${discountCount} (${pct(discountCount, total)}) |
| Desconto médio | ${discountAvgPct != null ? discountAvgPct.toFixed(1) + '%' : '–'} |

### Amostra de Produtos com Desconto

| Produto | Preço Normal | Preço Desconto | Economia |
|---|---|---|---|
${discountRows || '| – | – | – | – |'}

---

## Cobertura de Campos

| Campo | Preenchido | % | Cobertura |
|---|---|---|---|
${fieldRows}

---

## Tipos de Erro

| Mensagem | Ocorrências | % dos Erros |
|---|---|---|
${errorRows || '| – | – | – |'}

---

*Relatório gerado por \`scripts/generate-report.mjs\`*
`

writeFileSync(REPORT_MD, md)

// ── Export CSV ──────────────────────────────────────────────────────────────
const CSV_FILE = process.env.CSV_FILE ?? resolve(PROJECT_ROOT, 'data/products_output_enriched.csv')

function escapeCsv(val) {
    if (val == null) return ''
    const str = String(val)
    return str.includes(',') || str.includes('"') || str.includes('\n') ?
        `"${str.replace(/"/g, '""')}"` :
        str
}

const csvHeader = 'title,normal_price,discount_price,product_url,image_url,status,error_message'
const csvRows = products.map(p => [p.title, p.normal_price, p.discount_price, p.product_url, p.image_url, p.status, p.error_message]
    .map(escapeCsv)
    .join(',')
)
writeFileSync(CSV_FILE, [csvHeader, ...csvRows].join('\n'))

console.log(md)
console.log(`\nArquivos gerados:`)
console.log(`  ${REPORT_JSON}`)
console.log(`  ${REPORT_MD}`)
console.log(`  ${CSV_FILE}`)