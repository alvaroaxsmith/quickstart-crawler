// Port: extrai Product de uma FetchResponse.
// Impl primária: IfoodApiExtractor (parse de JSON interceptado).
// Impl fallback: IfoodDomExtractor (parse de DOM/Next.js __NEXT_DATA__).

import type { Product } from '../../domain/product.types.js'
import type { FetchResponse } from './page-fetcher.port.js'

export interface ProductExtractor {
  extract(response: FetchResponse, url: string): Product
}
