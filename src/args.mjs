// Parser de argumentos da CLI.
//
// Por que escrever um parser em vez de usar util.parseArgs: dissecamos o
// plugin oficial `openai-codex` e encontramos dois defeitos reais que nao
// queremos repetir.
//
// 1. Token com dois tracos desconhecido cai nos positionais. Consequencia
//    medida: um `--wait` esquecido na linha de comando vaza literalmente
//    para dentro do prompt enviado ao modelo. Aqui opcao desconhecida e
//    ERRO DE USO, sempre, e a mensagem lista o que e aceito.
// 2. Flags declaradas que o codigo nunca le. Aqui a regra e a inversa: o
//    `spec` de cada subcomando declara exatamente o que aquele subcomando
//    implementa, e nada mais.
//
// O parser tambem e estrito em duas frentes que o padrao do ecossistema
// costuma deixar frouxas: opcao que exige valor sem valor e erro, e opcao
// nao repetivel repetida e erro (em vez de "o ultimo vence" silencioso,
// que esconde bug de quem monta a linha de comando programaticamente).
//
// A escotilha de escape e `--`: tudo depois dele e positional, mesmo que
// comece com traco. E assim que `ccx say <id> -- "--force esta errado"`
// consegue enviar uma mensagem que parece opcao sem virar erro de uso.

import { EXIT } from './protocol.mjs';
import { fail } from './errors.mjs';

// Valores aceitos quando um booleano recebe valor embutido (`--json=false`).
// Aceitamos as tres grafias comuns porque quem monta a chamada e outra
// maquina, e negar `on/off` so geraria atrito sem ganho de precisao.
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Nome canonico das chaves devolvidas em `options`.
 *
 * Decisao: a chave e IDENTICA ao nome declarado no spec, que por sua vez e
 * identico ao nome na linha de comando sem os tracos. Nada de conversao
 * para camelCase. Quem le o codigo e quem escreve teste nao precisa
 * adivinhar se `--timeout-ms` virou `timeoutMs` ou `timeout-ms`.
 *
 * @param {Record<string,string>} aliases
 * @param {string} name
 * @returns {string}
 */
function canonical(aliases, name) {
  return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
}

/**
 * Monta a lista legivel do que aquele subcomando aceita, para a mensagem de
 * erro ser acionavel em vez de apenas negar.
 */
function knownList(sets) {
  const names = new Set();
  for (const set of sets) for (const name of set) names.add(name);
  const sorted = [...names].sort();
  if (sorted.length === 0) return 'este subcomando nao aceita opcao nenhuma';
  return sorted.map((n) => `--${n}`).join(', ');
}

/**
 * Um token parece uma opcao? Usado para detectar valor faltando.
 *
 * Numero negativo NAO conta como opcao: `--timeout-ms -1` precisa chegar
 * como valor para que a validacao de dominio (e nao o parser) reclame do
 * numero invalido, com mensagem melhor.
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeOption(token) {
  if (token === '-' || token === '--') return false;
  if (/^-\d/.test(token)) return false;
  return token.startsWith('-');
}

/**
 * Parser estrito.
 *
 * @param {string[]} argv Argumentos ja sem o executavel e sem o subcomando.
 * @param {{
 *   booleans?: string[],
 *   strings?: string[],
 *   numbers?: string[],
 *   repeatable?: string[],
 *   aliases?: Record<string,string>
 * }} [spec]
 * @returns {{ options: Record<string, any>, positionals: string[] }}
 */
export function parse(argv, spec = {}) {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const numbers = new Set(spec.numbers ?? []);
  const repeatable = new Set(spec.repeatable ?? []);
  const aliases = spec.aliases ?? {};

  const options = {};
  const positionals = [];
  const seen = new Set();

  const isKnown = (name) => booleans.has(name) || strings.has(name) || numbers.has(name);
  const accepted = () => knownList([booleans, strings, numbers]);

  const assign = (name, value) => {
    if (repeatable.has(name)) {
      if (!Array.isArray(options[name])) options[name] = [];
      options[name].push(value);
      return;
    }
    if (seen.has(name)) {
      // Repeticao silenciosa esconde bug de quem monta a linha de comando.
      // Como o chamador tipico e o Codex, falhar alto e mais util.
      throw fail(EXIT.USAGE, `opcao --${name} repetida. ela aceita um valor so.`);
    }
    options[name] = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--') {
      // Escotilha de escape: o resto e conteudo, nao configuracao.
      for (let j = i + 1; j < argv.length; j += 1) positionals.push(argv[j]);
      break;
    }

    if (!looksLikeOption(token)) {
      positionals.push(token);
      continue;
    }

    const isLong = token.startsWith('--');
    let body = token.slice(isLong ? 2 : 1);
    let inline = null;

    const eq = body.indexOf('=');
    if (eq !== -1) {
      inline = body.slice(eq + 1);
      body = body.slice(0, eq);
    }

    if (body.length === 0) {
      throw fail(EXIT.USAGE, `argumento invalido: ${token}`);
    }

    // Aglomerado de flags curtas (`-ab`) nao e suportado de proposito: a
    // ambiguidade entre `-ab` e `-a b` e exatamente o tipo de frouxidao que
    // este parser existe para evitar. Recusa com instrucao clara.
    if (!isLong && body.length > 1) {
      throw fail(
        EXIT.USAGE,
        `opcao curta agrupada nao e suportada: ${token}. escreva separado, por exemplo -a -b.`,
      );
    }

    let name = canonical(aliases, body);

    // `--no-<booleano>` desliga. Suportado apenas para booleano DECLARADO,
    // para que `--no-qualquercoisa` continue sendo erro.
    if (!isKnown(name) && isLong && body.startsWith('no-')) {
      const base = canonical(aliases, body.slice(3));
      if (booleans.has(base)) {
        if (inline !== null) {
          throw fail(EXIT.USAGE, `--no-${base} nao aceita valor.`);
        }
        assign(base, false);
        seen.add(base);
        continue;
      }
    }

    if (!isKnown(name)) {
      throw fail(EXIT.USAGE, `opcao desconhecida: ${token}. aceitas: ${accepted()}`);
    }

    if (booleans.has(name)) {
      if (inline === null) {
        assign(name, true);
      } else {
        const lowered = inline.toLowerCase();
        if (TRUTHY.has(lowered)) assign(name, true);
        else if (FALSY.has(lowered)) assign(name, false);
        else {
          throw fail(
            EXIT.USAGE,
            `valor invalido para --${name}: ${inline}. use true ou false, ou omita o valor.`,
          );
        }
      }
      seen.add(name);
      continue;
    }

    // Daqui para baixo a opcao exige valor.
    let raw = inline;
    if (raw === null) {
      const next = argv[i + 1];
      if (next === undefined || looksLikeOption(next)) {
        throw fail(EXIT.USAGE, `--${name} exige valor.`);
      }
      raw = next;
      i += 1;
    }

    if (numbers.has(name)) {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        throw fail(EXIT.USAGE, `--${name} exige numero. recebido: ${raw}`);
      }
      assign(name, num);
    } else {
      assign(name, raw);
    }
    seen.add(name);
  }

  return { options, positionals };
}
