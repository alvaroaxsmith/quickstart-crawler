import { describe, expect, it } from 'vitest'
import { extractIdsFromUrl } from '../../../../src/adapters/fetcher/playwright-fetcher.adapter.js'

describe('extractIdsFromUrl', () => {
  it('parses merchantId from path[3] and itemId from ?item=', () => {
    const url =
      'https://www.ifood.com.br/delivery/sao-paulo-sp/carrefour-hiper/' +
      '5938ca36-c5ee-455b-b0ce-8211f1921be5' +
      '?item=c2296a33-6a72-415b-888b-9c9ed1b5b5fd'
    expect(extractIdsFromUrl(url)).toEqual({
      merchantId: '5938ca36-c5ee-455b-b0ce-8211f1921be5',
      itemId: 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd',
    })
  })

  it('returns nulls when path[3] is not a UUID', () => {
    const url = 'https://www.ifood.com.br/delivery/sp/loja/not-a-uuid?item=c2296a33-6a72-415b-888b-9c9ed1b5b5fd'
    expect(extractIdsFromUrl(url)).toEqual({
      merchantId: null,
      itemId: 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd',
    })
  })

  it('returns nulls when ?item= is missing or invalid', () => {
    const base = 'https://www.ifood.com.br/delivery/sp/loja/5938ca36-c5ee-455b-b0ce-8211f1921be5'
    expect(extractIdsFromUrl(base)).toEqual({
      merchantId: '5938ca36-c5ee-455b-b0ce-8211f1921be5',
      itemId: null,
    })
    expect(extractIdsFromUrl(`${base}?item=bogus`)).toEqual({
      merchantId: '5938ca36-c5ee-455b-b0ce-8211f1921be5',
      itemId: null,
    })
  })

  it('handles malformed URLs without throwing', () => {
    expect(extractIdsFromUrl('::::not a url')).toEqual({ merchantId: null, itemId: null })
  })
})
