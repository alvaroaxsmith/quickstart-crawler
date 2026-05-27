import { describe, it, expect } from 'vitest'
import { parseProductUrl, buildItemApiUrl } from '../../../src/lib/urls.js'

const MERCHANT = '5938ca36-c5ee-455b-b0ce-8211f1921be5'
const ITEM = 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd'
const VALID_URL = `https://www.ifood.com.br/delivery/brasilia-df/pao-de-acucar/slug/${MERCHANT}?item=${ITEM}`

describe('parseProductUrl', () => {
  it('extrai merchantId e itemId de URL válida', () => {
    expect(parseProductUrl(VALID_URL)).toEqual({ merchantId: MERCHANT, itemId: ITEM })
  })

  it('retorna null para URL sem UUIDs', () => {
    expect(parseProductUrl('https://www.ifood.com.br/')).toBeNull()
  })

  it('retorna null para undefined', () => {
    expect(parseProductUrl(undefined)).toBeNull()
  })

  it('retorna null para URL com apenas merchantId (sem item=)', () => {
    expect(parseProductUrl(`https://www.ifood.com.br/delivery/${MERCHANT}`)).toBeNull()
  })
})

describe('buildItemApiUrl', () => {
  it('constrói URL correta da items API', () => {
    expect(buildItemApiUrl(MERCHANT, ITEM)).toBe(
      `https://www.ifood.com.br/site-api/v1/merchants/restaurant/${MERCHANT}/items/${ITEM}`,
    )
  })
})
