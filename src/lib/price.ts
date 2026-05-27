/**
 * price — utilitários de extração e formatação de preços do iFood.
 */

export interface PriceResult {
  normalPrice: number | null
  discountPrice: number | null
  title: string | null
  logoUrl: string | null
}

interface MenuItem {
  id?: string
  description?: string
  logoUrl?: string
  unitPrice?: number
  originalPrice?: number
}

interface MenuCategory {
  itens?: MenuItem[]
}

interface IfoodApiResponse {
  code?: string
  data?: { menu?: MenuCategory[] }
}

export function formatBRL(val: number | null | undefined): string | null {
  if (val == null) return null
  return 'R$ ' + Number(val).toFixed(2).replace('.', ',')
}

export function extractPrice(capturedJson: unknown, itemId: string): PriceResult {
  const empty: PriceResult = { normalPrice: null, discountPrice: null, title: null, logoUrl: null }
  if (!capturedJson) return empty

  const json = capturedJson as IfoodApiResponse
  if (json.code !== '00') return empty

  const menu = json.data?.menu ?? []

  for (const cat of menu) {
    for (const it of cat.itens ?? []) {
      if (it.id === itemId || it.id === itemId?.replace(/-/g, '')) {
        const normal = it.originalPrice ?? it.unitPrice ?? null
        const discount =
          it.originalPrice != null && it.unitPrice != null && it.originalPrice !== it.unitPrice
            ? it.unitPrice
            : null
        return {
          normalPrice: normal,
          discountPrice: discount,
          title: it.description ?? null,
          logoUrl: it.logoUrl ?? null,
        }
      }
    }
  }

  // Fallback: usa o primeiro item do menu quando o itemId não corresponde
  const first = menu[0]?.itens?.[0]
  if (!first) return empty

  const normal = first.originalPrice ?? first.unitPrice ?? null
  const discount =
    first.originalPrice != null &&
    first.unitPrice != null &&
    first.originalPrice !== first.unitPrice
      ? first.unitPrice
      : null
  return {
    normalPrice: normal,
    discountPrice: discount,
    title: first.description ?? null,
    logoUrl: first.logoUrl ?? null,
  }
}
