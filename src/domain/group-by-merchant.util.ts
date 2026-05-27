import type { ParsedIfoodUrl } from './parsed-ifood-url.types.js'

// Agrupa URLs já parseadas por merchantId. Permite que workers consumam
// URLs do mesmo merchant em sequência, reusando BrowserContext
// (cookies/Cloudflare warm-up amortizado entre items).

export interface MerchantBucket {
  merchantId: string
  merchantSlug: string
  city: string
  urls: ParsedIfoodUrl[]
}

export function groupByMerchant(urls: ParsedIfoodUrl[]): MerchantBucket[] {
  const buckets = new Map<string, MerchantBucket>()
  for (const url of urls) {
    let bucket = buckets.get(url.merchantId)
    if (!bucket) {
      bucket = {
        merchantId: url.merchantId,
        merchantSlug: url.merchantSlug,
        city: url.city,
        urls: [],
      }
      buckets.set(url.merchantId, bucket)
    }
    bucket.urls.push(url)
  }
  return Array.from(buckets.values())
}

// Para evitar 1 merchant grande monopolizar 1 worker, divide buckets
// em sub-buckets de tamanho máximo. KISS: split sequencial.
export function splitLargeBuckets(
  buckets: MerchantBucket[],
  maxBucketSize: number,
): MerchantBucket[] {
  if (maxBucketSize <= 0) {
    throw new Error('maxBucketSize deve ser > 0')
  }
  const result: MerchantBucket[] = []
  for (const bucket of buckets) {
    if (bucket.urls.length <= maxBucketSize) {
      result.push(bucket)
      continue
    }
    for (let i = 0; i < bucket.urls.length; i += maxBucketSize) {
      result.push({
        merchantId: bucket.merchantId,
        merchantSlug: bucket.merchantSlug,
        city: bucket.city,
        urls: bucket.urls.slice(i, i + maxBucketSize),
      })
    }
  }
  return result
}
