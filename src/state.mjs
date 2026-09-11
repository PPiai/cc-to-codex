// Toda a I/O de estado de sessao. Nenhum outro modulo abre esses arquivos.
//
// O padrao de acesso e assimetrico e isso dita o desenho: ha UM escritor por
// sessao (o supervisor) e N leitores efemeros (cada invocacao da CLI). Duas
// consequencias que aparecem em todo o arquivo:
//
// - Quem escreve arquivo lido concorrentemente escreve em temporario e
//   renomeia. Leitor jamais ve `state.json` pela metade.
// - Quem le arquivo de acrescimo tolera a ultima linha incompleta, porque
//   pegar o arquivo no meio de um append e normal, nao e corrupcao.

import fs from 'node:fs';
import path from 'node:path';

import { EXIT, FILES, STATE_SCHEMA } from './protocol.mjs';
import { fail } from './errors.mjs';
import { filePath, sessionDir, sessionsDir } from './paths.mjs';

const nowIso = () => new Date().toISOString();

// Codigos em que vale tentar de novo no Windows. Antivirus e indexador
// seguram o handle por instantes e devolvem justamente esses. EEXIST NAO
// entra: o rename sobre arquivo existente funciona no Windows e e disso que
// a atomicidade depende, entao um EEXIST aqui seria outra coisa e tem de
// aparecer em vez de virar retentativa cega.
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Gravacao atomica: escreve em temporario e renomeia.
 *
 * O nome do temporario inclui o pid para que dois processos escrevendo por
 * engano no mesmo alvo nao destruam o temporario um do outro e produzam um
 * arquivo final meio a meio, que e o unico jeito de a atomicidade falhar.
 *
 * No Windows o rename sobre arquivo existente funciona, mas pode falhar de
 * forma transitoria. Uma unica retirada seguida de nova tentativa resolve o
 * caso real; laco de retentativa infinita esconderia problema de permissao.
 */
function writeAtomic(target, text) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, target);
    return;
  } catch (err) {
    if (!RETRYABLE.has(err.code)) {
      safeUnlink(tmp);
      throw err;
    }
    try {
      fs.unlinkSync(target);
    } catch {
      // Alvo pode nem existir. O que importa e a segunda tentativa abaixo.
    }
    try {
      fs.renameSync(tmp, target);
    } catch (second) {
      // Sem isso, cada falha deixa um `.tmp` orfao acumulando na sessao.
      safeUnlink(tmp);
      throw second;
    }
  }
}

function safeUnlink(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // Nada a fazer: a limpeza e melhor-esforco.
  }
}

function readJsonFile(file, { missingCode, label }) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw fail(missingCode, `${label} nao encontrado: ${file}`);
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(EXIT.BAD_STATE, `${label} ilegivel, JSON invalido: ${file}`);
  }
  // Schema so e conferido quando declarado. Estado gravado por um supervisor
  // de outra versao e recusado em vez de interpretado, porque campo que mudou
  // de significado e pior que campo ausente.
  if (parsed && parsed.schema !== undefined && parsed.schema !== STATE_SCHEMA) {
    throw fail(
      EXIT.BAD_STATE,
      `${label} com schema ${parsed.schema}, esperado ${STATE_SCHEMA}. Remova a sessao com "ccx rm --force".`,
    );
  }
  return parsed;
}

/** Linhas nao vazias de um arquivo de acrescimo. Arquivo ausente vira lista vazia. */
function readAppendLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Contadores em memoria
// ---------------------------------------------------------------------------
//
// `appendEvent` e chamado uma vez por evento do fluxo, e um turno gera
// centenas. Reler o arquivo inteiro para descobrir o proximo numero seria
// quadratico ao longo da sessao. Como existe um unico escritor por sessao, o
// contador pode viver em memoria, semeado por uma leitura so na primeira
// chamada. Se outro processo escrever no mesmo arquivo, a premissa cai, e e
// por isso que ela esta escrita aqui em vez de implicita.

const eventCounters = new Map();
const commandCounters = new Map();
const rawEnabled = new Map();

const counterKey = (root, id) => `${path.resolve(root)}|${id}`;

function nextOrdinal(counters, root, id, fileKey) {
  const key = counterKey(root, id);
  let last = counters.get(key);
  if (last === undefined) {
    last = readAppendLines(filePath(root, id, fileKey)).length;
  }
  const next = last + 1;
  counters.set(key, next);
  return next;
}

function rollbackOrdinal(counters, root, id, ordinal) {
  const key = counterKey(root, id);
  if (counters.get(key) === ordinal) counters.set(key, ordinal - 1);
}

function forgetSession(root, id) {
  const key = counterKey(root, id);
  eventCounters.delete(key);
  commandCounters.delete(key);
  rawEnabled.delete(key);
}

// ---------------------------------------------------------------------------
// Ciclo de vida da sessao
// ---------------------------------------------------------------------------

/**
 * Cria o diretorio da sessao e grava `meta.json`.
 *
 * O diretorio folha e criado SEM `recursive`, de proposito: `newId` sorteia
 * oito caracteres e declara que colisao e tratada por quem cria o diretorio.
 * Com `recursive` o EEXIST seria engolido e duas sessoes passariam a escrever
 * no mesmo lugar. Assim a colisao vira erro e o dispatch sorteia outro id.
 *
 * @param {string} root
 * @param {string} id
 * @param {object} meta
 * @returns {void}
 */
export function initSession(root, id, meta) {
  fs.mkdirSync(sessionsDir(root), { recursive: true });
  try {
    fs.mkdirSync(sessionDir(root, id));
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw fail(EXIT.BAD_STATE, `id de sessao ja em uso: ${id}. Sorteie outro id e repita.`, {
        collision: true,
      });
    }
    throw err;
  }
  forgetSession(root, id);
  // `id` fica por ultimo para ser autoritativo: o nome do diretorio e a
  // verdade, e um `meta` com id divergente nao pode vencer.
  const record = { schema: STATE_SCHEMA, createdAt: nowIso(), ...(meta || {}), id };
  writeAtomic(filePath(root, id, 'meta'), `${JSON.stringify(record, null, 2)}\n`);
}

/** @returns {object} fail(EXIT.NO_SESSION) se ausente. */
export function readMeta(root, id) {
  return readJsonFile(filePath(root, id, 'meta'), {
    missingCode: EXIT.NO_SESSION,
    label: `meta da sessao ${id}`,
  });
}

/**
 * Grava o estado compacto de forma atomica.
 *
 * `updatedAt` e preenchido aqui quando o chamador nao trouxe um, porque o
 * momento da persistencia e o unico que este modulo conhece com certeza. Um
 * valor explicito do chamador e respeitado, para que o teste possa congelar o
 * relogio.
 */
export function writeState(root, id, state) {
  const record = {
    ...(state || {}),
    schema: STATE_SCHEMA,
    id,
    updatedAt: (state && state.updatedAt) || nowIso(),
  };
  writeAtomic(filePath(root, id, 'state'), `${JSON.stringify(record)}\n`);
}

/** @returns {object} fail(EXIT.NO_SESSION) se ausente. */
export function readState(root, id) {
  return readJsonFile(filePath(root, id, 'state'), {
    missingCode: EXIT.NO_SESSION,
    label: `estado da sessao ${id}`,
  });
}

/** Le, mescla raso, grava e devolve o estado resultante. */
export function patchState(root, id, partial) {
  const current = readState(root, id);
  const merged = { ...current, ...(partial || {}), updatedAt: nowIso() };
  writeState(root, id, merged);
  return merged;
}

/** Grava o settings.json da sessao e devolve o caminho absoluto. */
export function writeSettings(root, id, settings) {
  const target = filePath(root, id, 'settings');
  writeAtomic(target, `${JSON.stringify(settings ?? {}, null, 2)}\n`);
  return target;
}

// ---------------------------------------------------------------------------
// Log de eventos digeridos
// ---------------------------------------------------------------------------

/**
 * Acrescenta uma entrada digerida e devolve o `n` atribuido (1-based).
 *
 * O `n` e ESTAMPADO dentro da linha gravada, e nao deduzido da posicao na
 * leitura. E o que mantem o cursor correto: se uma linha futura nascer
 * corrompida, a numeracao de todas as seguintes continua valida, porque cada
 * uma carrega o proprio numero.
 *
 * @returns {number}
 */
export function appendEvent(root, id, entry) {
  const n = nextOrdinal(eventCounters, root, id, 'events');
  const { n: _discarded, ts, ...rest } = entry || {};
  const record = { n, ts: ts || nowIso(), ...rest };
  try {
    fs.appendFileSync(filePath(root, id, 'events'), `${JSON.stringify(record)}\n`);
  } catch (err) {
    // Sem o rollback, uma falha transitoria de escrita abriria um buraco
    // permanente na numeracao e o cursor do orquestrador nunca fecharia.
    rollbackOrdinal(eventCounters, root, id, n);
    throw err;
  }
  return n;
}

/**
 * Acrescenta o evento cru. No-op quando o modo cru esta desligado.
 *
 * Convencao escolhida aqui: o modo cru esta ligado se, e somente se,
 * `raw.jsonl` ja existe. O dispatch cria o arquivo vazio quando recebe
 * `--raw`, antes de spawnar o supervisor. E auto-descritivo em disco e
 * dispensa passar a flag pelo `meta`. O resultado e memorizado por sessao
 * para nao virar um `stat` por evento.
 */
export function appendRaw(root, id, ev) {
  const key = counterKey(root, id);
  let enabled = rawEnabled.get(key);
  if (enabled === undefined) {
    enabled = fs.existsSync(filePath(root, id, 'raw'));
    rawEnabled.set(key, enabled);
  }
  if (!enabled) return;
  try {
    fs.appendFileSync(filePath(root, id, 'raw'), `${JSON.stringify(ev)}\n`);
  } catch {
    // O log cru e diagnostico opcional. Derrubar o supervisor por causa dele
    // seria trocar o essencial pelo acessorio.
  }
}

/**
 * Le entradas digeridas a partir de um cursor.
 *
 * `since` e o `n` da ultima entrada ja vista; zero ou ausente significa do
 * inicio. Tres invariantes que o chamador depende e que sao faceis de errar:
 *
 * - O cursor devolvido e o `n` da ultima entrada DEVOLVIDA, nunca o total do
 *   arquivo. Com `limit`, avancar mais que isso puliria o restante.
 * - Sem entrada nova, o cursor devolvido e o proprio `since`. Devolver zero
 *   rebobinaria o orquestrador para o inicio da sessao.
 * - Linha que nao parseia e ignorada como entrada mas nao trava o cursor:
 *   como o `n` vem estampado na linha, uma linha parcial no fim simplesmente
 *   nao produz entrada e e relida completa na chamada seguinte.
 *
 * @returns {{entries: object[], cursor: number, remaining: number}}
 */
export function readEvents(root, id, { since = 0, limit } = {}) {
  const from = Number.isFinite(Number(since)) ? Number(since) : 0;
  const lines = readAppendLines(filePath(root, id, 'events'));

  const parsed = [];
  let malformed = 0;
  lines.forEach((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Contada para diagnostico, e nunca usada para avancar o cursor.
      malformed += 1;
      return;
    }
    if (!entry || typeof entry !== 'object') {
      malformed += 1;
      return;
    }
    // Posicao e so rede de seguranca para entrada gravada sem `n`.
    const n = Number.isInteger(entry.n) ? entry.n : index + 1;
    parsed.push({ ...entry, n });
  });

  const fresh = parsed.filter((entry) => entry.n > from);
  const capped = Number.isInteger(limit) && limit > 0 ? fresh.slice(0, limit) : fresh;
  const cursor = capped.length > 0 ? capped[capped.length - 1].n : from;
  const remaining = parsed.filter((entry) => entry.n > cursor).length;

  return { entries: capped, cursor, remaining, malformed };
}

// ---------------------------------------------------------------------------
// Canal de comandos
// ---------------------------------------------------------------------------

/**
 * Acrescenta um comando e devolve o `seq` atribuido.
 *
 * Aqui o escritor e a CLI e o leitor e o supervisor, invertendo os papeis do
 * log de eventos. Mesma estampagem de ordinal, pela mesma razao.
 */
export function appendCommand(root, id, cmd) {
  const seq = nextOrdinal(commandCounters, root, id, 'commands');
  const { seq: _discarded, ts, ...rest } = cmd || {};
  const record = { seq, ts: ts || nowIso(), ...rest };
  try {
    fs.appendFileSync(filePath(root, id, 'commands'), `${JSON.stringify(record)}\n`);
  } catch (err) {
    rollbackOrdinal(commandCounters, root, id, seq);
    throw err;
  }
  return seq;
}

/**
 * Le comandos ainda nao entregues.
 *
 * Tolera linha parcial da mesma forma que `readEvents`: o supervisor e
 * acordado por `fs.watch` e pode chegar no meio de um append da CLI.
 *
 * @returns {object[]}
 */
export function readCommands(root, id, { sinceSeq = 0 } = {}) {
  const from = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
  const lines = readAppendLines(filePath(root, id, 'commands'));
  const out = [];
  lines.forEach((line, index) => {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      return;
    }
    if (!cmd || typeof cmd !== 'object') return;
    const seq = Number.isInteger(cmd.seq) ? cmd.seq : index + 1;
    if (seq > from) out.push({ ...cmd, seq });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Inventario e resolucao de id
// ---------------------------------------------------------------------------

export function listSessionIds(root) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir(root), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Estados de todas as sessoes legiveis.
 *
 * Sessao ilegivel e silenciosamente omitida, inclusive a que ainda nao tem
 * `state.json`. O painel precisa funcionar com uma sessao corrompida no meio;
 * quem quer saber que ela existe usa `listSessionIds`.
 */
export function listStates(root) {
  const out = [];
  for (const id of listSessionIds(root)) {
    try {
      out.push(readState(root, id));
    } catch {
      // Ignora sessao corrompida, por contrato.
    }
  }
  return out;
}

function labelOf(root, id) {
  try {
    const meta = readMeta(root, id);
    if (meta && typeof meta.label === 'string' && meta.label.length > 0) return meta.label;
  } catch {
    // Sem meta legivel, tenta o estado.
  }
  try {
    const state = readState(root, id);
    if (state && typeof state.label === 'string' && state.label.length > 0) return state.label;
  } catch {
    // Sessao sem rotulo utilizavel.
  }
  return null;
}

/**
 * Resolve uma referencia de sessao em id completo.
 *
 * Precedencia decidida aqui, porque o contrato nao ordenava: id exato, depois
 * rotulo exato, depois prefixo unico. Id exato vence de imediato para que
 * `abc` nunca fique ambiguo contra `abcd` — o mesmo motivo pelo qual o git
 * aceita um hash completo sem reclamar dos hashes que o estendem.
 *
 * Rotulo tambem pode ser ambiguo, porque nada impede duas sessoes com o mesmo
 * rotulo. Ambiguo e erro de uso; nada encontrado e erro de sessao.
 *
 * Os ids saem dos nomes de diretorio, nao de `listStates`, para que a busca
 * por id exato continue funcionando numa sessao com estado corrompido.
 */
export function resolveId(root, reference) {
  const ref = typeof reference === 'string' ? reference.trim() : '';
  if (ref.length === 0) {
    throw fail(EXIT.USAGE, 'referencia de sessao vazia. Informe id, prefixo de id ou rotulo.');
  }
  const ids = listSessionIds(root);
  if (ids.length === 0) {
    throw fail(EXIT.NO_SESSION, `nenhuma sessao em ${sessionsDir(root)}`);
  }

  // Ids nascem em minusculas (ver `newId`), entao a comparacao sem caixa e
  // conveniencia para quem digita, e nao afrouxamento de regra.
  const lower = ref.toLowerCase();
  const exact = ids.find((id) => id === ref || id.toLowerCase() === lower);
  if (exact) return exact;

  const byLabel = ids.filter((id) => labelOf(root, id) === ref);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw fail(
      EXIT.USAGE,
      `rotulo ambiguo "${ref}": ${byLabel.join(', ')}. Use o id da sessao.`,
      { matches: byLabel },
    );
  }

  const byPrefix = ids.filter((id) => id.toLowerCase().startsWith(lower));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    throw fail(
      EXIT.USAGE,
      `prefixo ambiguo "${ref}": ${byPrefix.join(', ')}. Use mais caracteres.`,
      { matches: byPrefix },
    );
  }

  throw fail(EXIT.NO_SESSION, `sessao nao encontrada: ${ref}`);
}

// ---------------------------------------------------------------------------
// Processo e remocao
// ---------------------------------------------------------------------------

/**
 * Checagem de vida por sinal 0.
 *
 * EPERM significa que o processo EXISTE e nao e nosso, logo esta vivo. O
 * `try/catch` ingenuo que devolve false em qualquer excecao reportaria
 * supervisor vivo como morto, e o `rm` apagaria o estado debaixo dele.
 */
export function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Remove o diretorio da sessao.
 *
 * Idempotente de proposito: o `rm` da CLI e declarado tolerante, e a decisao
 * de recusar por sessao viva acontece em `bin/ccx.mjs`, que e onde o
 * orquestrador ve o codigo de saida. As retentativas cobrem o handle preso
 * por antivirus ou indexador no Windows.
 */
export function removeSession(root, id) {
  fs.rmSync(sessionDir(root, id), {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
  forgetSession(root, id);
}
