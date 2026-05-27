/**
 * parser.mjs — parsing de respostas da items API do iFood.
 *
 * Camada de interpretação entre o JSON bruto capturado da rede
 * e os dados estruturados de preço usados pelos scripts de batch.
 */

import { extractPrice } from './price.mjs'

/**
 * Interpreta a resposta JSON da items API e retorna os preços estruturados.
 * Retorna null se a resposta for inválida ou não contiver dados de preço.
 *
 * @param {object|null} capturedJson  Corpo JSON da resposta da items API
 * @param {string}      itemId        UUID do item buscado
 * @returns {{ normalPrice: number, discountPrice: number|null } | null}
 */
export function parseItemResponse(capturedJson, itemId) {
    if (!capturedJson) return null
    const { normalPrice, discountPrice, title } = extractPrice(capturedJson, itemId)
    if (normalPrice === null) return null
    return { normalPrice, discountPrice, title }
}