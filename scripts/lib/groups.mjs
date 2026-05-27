/**
 * groups.mjs — mapeamento de merchants por grupo
 *
 * Utilitários para distribuir produtos nos grupos de crawler
 * (pao, carrefour, farmacia) a partir de suas URLs de produto.
 */

/**
 * Mapeia slug de merchant → grupo.
 * @param {string} slug
 * @returns {'pao'|'carrefour'|'farmacia'|null}
 */
export function slugToGroup(slug) {
    if (slug.includes('pao-de-acucar')) return 'pao'
    if (slug.includes('carrefour')) return 'carrefour'
    if (
        slug.includes('droga') || slug.includes('farma') ||
        slug.includes('panvel') || slug.includes('raia') ||
        slug.includes('ultrafarma')
    ) return 'farmacia'
    return null // ignora merchants desativados / outros
}

/**
 * Distribui produtos em buckets por grupo a partir de product_url.
 * @param {Array<{ product_url?: string, productUrl?: string, title?: string, name?: string }>} products
 * @returns {{ pao: object[], carrefour: object[], farmacia: object[] }}
 */
export function splitIntoGroups(products) {
    const buckets = { pao: [], carrefour: [], farmacia: [] }
    for (const p of products) {
        const url = p.product_url || p.productUrl || ''
        const match = url.match(/delivery\/[^/]+\/([^/]+)\//)
        if (!match) continue
        const slug = match[1].split('---')[0]
        const group = slugToGroup(slug)
        if (!group) continue
        buckets[group].push({ productUrl: url, name: p.title || p.name || '' })
    }
    return buckets
}