/**
 * input.mjs — leitura e normalização de arquivos de entrada.
 *
 * Centraliza o mapeamento grupo→arquivo e o carregamento de itens,
 * evitando duplicação entre os scripts de batch.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Retorna o mapeamento padrão de grupo → caminho de arquivo.
 *
 * @param {string} projectRoot  Raiz do projeto (ex: dirname de import.meta.url)
 * @returns {Record<string, string>}
 */
export function defaultUrlFiles(projectRoot) {
    return {
        pao: process.env.URL_FILE_PAO ?? resolve(projectRoot, 'data/groups/urls-pao.json'),
        carrefour: process.env.URL_FILE_CARREFOUR ?? resolve(projectRoot, 'data/groups/urls-carrefour.json'),
        farmacia: process.env.URL_FILE_FARMACIA ?? resolve(projectRoot, 'data/groups/urls-farmacia.json'),
        all: process.env.URL_FILE_ALL ?? resolve(projectRoot, 'data/groups/urls-all.json'),
    }
}

/**
 * Lê e parseia um arquivo JSON de URLs.
 *
 * @param {string} filePath
 * @returns {Array<{merchantId:string, itemId:string, productUrl:string, name?:string}>}
 */
export function readUrlFile(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8'))
}

/**
 * Carrega itens de um arquivo de URLs com suporte a slice por índice.
 *
 * @param {string} filePath
 * @param {number} [fromIdx=0]
 * @param {number} [toIdx=Infinity]
 * @returns {{ items: Array, total: number }}
 */
export function loadItems(filePath, fromIdx = 0, toIdx = Infinity) {
    const all = readUrlFile(filePath)
    const end = Number.isFinite(toIdx) ? toIdx + 1 : all.length
    return {
        items: all.slice(fromIdx, end),
        total: all.length,
    }
}