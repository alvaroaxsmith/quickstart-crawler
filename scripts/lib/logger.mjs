/**
 * logger.mjs — factory de logger com prefixo consistente para scripts de pipeline
 */

/**
 * Cria um logger prefixado.
 * @param {string} prefix  ex: 'pipeline', 'batch', 'cf-renew'
 * @returns {{ info, warn, error, raw, header }}
 */
export function createLogger(prefix) {
    const p = `[${prefix}]`
    return {
        info: msg => console.log(`${p} ${msg}`),
        warn: msg => console.warn(`${p} ⚠️  ${msg}`),
        error: msg => console.error(`${p} ❌ ${msg}`),
        /** Escreve sem newline extra (útil para progresso em linha única). */
        raw: msg => process.stdout.write(`${p} ${msg}\n`),
        /** Imprime um cabeçalho de seção com linha separadora. */
        header(msg) {
            const bar = '═'.repeat(50)
            console.log(`\n${p} ${bar}`)
            console.log(`${p}  ${msg}`)
            console.log(`${p} ${bar}`)
        },
    }
}