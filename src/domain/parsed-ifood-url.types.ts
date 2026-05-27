// Parse puro de URLs do iFood. Sem I/O, sem deps externas.
// Padrão observado nas 999 URLs reais do dataset:
//   https://www.ifood.com.br/delivery/<city-uf>/<merchant-slug>/<merchant-uuid>?item=<item-uuid>

export interface ParsedIfoodUrl {
  raw: string
  city: string
  merchantSlug: string
  merchantId: string
  itemId: string
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IFOOD_URL_RE = new RegExp(
  `^https?://(?:www\\.)?ifood\\.com\\.br/delivery/([^/]+)/([^/]+)/(${UUID_RE})\\?item=(${UUID_RE})$`,
  'i',
)

export class InvalidIfoodUrlError extends Error {
  constructor(url: string) {
    super(`URL não corresponde ao padrão iFood: ${url}`)
    this.name = 'InvalidIfoodUrlError'
  }
}

export function parseIfoodUrl(url: string): ParsedIfoodUrl {
  const match = IFOOD_URL_RE.exec(url.trim())
  if (!match) {
    throw new InvalidIfoodUrlError(url)
  }
  const [, city, merchantSlug, merchantId, itemId] = match
  return {
    raw: url,
    city: city!.toLowerCase(),
    merchantSlug: merchantSlug!,
    merchantId: merchantId!.toLowerCase(),
    itemId: itemId!.toLowerCase(),
  }
}

export function tryParseIfoodUrl(url: string): ParsedIfoodUrl | null {
  try {
    return parseIfoodUrl(url)
  } catch {
    return null
  }
}
