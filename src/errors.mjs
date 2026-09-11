// Erros com codigo de saida anexado.
//
// Por que existe: nenhum modulo de `src/` chama process.exit. Quem sabe qual e
// o codigo de saida correto e quem detectou o problema, mas quem tem o direito
// de encerrar o processo e so o `bin/ccx.mjs`. O codigo viaja anexado ao erro
// para que a traducao no topo seja mecanica, sem a CLI adivinhar por texto de
// mensagem, que e o jeito frageis de fazer isso.

import { EXIT } from './protocol.mjs';

// Conjunto numerico fechado. Serve para distinguir erro nosso de erro do
// sistema: os erros de `fs` carregam codigo em string ('ENOENT', 'EPERM'), e
// comparar contra numeros separa os dois mundos sem ambiguidade.
const TAGGED_CODES = new Set(Object.values(EXIT));

/**
 * Cria um erro com codigo de saida anexado.
 *
 * DEVOLVE o erro, nao lanca. O chamador escreve `throw fail(...)`. Essa
 * escolha e do CONTRACT.md e vale a pena repetir aqui: manter o `throw`
 * visivel no ponto de uso deixa o fluxo de controle legivel e permite
 * construir um erro para inspecao sem estourar.
 *
 * @param {number} code Um valor de EXIT.
 * @param {string} message
 * @param {object} [extra] Campos extras copiados para o erro, para
 *   diagnostico estruturado (por exemplo a lista de candidatos tentados).
 * @returns {Error}
 */
export function fail(code, message, extra = {}) {
  const err = new Error(String(message ?? 'erro sem mensagem'));
  err.code = code;
  // `ccxCode` e redundante de proposito: se alguma camada sobrescrever `code`
  // com um codigo de sistema em string, o codigo original nao se perde.
  err.ccxCode = code;
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'code' || key === 'message' || key === 'stack') continue;
      err[key] = value;
    }
  }
  return err;
}

/**
 * True se o erro tem codigo conhecido de EXIT.
 *
 * A CLI usa isso para decidir entre traduzir o codigo ou tratar como falha
 * inesperada, que merece rastro de pilha em vez de mensagem curta.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTagged(err) {
  if (!err || typeof err !== 'object') return false;
  const code = 'ccxCode' in err ? err.ccxCode : err.code;
  return TAGGED_CODES.has(code);
}
