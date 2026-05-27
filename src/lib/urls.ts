/**
 * urls — utilitários de parsing de URLs do iFood.
 */

/**
 * Extrai merchantId e itemId de uma URL de produto do iFood.
 * Suporta o formato: /delivery/.../slug/{merchantId}?item={itemId}
 */
export function parseProductUrl(
  url: string | undefined,
): { merchantId: string; itemId: string } | null {
  const m = url?.match(/\/([0-9a-f-]{36})\?item=([0-9a-f-]{36})/)
  return m ? { merchantId: m[1], itemId: m[2] } : null
}

/**
 * Constrói a URL da items API interna do iFood.
 */
export function buildItemApiUrl(merchantId: string, itemId: string): string {
  return `https://www.ifood.com.br/site-api/v1/merchants/restaurant/${merchantId}/items/${itemId}`
}
