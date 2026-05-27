/**
 * price.mjs — utilitários de extração e formatação de preços do iFood.
 */

/**
 * Formata um valor numérico (em centavos/real) como string "R$ XX,XX".
 *
 * @param {number | null | undefined} val  Valor monetário (ex: 31.99 ou 3199)
 * @returns {string | null}
 */
export function formatBRL(val) {
    if (val == null) return null
    return 'R$ ' + Number(val).toFixed(2).replace('.', ',')
}

/**
 * Extrai preço normal e preço de desconto de uma resposta da items API.
 * A API retorna:
 *   - originalPrice: preço original (antes de desconto), null quando não há promoção
 *   - unitPrice: preço atual de venda
 * Desconto real = originalPrice > unitPrice.
 *
 * @param {object | null} capturedJson  Corpo JSON da resposta da items API
 * @param {string} itemId               ID do item a localizar no menu
 * @returns {{ normalPrice: number | null, discountPrice: number | null }}
 */
export function extractPrice(capturedJson, itemId) {
    if (!capturedJson || capturedJson.code !== '00') {
        return { normalPrice: null, discountPrice: null, title: null }
    }

    const menu = capturedJson.data ?.menu ?? []

    for (const cat of menu) {
        for (const it of(cat.itens ?? [])) {
            if (it.id === itemId || it.id === itemId ?.replace(/-/g, '')) {
                const normal = it.originalPrice ?? it.unitPrice ?? null
                const discount = (it.originalPrice != null && it.unitPrice != null && it.originalPrice !== it.unitPrice) ?
                    it.unitPrice :
                    null
                return { normalPrice: normal, discountPrice: discount, title: it.description ?? null }
            }
        }
    }

    // Fallback: usa o primeiro item do menu quando o itemId não corresponde
    const first = menu[0] ?.itens ?.[0]
    if (!first) return { normalPrice: null, discountPrice: null, title: null }

    const normal = first.originalPrice ?? first.unitPrice ?? null
    const discount = (first.originalPrice != null && first.unitPrice != null && first.originalPrice !== first.unitPrice) ?
        first.unitPrice :
        null
    return { normalPrice: normal, discountPrice: discount, title: first.description ?? null }
}