import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupByMerchant, splitLargeBuckets } from '../../../src/domain/group-by-merchant.util.js'
import { parseIfoodUrl } from '../../../src/domain/parsed-ifood-url.types.js'

const REAL_DATASET = resolve(process.cwd(), 'input/urls.csv')

function loadRealParsedUrls(): ReturnType<typeof parseIfoodUrl>[] {
  const content = readFileSync(REAL_DATASET, 'utf-8')
  return content
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(1)
    .map(parseIfoodUrl)
}

describe('groupByMerchant', () => {
  it('agrupa URLs do mesmo merchant em um único bucket', () => {
    const a = parseIfoodUrl(
      'https://www.ifood.com.br/delivery/sp/loja-x/00000000-0000-0000-0000-000000000001?item=11111111-1111-1111-1111-111111111111',
    )
    const b = parseIfoodUrl(
      'https://www.ifood.com.br/delivery/sp/loja-x/00000000-0000-0000-0000-000000000001?item=22222222-2222-2222-2222-222222222222',
    )
    const c = parseIfoodUrl(
      'https://www.ifood.com.br/delivery/sp/loja-y/00000000-0000-0000-0000-000000000002?item=33333333-3333-3333-3333-333333333333',
    )
    const buckets = groupByMerchant([a, b, c])
    expect(buckets).toHaveLength(2)
    const first = buckets.find((x) => x.merchantId === a.merchantId)!
    expect(first.urls).toHaveLength(2)
  })

  it('preserva merchantSlug e city no bucket', () => {
    const u = parseIfoodUrl(
      'https://www.ifood.com.br/delivery/sao-paulo-sp/loja-z/00000000-0000-0000-0000-000000000001?item=11111111-1111-1111-1111-111111111111',
    )
    const [bucket] = groupByMerchant([u])
    expect(bucket!.merchantSlug).toBe('loja-z')
    expect(bucket!.city).toBe('sao-paulo-sp')
  })

  it('input vazio retorna array vazio', () => {
    expect(groupByMerchant([])).toEqual([])
  })

  it('soma dos urls em todos os buckets == total de entrada', () => {
    const urls = loadRealParsedUrls()
    const buckets = groupByMerchant(urls)
    const total = buckets.reduce((acc, b) => acc + b.urls.length, 0)
    expect(total).toBe(urls.length)
  })

  it('cada merchantId aparece em exatamente 1 bucket no dataset real', () => {
    const urls = loadRealParsedUrls()
    const buckets = groupByMerchant(urls)
    const ids = buckets.map((b) => b.merchantId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('splitLargeBuckets', () => {
  it('não divide buckets dentro do limite', () => {
    const u = parseIfoodUrl(
      'https://www.ifood.com.br/delivery/sp/x/00000000-0000-0000-0000-000000000001?item=11111111-1111-1111-1111-111111111111',
    )
    const buckets = groupByMerchant([u, u, u])
    expect(splitLargeBuckets(buckets, 10)).toHaveLength(1)
  })

  it('divide bucket grande em sub-buckets do tamanho exato', () => {
    const baseMerchant = '00000000-0000-0000-0000-000000000001'
    const urls = Array.from({ length: 25 }, (_, i) => {
      const itemId = `11111111-1111-1111-1111-${String(i).padStart(12, '0')}`
      return parseIfoodUrl(
        `https://www.ifood.com.br/delivery/sp/x/${baseMerchant}?item=${itemId}`,
      )
    })
    const [bucket] = groupByMerchant(urls)
    const split = splitLargeBuckets([bucket!], 10)
    expect(split).toHaveLength(3)
    expect(split[0]!.urls).toHaveLength(10)
    expect(split[1]!.urls).toHaveLength(10)
    expect(split[2]!.urls).toHaveLength(5)
    expect(split.every((b) => b.merchantId === baseMerchant)).toBe(true)
  })

  it('rejeita maxBucketSize inválido', () => {
    expect(() => splitLargeBuckets([], 0)).toThrow()
    expect(() => splitLargeBuckets([], -1)).toThrow()
  })
})
