import { describe, it, expect } from 'vitest'
import { parseItemResponse } from '../../../src/lib/parser.js'

const ITEM_ID = 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd'

function makeResponse(itens: Record<string, unknown>[] = []) {
  return {
    code: '00',
    data: { menu: [{ itens }] },
  }
}

describe('parseItemResponse', () => {
  it('retorna null para json null', () => {
    expect(parseItemResponse(null, ITEM_ID)).toBeNull()
  })

  it('retorna null quando não há preço no payload', () => {
    const json = makeResponse([{ id: ITEM_ID, description: 'Sem preço' }])
    expect(parseItemResponse(json, ITEM_ID)).toBeNull()
  })

  it('retorna ParsedItem com dados completos', () => {
    const json = makeResponse([
      {
        id: ITEM_ID,
        unitPrice: 31.99,
        description: 'Produto',
        logoUrl: 'https://img.example.com/x.jpg',
      },
    ])
    const result = parseItemResponse(json, ITEM_ID)
    expect(result).not.toBeNull()
    expect(result?.normalPrice).toBe(31.99)
    expect(result?.discountPrice).toBeNull()
    expect(result?.title).toBe('Produto')
    expect(result?.logoUrl).toBe('https://img.example.com/x.jpg')
  })

  it('retorna discountPrice quando há promoção', () => {
    const json = makeResponse([{ id: ITEM_ID, originalPrice: 40.0, unitPrice: 31.99 }])
    const result = parseItemResponse(json, ITEM_ID)
    expect(result?.normalPrice).toBe(40.0)
    expect(result?.discountPrice).toBe(31.99)
  })
})
