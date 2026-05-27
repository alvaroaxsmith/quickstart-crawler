// IfoodApiExtractor — parser primário (ADR-0007).
//
// Consome o payload do endpoint canônico de item
// (`/site-api/v1/merchants/{m}/items/{i}`) e produz um `Product`.
//
// Mapeamento (ADR-0007):
//  - description → title
//  - unitPrice → normal_price (formato "R$ 17,42" em pt-BR)
//  - promotionalPrice → discount_price (só se < unitPrice)
//  - logoUrl → image_url
//  - availability === 'AVAILABLE' && enabled === true → status: success
//  - caso contrário → CrawlError(NOT_FOUND) ou OUT_OF_DELIVERY_AREA
//
// Status HTTP do item-endpoint vira categoria de erro:
//  - undefined / não chamado → INVALID_URL (URL sem UUIDs)
//  - 404 → NOT_FOUND
//  - 403 → BLOCKED
//  - 5xx → HTTP_ERROR
//  - 200 sem `itens[0]` → PARSE_FAILURE

import { CrawlError } from '../../domain/errors.types.js'
import { createErrorProduct, createSuccessProduct, type Product } from '../../domain/product.types.js'
import type { FetchResponse } from '../../application/ports/page-fetcher.port.js'
import type { ProductExtractor } from '../../application/ports/product-extractor.port.js'

interface ItemPayload {
  data?: {
    menu?: Array<{
      itens?: Array<{
        description?: string
        details?: string
        logoUrl?: string
        unitPrice?: number
        promotionalPrice?: number
        availability?: string
        enabled?: boolean
      }>
    }>
  }
}

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
})

function formatPrice(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return BRL.format(value)
}

export class IfoodApiExtractor implements ProductExtractor {
  extract(response: FetchResponse, url: string): Product {
    // URL não pôde ser resolvida em (merchantId, itemId): caller marcou.
    if (response.itemStatus === undefined) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('INVALID_URL').message,
      })
    }

    if (response.itemStatus === 404) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('NOT_FOUND', 'item ou loja inexistente').message,
      })
    }
    if (response.itemStatus === 403) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('BLOCKED', 'item-endpoint 403').message,
      })
    }
    if (response.itemStatus >= 500) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('HTTP_ERROR', `status ${response.itemStatus}`).message,
      })
    }
    if (response.itemStatus < 200 || response.itemStatus >= 300) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('HTTP_ERROR', `status ${response.itemStatus}`).message,
      })
    }

    const item = (response.itemJson as ItemPayload | undefined)?.data?.menu?.[0]?.itens?.[0]
    if (!item || typeof item !== 'object') {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('PARSE_FAILURE', 'payload sem itens[0]').message,
      })
    }

    if (!item.description) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError('PARSE_FAILURE', 'item sem description').message,
      })
    }

    // Disponibilidade explícita.
    const isAvailable = item.availability === 'AVAILABLE' && item.enabled !== false
    if (!isAvailable) {
      return createErrorProduct({
        product_url: url,
        error_message: new CrawlError(
          'OUT_OF_DELIVERY_AREA',
          `availability=${item.availability ?? 'unknown'}`,
        ).message,
      })
    }

    const normal = formatPrice(item.unitPrice)
    // promotionalPrice só conta como desconto se for menor que unitPrice.
    let discount: string | null = null
    if (
      typeof item.promotionalPrice === 'number' &&
      typeof item.unitPrice === 'number' &&
      item.promotionalPrice > 0 &&
      item.promotionalPrice < item.unitPrice
    ) {
      discount = formatPrice(item.promotionalPrice)
    }

    return createSuccessProduct({
      title: item.description,
      normal_price: normal,
      discount_price: discount,
      product_url: url,
      image_url: item.logoUrl ?? null,
    })
  }
}
