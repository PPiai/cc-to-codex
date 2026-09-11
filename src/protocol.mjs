// Contrato compartilhado do cc-to-codex.
//
// Este modulo e a unica fonte de verdade para nomes de arquivo, estados,
// codigos de saida e o contrato de sentinela. Todo outro modulo importa
// daqui e nunca redefine essas constantes localmente.
//
// Regra de ouro: nada aqui faz I/O. Sao constantes e funcoes puras, para
// que os testes possam exercitar a classificacao de turno sem tocar disco.

export const VERSION = '0.1.0';

// Versao do formato dos arquivos de estado. Se um supervisor antigo deixou
// estado em disco com schema diferente, a CLI recusa em vez de interpretar
// campos que podem ter mudado de significado.
export const STATE_SCHEMA = 1;

// ---------------------------------------------------------------------------
// Arquivos de estado, dentro de <root>/sessions/<id>/
// ---------------------------------------------------------------------------

export const FILES = {
  // Escrito uma vez pelo dispatch, lido pelo supervisor ao nascer.
  meta: 'meta.json',
  // Reescrito de forma atomica pelo supervisor a cada mudanca relevante.
  state: 'state.json',
  // Append-only, linhas digeridas e compactas. E o que `ccx log` serve.
  events: 'events.jsonl',
  // Append-only, eventos crus do fluxo. So existe com --raw no dispatch.
  raw: 'raw.jsonl',
  // Append-only. A CLI escreve, o supervisor observa com fs.watch.
  commands: 'commands.jsonl',
  // Erros do proprio supervisor, incluindo stderr do Claude.
  supervisorLog: 'supervisor.log',
  // Configuracoes passadas ao Claude. Vai em arquivo, nunca embutido na
  // linha de comando, porque o limite de comprimento de argumento no
  // Windows morde exatamente nesse tipo de payload.
  settings: 'settings.json',
};

export const SESSIONS_DIRNAME = 'sessions';

// ---------------------------------------------------------------------------
// Codigos de saida
// ---------------------------------------------------------------------------

export const EXIT = {
  OK: 0,
  USAGE: 1,
  NO_SESSION: 2,
  BAD_STATE: 3,
  NO_WRITABLE_ROOT: 4,
  MISSING_PREREQ: 5,
  TIMEOUT: 6,
};

// ---------------------------------------------------------------------------
// Estados de sessao
// ---------------------------------------------------------------------------

export const STATUS = {
  // Supervisor nasceu, Claude ainda nao respondeu o primeiro evento.
  STARTING: 'starting',
  // Turno em andamento.
  WORKING: 'working',
  // Turno terminou pedindo decisao do orquestrador. Aceita `answer`.
  ASKING: 'asking',
  // Turno terminou sem sentinela nenhuma. NUNCA tratar como concluido.
  AMBIGUOUS: 'ambiguous',
  // Turno terminou declarando bloqueio.
  BLOCKED: 'blocked',
  // Turno terminou declarando conclusao.
  DONE: 'done',
  // Processo morreu sem entregar resultado, ou erro irrecuperavel.
  FAILED: 'failed',
  // Encerrado por pedido explicito.
  STOPPED: 'stopped',
};

// Estados em que o supervisor ainda deve estar vivo segurando o processo.
// Usado por `rm` para recusar remocao sob um supervisor ativo.
export const LIVE_STATUSES = new Set([
  STATUS.STARTING,
  STATUS.WORKING,
  STATUS.ASKING,
  STATUS.AMBIGUOUS,
  STATUS.BLOCKED,
  STATUS.DONE,
]);

// Estados em que o trabalho esta em curso de fato. `status --wait` espera
// sair deste conjunto.
export const BUSY_STATUSES = new Set([STATUS.STARTING, STATUS.WORKING]);

// Estados terminais: o supervisor ja saiu.
export const TERMINAL_STATUSES = new Set([
  STATUS.FAILED,
  STATUS.STOPPED,
]);

// ---------------------------------------------------------------------------
// Contrato de sentinela
// ---------------------------------------------------------------------------
//
// Em modo headless nao existe ferramenta de pergunta ao usuario. Medido em
// 2026-09-11: quando instruido a perguntar, o Claude pergunta em prosa
// dentro do resultado final. Detectar isso por heuristica de texto seria
// frustrante e erraria nos dois sentidos, entao o despacho impoe marcadores
// explicitos e o supervisor classifica pelo marcador, nunca pelo teor.

export const SENTINELS = {
  ASK: '@@ASK:',
  DONE: '@@DONE:',
  BLOCKED: '@@BLOCKED:',
};

// Anexado ao prompt de sistema da sessao despachada. Em ingles de proposito:
// e instrucao de formato dirigida ao modelo, e a adesao a formato e mais
// firme em ingles. A explicacao para humanos fica no README.
export const SYSTEM_CONTRACT = `## Reporting contract (mandatory)

You are running as a dispatched subagent. A machine orchestrator reads your
final message of every turn. It cannot see your thinking, your tool calls, or
any prose you write mid-turn. It only parses the markers below.

End EVERY turn with exactly one of these markers as the LAST line of your
final message:

- \`${SENTINELS.DONE} <one to three line summary of what you actually changed or found>\`
  Use when the task is finished and verified.

- \`${SENTINELS.ASK} <a single, specific question>\`
  Use when you need a decision only the orchestrator can make: an ambiguous
  requirement, a choice between two valid designs, a missing credential, or a
  scope question. Ask ONE question. Then stop and wait. Do not guess.

- \`${SENTINELS.BLOCKED} <what blocks you and what you already tried>\`
  Use when you cannot proceed for a reason the orchestrator cannot answer:
  a failing dependency, a missing file, a permission you do not have.

Rules:
- Never ask a question in plain prose. An unmarked question is invisible to
  the orchestrator and will stall the task.
- Never emit more than one marker per turn.
- The marker must be the last line. Put nothing after it.
- Prefer ${SENTINELS.DONE} with a partial result over ${SENTINELS.BLOCKED} when you
  completed part of the work. Say plainly what you left undone.`;

/**
 * Procura uma sentinela num texto de turno.
 *
 * Le de baixo para cima, porque o contrato exige o marcador na ultima linha
 * e um marcador citado no meio da explicacao nao deve vencer o real.
 *
 * @param {string} text Texto final do turno.
 * @returns {{kind:'ask'|'done'|'blocked', payload:string}|null}
 */
export function parseSentinel(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    // Tolera negrito de markdown ao redor do marcador, que o modelo as vezes
    // adiciona sozinho, sem afrouxar para deteccao por teor.
    const bare = line.replace(/^\*+/, '').replace(/\*+$/, '').trim();

    for (const [kind, marker] of [
      ['ask', SENTINELS.ASK],
      ['done', SENTINELS.DONE],
      ['blocked', SENTINELS.BLOCKED],
    ]) {
      if (bare.startsWith(marker)) {
        return { kind, payload: bare.slice(marker.length).trim() };
      }
    }
  }
  return null;
}

/**
 * Classifica o desfecho de um turno a partir do texto final.
 *
 * Ausencia de sentinela NUNCA vira conclusao. Vira ambiguo, que e um estado
 * visivel e acionavel, porque uma pergunta real transformada em tarefa
 * concluida e o pior erro possivel deste sistema.
 *
 * @param {string} text
 * @returns {{status:string, question:string|null, summary:string|null, reason:string|null}}
 */
export function classifyTurn(text) {
  const found = parseSentinel(text);
  if (!found) {
    return { status: STATUS.AMBIGUOUS, question: null, summary: null, reason: null };
  }
  if (found.kind === 'ask') {
    return { status: STATUS.ASKING, question: found.payload, summary: null, reason: null };
  }
  if (found.kind === 'blocked') {
    return { status: STATUS.BLOCKED, question: null, summary: null, reason: found.payload };
  }
  return { status: STATUS.DONE, question: null, summary: found.payload, reason: null };
}

// ---------------------------------------------------------------------------
// Canal de comandos
// ---------------------------------------------------------------------------

export const COMMAND_KIND = {
  SAY: 'say',
  ANSWER: 'answer',
  STOP: 'stop',
};

// ---------------------------------------------------------------------------
// Limites de apresentacao
// ---------------------------------------------------------------------------
//
// O objetivo declarado e o status caber em cerca de 15 linhas para qualquer
// tarefa, por longa que seja. Estes limites existem para garantir isso por
// construcao, e nao por sorte.

export const LIMITS = {
  // Truncamento da ultima frase do assistente no estado compacto.
  lastMessage: 240,
  // Pergunta pendente pode ser mais longa: e o que o orquestrador responde.
  question: 600,
  // Arquivos tocados listados no estado. O excedente vira contador.
  filesTouched: 20,
  // Amostras de negacao de permissao guardadas.
  denialSamples: 5,
  // Turnos detalhados guardados no estado. Os antigos viram agregado.
  turnHistory: 10,
  // Entradas devolvidas por `ccx log` sem --limit.
  logPage: 50,
  // Detalhe de uma entrada de log.
  logDetail: 160,
};

/**
 * Encurta preservando palavra inteira quando possivel.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function shorten(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base}...`;
}

/**
 * Id curto de sessao. Precisa ser digitavel pelo orquestrador e legivel num
 * painel, entao nao usamos UUID. Colisao e tratada por quem cria o diretorio.
 * @param {() => number} [rand] Injetavel para teste.
 * @returns {string}
 */
export function newId(rand = Math.random) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return out;
}

/**
 * Fases inferidas do comando executado, para o estado compacto dizer algo
 * mais util que "rodando". Espelha a ideia do plugin oficial do Codex.
 * @param {string} command
 * @returns {'verifying'|'running'}
 */
export function inferPhaseFromCommand(command) {
  const verify = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;
  return verify.test(String(command ?? '')) ? 'verifying' : 'running';
}
