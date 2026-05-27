/**
 * process.mjs — utilitário para spawn de processos filho com output em tempo real
 */

import { spawn } from 'child_process'
import { createWriteStream } from 'fs'

/**
 * Executa um comando com stdout/stderr em tempo real.
 * Opcionalmente grava a saída num arquivo de log.
 *
 * @param {string}   cmd
 * @param {string[]} args
 * @param {object}   [opts]
 * @param {string}   [opts.cwd]       diretório de trabalho (default: process.cwd())
 * @param {string}   [opts.logFile]   caminho do arquivo de log
 * @param {boolean}  [opts.append]    se true, abre o log em modo append
 * @returns {Promise<number>}  exit code do processo
 */
export function run(cmd, args, { cwd = process.cwd(), logFile, append = false } = {}) {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'] })
        const logStream = logFile ?
            createWriteStream(logFile, { flags: append ? 'a' : 'w' }) :
            null

        const write = data => { process.stdout.write(data);
            logStream ?.write(data) }
        const writeErr = data => { process.stderr.write(data);
            logStream ?.write(data) }

        child.stdout.on('data', write)
        child.stderr.on('data', writeErr)
        child.on('close', code => { logStream ?.end();
            resolve(code ?? 0) })
    })
}