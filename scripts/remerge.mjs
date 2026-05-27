/**
 * remerge.mjs — regenera products_output_enriched.json a partir do cache.
 *
 * Uso:
 *   node scripts/remerge.mjs
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mergeAndSave, loadResults } from '../dist/lib/storage.js'

const __dirname = dirname(fileURLToPath(
    import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

const RESULTS_FILE = process.env.RESULTS_FILE ?? '/tmp/px-batch-results.json'
const ORIGINAL = process.env.ORIGINAL ?? resolve(PROJECT_ROOT, 'data/products_output.json')
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? resolve(PROJECT_ROOT, 'data/products_output_enriched.json')

const results = loadResults(RESULTS_FILE)
console.log(`[remerge] ${Object.keys(results).length} entradas no cache`)

const { mergedCount, total } = mergeAndSave(ORIGINAL, results, OUTPUT_FILE)
console.log(`[remerge] ✅ ${mergedCount}/${total} produtos com preço → ${OUTPUT_FILE}`)

const withImg = Object.values(results).filter(v => v.logoUrl).length
console.log(`[remerge] image_url disponível em ${withImg} entradas`)