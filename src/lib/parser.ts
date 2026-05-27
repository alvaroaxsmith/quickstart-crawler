/**
 * parser — parsing de respostas da items API do iFood.
 */

import { extractPrice } from './price.js'

export interface ParsedItem {
  normalPrice: number
  discountPrice: number | null
  title: string | null
  logoUrl: string | null
}

/**
 * Interpreta a resposta JSON da items API e retorna os dados estruturados.
 * Retorna null se a resposta for inválida ou não contiver preço.
 */
export function parseItemResponse(capturedJson: unknown, itemId: string): ParsedItem | null {
  if (!capturedJson) return null
  const { normalPrice, discountPrice, title, logoUrl } = extractPrice(capturedJson, itemId)
  if (normalPrice === null) return null
  return { normalPrice, discountPrice, title, logoUrl }
}
