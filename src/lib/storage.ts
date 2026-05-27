/**
 * storage — persistência incremental e merge final.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseProductUrl } from './urls.js'
import { formatBRL } from './price.js'

export interface CacheEntry {
  merchantId: string
  itemId: string
  normalPrice: number
  discountPrice: number | null
  title: string | null
  logoUrl: string | null
}

export type ResultsCache = Record<string, CacheEntry>

interface OriginalProduct {
  product_url?: string
  title?: string
  [key: string]: unknown
}

export function loadResults(file: string): ResultsCache {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ResultsCache) : {}
}

export function saveResults(file: string, results: ResultsCache): void {
  writeFileSync(file, JSON.stringify(results, null, 2))
}

export function mergeAndSave(
  originalFile: string,
  results: ResultsCache,
  outputFile: string,
): { mergedCount: number; total: number } {
  const original = JSON.parse(readFileSync(originalFile, 'utf8')) as OriginalProduct[]

  // Normaliza chaves legadas: '|' → ':'
  const normalized: ResultsCache = {}
  for (const [k, v] of Object.entries(results)) {
    normalized[k.replace('|', ':')] = v
  }

  let mergedCount = 0

  const enriched = original.map((p) => {
    const ids = parseProductUrl(p.product_url)
    if (!ids) return p

    const key = `${ids.merchantId}:${ids.itemId}`
    const r = normalized[key]

    if (!r) {
      const isDeactivated =
        typeof p.product_url === 'string' && p.product_url.includes('desativada')
      return {
        ...p,
        normal_price: null,
        discount_price: null,
        image_url: null,
        status: 'error',
        error_message: isDeactivated
          ? 'DEACTIVATED: loja desativada no iFood (URL inativa)'
          : 'UNAVAILABLE: produto indisponível (fora da área de entrega ou bloqueio temporário)',
      }
    }

    mergedCount++
    const discountVal =
      r.discountPrice != null && r.discountPrice !== r.normalPrice ? r.discountPrice : null

    return {
      ...p,
      title: r.title ?? p.title ?? null,
      normal_price: formatBRL(r.normalPrice),
      discount_price: formatBRL(discountVal),
      image_url: r.logoUrl ?? null,
      status: 'success',
      error_message: null,
    }
  })

  writeFileSync(outputFile, JSON.stringify(enriched, null, 2))
  return { mergedCount, total: original.length }
}
