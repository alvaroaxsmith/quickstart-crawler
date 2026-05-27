/**
 * cli.mjs — helpers de parsing de argumentos de linha de comando
 */

/**
 * Retorna true se o flag (ex: '--reset') está presente nos args.
 * @param {string[]} args
 * @param {string}   name  ex: '--reset'
 */
export function hasFlag(args, name) {
    return args.includes(name)
}

/**
 * Retorna o valor do argumento nomeado (ex: '--group pao' → 'pao').
 * Retorna defaultValue se o argumento não estiver presente.
 * @param {string[]} args
 * @param {string}   name          ex: '--group'
 * @param {string}   [defaultValue]
 */
export function getOption(args, name, defaultValue = undefined) {
    const idx = args.indexOf(name)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultValue
}