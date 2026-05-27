import { describe, expect, it } from 'vitest'
import { IfoodApiExtractor } from '../../../../src/adapters/extractor/ifood-api-extractor.adapter.js'
import type { FetchResponse } from '../../../../src/application/ports/page-fetcher.port.js'

const URL =
  'https://www.ifood.com.br/delivery/sp/loja/' +
  '5938ca36-c5ee-455b-b0ce-8211f1921be5' +
  '?item=c2296a33-6a72-415b-888b-9c9ed1b5b5fd'

function fetchRes(over: Partial<FetchResponse>): FetchResponse {
  return {
    html: '',
    httpStatus: 200,
    durationMs: 0,
    ...over,
  }
}

function payload(itemFields: Record<string, unknown>): unknown {
  return { data: { menu: [{ itens: [itemFields] }] } }
}

describe('IfoodApiExtractor', () => {
  const extractor = new IfoodApiExtractor()

  it('produces a success product on 200 with available item and unitPrice only', () => {
    const res = fetchRes({
      itemStatus: 200,
      itemJson: payload({
        description: 'Desengordurante Veja 500ml',
        unitPrice: 17.42,
        availability: 'AVAILABLE',
        enabled: true,
        logoUrl: 'https://cdn/img.jpg',
      }),
    })

    const p = extractor.extract(res, URL)

    expect(p.status).toBe('success')
    expect(p.title).toBe('Desengordurante Veja 500ml')
    expect(p.normal_price).toBe('R$\u00a017,42')
    expect(p.discount_price).toBeNull()
    expect(p.image_url).toBe('https://cdn/img.jpg')
    expect(p.error_message).toBeNull()
  })

  it('produces discount_price when promotionalPrice < unitPrice', () => {
    const res = fetchRes({
      itemStatus: 200,
      itemJson: payload({
        description: 'Veja Limão Promo',
        unitPrice: 31.99,
        promotionalPrice: 23.99,
        availability: 'AVAILABLE',
        enabled: true,
      }),
    })

    const p = extractor.extract(res, URL)

    expect(p.status).toBe('success')
    expect(p.normal_price).toBe('R$\u00a031,99')
    expect(p.discount_price).toBe('R$\u00a023,99')
  })

  it('ignores promotionalPrice when not actually a discount (>= unitPrice)', () => {
    const res = fetchRes({
      itemStatus: 200,
      itemJson: payload({
        description: 'X',
        unitPrice: 10,
        promotionalPrice: 10,
        availability: 'AVAILABLE',
        enabled: true,
      }),
    })

    expect(extractor.extract(res, URL).discount_price).toBeNull()
  })

  it('returns NOT_FOUND error on 404 item-endpoint', () => {
    const p = extractor.extract(fetchRes({ itemStatus: 404 }), URL)
    expect(p.status).toBe('error')
    expect(p.title).toBeNull()
    expect(p.error_message).toMatch(/indisponível ou removido/i)
  })

  it('returns BLOCKED error on 403', () => {
    const p = extractor.extract(fetchRes({ itemStatus: 403 }), URL)
    expect(p.error_message).toMatch(/bloqueado/i)
  })

  it('returns HTTP_ERROR error on 5xx', () => {
    const p = extractor.extract(fetchRes({ itemStatus: 503 }), URL)
    expect(p.error_message).toMatch(/HTTP/i)
  })

  it('returns INVALID_URL when itemStatus is undefined (URL not resolvable)', () => {
    const p = extractor.extract(fetchRes({ itemStatus: undefined }), URL)
    expect(p.error_message).toMatch(/malformada|não pertence/i)
  })

  it('returns PARSE_FAILURE when payload misses itens[0]', () => {
    const p = extractor.extract(fetchRes({ itemStatus: 200, itemJson: { data: { menu: [] } } }), URL)
    expect(p.error_message).toMatch(/Estrutura/i)
  })

  it('returns OUT_OF_DELIVERY_AREA when availability !== AVAILABLE', () => {
    const res = fetchRes({
      itemStatus: 200,
      itemJson: payload({ description: 'X', unitPrice: 10, availability: 'UNAVAILABLE', enabled: true }),
    })
    const p = extractor.extract(res, URL)
    expect(p.error_message).toMatch(/não entrega/i)
  })

  it('returns OUT_OF_DELIVERY_AREA when enabled is false', () => {
    const res = fetchRes({
      itemStatus: 200,
      itemJson: payload({ description: 'X', unitPrice: 10, availability: 'AVAILABLE', enabled: false }),
    })
    const p = extractor.extract(res, URL)
    expect(p.error_message).toMatch(/não entrega/i)
  })
})
