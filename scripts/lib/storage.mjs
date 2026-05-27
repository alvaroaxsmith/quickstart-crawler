/**
 * storage.mjs — persistência incremental e merge final.
 *
 * Centraliza: carregamento do cache de resultados, gravação incremental,
 * e o merge final com o arquivo original de produtos.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { parseProductUrl } from './urls.mjs'
import { formatBRL } from './price.mjs'

/**
 * Carrega o cache de resultados incremental.
 * Retorna objeto vazio se o arquivo não existir.
 *
 * @param {string} file
 * @returns {Record<string, {merchantId:string, itemId:string, normalPrice:number, discountPrice:number|null}>}
 */
export function loadResults(file) {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

/**
 * Grava o cache de resultados (sobrescreve).
 *
 * @param {string} file
 * @param {object} results
 */
export function saveResults(file, results) {
    writeFileSync(file, JSON.stringify(results, null, 2))
}

/**
 * Faz merge dos resultados enriquecidos com o arquivo original de produtos
 * e grava o arquivo de saída.
 *
 * Normaliza chaves legadas com '|' para ':' automaticamente.
 *
 * @param {string} originalFile   Caminho do products_output.json original
 * @param {object} results        Cache de resultados (chave = "merchantId:itemId")
 * @param {string} outputFile     Caminho de saída para o JSON enriquecido
 * @returns {{ mergedCount: number, total: number }}
 */
export function mergeAndSave(originalFile, results, outputFile) {
    const original = JSON.parse(readFileSync(originalFile, 'utf8'))

    // Normaliza chaves legadas: '|' → ':'
    const normalized = {}
    for (const [k, v] of Object.entries(results)) {
        normalized[k.replace('|', ':')] = v
    }

    let mergedCount = 0

    const enriched = original.map(p => {
        const ids = parseProductUrl(p.product_url)
        if (!ids) return p

        const key = `${ids.merchantId}:${ids.itemId}`
        const r = normalized[key]

        if (!r) {
            return {
                ...p,
                normal_price: null,
                discount_price: null,
                status: 'error',
                error_message: 'Preço não encontrado',
            }
        }

        mergedCount++
        const discountVal = (r.discountPrice != null && r.discountPrice !== r.normalPrice) ?
            r.discountPrice :
            null

        return {
            ...p,
            normal_price: formatBRL(r.normalPrice),
            discount_price: formatBRL(discountVal),
            status: 'success',
            error_message: null,
        }
    })

    writeFileSync(outputFile, JSON.stringify(enriched, null, 2))
    return { mergedCount, total: original.length }
}