// Digestor do fluxo de eventos do Claude Code.
//
// Esta e a maquina de estados do sistema. Ela recebe um evento cru do fluxo
// JSON por vez e devolve duas coisas: se o estado compacto mudou, e as
// entradas de log que aquele evento gerou. Nada aqui toca disco, porque os
// testes precisam alimentar a maquina evento por evento sem criar sessao, e
// porque o supervisor e o unico lugar do sistema com permissao de I/O.
//
// Consequencia de desenho que vale registrar: o digest e o UNICO dono do
// estado compacto. O supervisor nao mexe em campo de estado por fora, senao o
// proximo `snapshot()` sobrescreveria a mudanca dele. Por isso existem tres
// eventos sinteticos (`SYNTHETIC` abaixo): sao a porta pela qual o supervisor
// conta ao digest coisas que nao vem do fluxo do Claude, como comando
// entregue, processo morto e linha ilegivel.
//
// Regra que manda em tudo: ausencia de sentinela nunca vira `done`. A unica
// atribuicao de STATUS.DONE neste arquivo e a que vem de `classifyTurn`.

import path from 'node:path';

import {
  STATE_SCHEMA,
  STATUS,
  LIMITS,
  COMMAND_KIND,
  shorten,
  classifyTurn,
  inferPhaseFromCommand,
} from './protocol.mjs';

// ---------------------------------------------------------------------------
// Classificacao de eventos
// ---------------------------------------------------------------------------

// Ruido puro: nao gera entrada de log e nao muda estado. Medido em
// 2026-09-11 que `thinking_tokens` sai varias vezes por turno e que
// `rate_limit_event` chega sem relacao com o trabalho pedido. `stream_event`
// entra aqui por precaucao: o supervisor nao pede deltas, mas se uma versao
// futura passar a emitir por padrao, ele nao deve inundar o log.
const NOISE_TYPES = new Set(['rate_limit_event', 'stream_event']);
const NOISE_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'hook_started',
  'hook_response',
]);

// Ferramentas cujo argumento carrega o caminho de um arquivo que foi alterado.
// So estas alimentam `filesTouched`, porque leitura nao e alteracao.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

// Usadas apenas para dar uma fase mais informativa que "rodando" no estado
// compacto. Fase e enfeite de apresentacao: nenhuma decisao depende dela.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch']);

// Conjunto fechado de `kind` de entrada de log, conforme docs/CONTRACT.md.
// Exportado porque o supervisor escolhe o kind do evento sintetico `ccx/note`
// e nao deve poder inventar um valor que a renderizacao nao conhece.
export const EVENT_KINDS = new Set([
  'turn-start',
  'text',
  'tool',
  'tool-result',
  'denial',
  'turn-end',
  'command',
  'error',
  'system',
]);

// Fases possiveis. Conjunto pequeno e documentado de proposito: e string de
// apresentacao, nao chave de decisao.
export const PHASES = {
  BOOTING: 'booting',
  THINKING: 'thinking',
  READING: 'reading',
  EDITING: 'editing',
  RUNNING: 'running',
  VERIFYING: 'verifying',
};

// Eventos que o supervisor injeta. Nao vem do Claude. Sao o unico canal pelo
// qual I/O do supervisor vira mudanca de estado.
export const SYNTHETIC = {
  // Comando do orquestrador: enfileirado, entregue ou descartado.
  COMMAND: 'ccx/command',
  // Processo do Claude terminou, por morte propria ou por pedido de parada.
  EXIT: 'ccx/exit',
  // Entrada de log avulsa: linha ilegivel, aviso de diagnostico, rebaixamento
  // de `answer` para `say`.
  NOTE: 'ccx/note',
};

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normaliza `message.content`, que pode vir como string ou lista de blocos. */
function contentBlocks(message) {
  if (!isObject(message)) return [];
  const { content } = message;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter(isObject);
  return [];
}

/** Junta texto de um `tool_result`, que pode vir string ou lista de blocos. */
function flattenResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (isObject(block) && typeof block.text === 'string') return block.text;
        return '';
      })
      .join(' ');
  }
  if (isObject(content) && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * Extrai o caminho do argumento de uma ferramenta de escrita. Os nomes
 * cobrem as tres ferramentas de WRITE_TOOLS mais variacoes plausiveis, porque
 * errar aqui custa um arquivo faltando na lista, nao uma falha.
 */
function inputPath(input) {
  if (!isObject(input)) return '';
  const raw = input.file_path ?? input.notebook_path ?? input.path ?? input.filePath;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Encurta caminho para leitura humana, relativo ao cwd da sessao quando isso
 * nao esconde informacao. Caminho fora do cwd continua absoluto de proposito:
 * e justamente o caso que o orquestrador precisa notar.
 */
function shortPath(raw, cwd) {
  const text = String(raw ?? '').trim();
  if (!text || !cwd) return text;
  try {
    const rel = path.relative(cwd, text);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  } catch {
    // Caminho invalido para a plataforma: o texto cru informa mais que nada.
  }
  return text;
}

/** Descreve uma ferramenta para a entrada de log, sem despejar argumentos. */
function describeToolInput(name, input, cwd) {
  if (!isObject(input)) return '';
  if (WRITE_TOOLS.has(name)) return shortPath(inputPath(input), cwd);
  if (name === 'Bash') return shorten(input.command, LIMITS.logDetail);
  if (name === 'Read' || name === 'NotebookRead') return shortPath(inputPath(input), cwd);
  if (name === 'Grep' || name === 'Glob') return shorten(input.pattern ?? input.query, LIMITS.logDetail);
  if (name === 'Task') return shorten(input.description ?? input.subagent_type, LIMITS.logDetail);
  if (name === 'TodoWrite') return '';
  // Ferramenta desconhecida, inclusive de MCP: mostra o primeiro campo de
  // texto curto, que quase sempre e o mais informativo.
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) {
      return shorten(value, LIMITS.logDetail);
    }
  }
  return '';
}

/** Monta a amostra de negacao no formato "Write src/x.ts". */
function describeDenial(denial, cwd) {
  if (typeof denial === 'string') return shorten(denial, 80);
  if (!isObject(denial)) return 'desconhecida';
  const name = denial.tool_name ?? denial.name ?? 'ferramenta';
  const detail = describeToolInput(name, denial.tool_input ?? denial.input, cwd);
  return shorten(detail ? `${name} ${detail}` : String(name), 80);
}

/** Arredonda dinheiro para nao acumular sujeira de ponto flutuante. */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// A maquina
// ---------------------------------------------------------------------------

/**
 * Cria o digestor de uma sessao.
 *
 * @param {object} seed Estado inicial, ja com id, label, pid, startedAt.
 *   Campos extra reconhecidos, todos opcionais:
 *   - `cwd`: encurta caminhos de arquivo no log e no estado.
 *   - `now`: funcao que devolve epoch em ms, injetavel para teste.
 * @returns {{
 *   state: object,
 *   apply: (ev: object) => { changed: boolean, entries: object[] },
 *   snapshot: () => object
 * }}
 */
export function createDigest(seed = {}) {
  const { now: injectedNow, cwd: seedCwd, ...rest } = isObject(seed) ? seed : {};
  const now = typeof injectedNow === 'function' ? injectedNow : () => Date.now();
  const cwd = typeof seedCwd === 'string' && seedCwd.length > 0 ? seedCwd : null;
  const startedAt = typeof rest.startedAt === 'string'
    ? rest.startedAt
    : new Date(now()).toISOString();

  const state = {
    schema: STATE_SCHEMA,
    id: rest.id ?? null,
    label: rest.label ?? null,
    cwd,
    status: rest.status ?? STATUS.STARTING,
    phase: rest.phase ?? PHASES.BOOTING,
    pid: rest.pid ?? null,
    alive: rest.alive ?? true,
    turn: rest.turn ?? 0,
    startedAt,
    updatedAt: startedAt,
    claudeSessionId: rest.claudeSessionId ?? null,
    pendingQuestion: rest.pendingQuestion ?? null,
    lastMessage: rest.lastMessage ?? '',
    toolCounts: { ...(isObject(rest.toolCounts) ? rest.toolCounts : {}) },
    filesTouched: Array.isArray(rest.filesTouched) ? [...rest.filesTouched] : [],
    filesTouchedExtra: rest.filesTouchedExtra ?? 0,
    permissionDenials: rest.permissionDenials ?? 0,
    denialSamples: Array.isArray(rest.denialSamples) ? [...rest.denialSamples] : [],
    turnLog: Array.isArray(rest.turnLog) ? [...rest.turnLog] : [],
    totalCostUsd: money(rest.totalCostUsd ?? 0),
    eventCount: rest.eventCount ?? 0,
    cursor: rest.eventCount ?? 0,
    queuedCommands: rest.queuedCommands ?? 0,
    error: rest.error ?? null,
    exitCode: rest.exitCode ?? null,
    // Ultimo `seq` de commands.jsonl ja lido. Vive no estado porque o
    // supervisor reler o canal do zero reentregaria mensagem antiga, e
    // porque a releitura de seguranca ao fim de cada turno depende deste
    // numero para nao duplicar nada.
    lastCommandSeq: rest.lastCommandSeq ?? 0,

    // --- campos agregados, porque `turnLog` corta os turnos antigos ---
    // Sem isto, uma sessao de 40 turnos perderia a conta de quantos foram
    // ambiguos, que e exatamente o numero que o orquestrador precisa ver.
    turnsCompleted: rest.turnsCompleted ?? 0,
    outcomeCounts: {
      done: 0,
      asking: 0,
      blocked: 0,
      ambiguous: 0,
      failed: 0,
      ...(isObject(rest.outcomeCounts) ? rest.outcomeCounts : {}),
    },
    // Desfecho do ultimo turno fechado. Sobrevive a um `stop`, que troca o
    // `status` por `stopped` e sem isto apagaria a informacao de que o
    // trabalho tinha terminado.
    lastOutcome: rest.lastOutcome ?? null,

    // --- valores crus do ultimo `result` ---
    // A duvida sobre acumulo foi RESOLVIDA POR MEDICAO em 2026-09-11, e os
    // dois campos se comportam de formas OPOSTAS:
    //
    // - `total_cost_usd` vem ACUMULADO por sessao. Dois turnos no mesmo
    //   processo leram 0.146507 e depois 0.161494. Nao somamos.
    // - `permission_denials` vem POR TURNO. Num teste com escrita negada, o
    //   primeiro resultado trouxe uma negacao e o segundo veio com a lista
    //   vazia. Se fosse acumulado a negacao teria permanecido. Somamos.
    //
    // Tratar os dois igual, em qualquer direcao, produz numero errado num
    // deles. Por isso os valores crus continuam guardados aqui.
    lastReportedCostUsd: rest.lastReportedCostUsd ?? 0,
    lastReportedDenials: rest.lastReportedDenials ?? 0,
  };

  // --- estado interno, nunca serializado ---

  // Turno aberto? Define se um evento precisa abrir turno novo e se a morte
  // do processo conta como morte sem resultado.
  let inTurn = false;
  let turnStartedAtMs = now();
  // Mapa de id de uso de ferramenta para nome, para que o `tool_result` com
  // erro possa dizer QUAL ferramenta falhou. Limpo a cada turno.
  let toolNamesById = new Map();
  // Conjunto completo de arquivos tocados. `filesTouched` guarda so os
  // primeiros; este Set existe para que `filesTouchedExtra` conte arquivos
  // distintos, e nao escritas repetidas no mesmo arquivo.
  const allFiles = new Set(state.filesTouched);
  let initSeen = state.claudeSessionId !== null;

  function stamp() {
    return new Date(now()).toISOString();
  }

  /**
   * Cria uma entrada de log. Numera aqui porque o estado compacto expoe
   * `cursor`, e `cursor` tem de ser exatamente a contagem de linhas de
   * events.jsonl para servir de `--since` sem ajuste. Como so o supervisor
   * escreve esse arquivo, e ele acrescenta toda entrada devolvida, os dois
   * contadores nao divergem.
   */
  function entry(kind, fields = {}) {
    state.eventCount += 1;
    state.cursor = state.eventCount;
    const kindSafe = EVENT_KINDS.has(kind) ? kind : 'system';
    return { n: state.eventCount, ts: stamp(), kind: kindSafe, ...fields };
  }

  function touch() {
    state.updatedAt = stamp();
  }

  /**
   * Abre um turno se nao houver um aberto. Chamada tanto pela entrega de
   * mensagem quanto pelo primeiro evento do Claude, porque nem sempre a
   * entrega passa por aqui (o primeiro turno vem do meta) e porque o segundo
   * evento de inicializacao do processo, medido em 2026-09-11, e normal e
   * marca justamente o comeco de um turno novo.
   */
  function openTurn(entries) {
    if (inTurn) return false;
    inTurn = true;
    turnStartedAtMs = now();
    toolNamesById = new Map();
    state.turn += 1;
    state.status = STATUS.WORKING;
    state.phase = PHASES.THINKING;
    // Pergunta pendente morre ao comecar turno novo: se o turno comecou, a
    // pergunta ja foi respondida ou abandonada, e deixar o texto la faria o
    // orquestrador responder duas vezes.
    state.pendingQuestion = null;
    entries.push(entry('turn-start', { turn: state.turn }));
    return true;
  }

  function recordFile(rawPath) {
    const shortened = shortPath(rawPath, cwd);
    if (!shortened) return;
    // Conta arquivo DISTINTO. Dez edicoes no mesmo arquivo sao um arquivo
    // tocado, e o excedente tem de contar o que ficou de fora da lista, nao
    // quantas escritas houve.
    if (allFiles.has(shortened)) return;
    allFiles.add(shortened);
    if (state.filesTouched.length < LIMITS.filesTouched) {
      state.filesTouched.push(shortened);
    } else {
      state.filesTouchedExtra += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Handlers por tipo
  // -------------------------------------------------------------------------

  function onSystem(ev, entries) {
    const subtype = ev.subtype ?? null;

    if (subtype === 'init') {
      openTurn(entries);
      if (!initSeen) {
        initSeen = true;
        state.claudeSessionId = typeof ev.session_id === 'string' ? ev.session_id : null;
        const model = ev.model ?? (isObject(ev.data) ? ev.data.model : null);
        entries.push(entry('system', {
          name: 'init',
          detail: shorten(
            [
              state.claudeSessionId ? `sessao ${state.claudeSessionId}` : null,
              model ? `modelo ${model}` : null,
            ].filter(Boolean).join(' '),
            LIMITS.logDetail,
          ),
        }));
      }
      // Init repetido nao gera entrada e, sobretudo, nao troca o
      // `claudeSessionId` nem zera contador nenhum. Medido em 2026-09-11: o
      // mesmo processo emite init no comeco de cada turno com o mesmo id.
      return true;
    }

    if (subtype === 'permission_denied') {
      // Registra com destaque no log, mas NAO conta aqui. A contagem sai do
      // campo `permission_denials` do `result`, que e a fonte unica; contar
      // nos dois lugares dobraria o numero da mesma negacao.
      const name = ev.tool_name ?? ev.tool ?? 'ferramenta';
      entries.push(entry('denial', {
        name: String(name),
        detail: shorten(ev.message ?? ev.reason ?? 'permissao nao concedida', LIMITS.logDetail),
      }));
      return true;
    }

    // Subtipo de sistema desconhecido: vai para o log e nao muda estado, para
    // que uma versao nova do Claude Code nao quebre a leitura.
    entries.push(entry('system', {
      name: subtype ? String(subtype) : 'system',
      detail: '',
    }));
    return true;
  }

  function onAssistant(ev, entries) {
    openTurn(entries);

    for (const block of contentBlocks(ev.message)) {
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.trim().length === 0) continue;
        state.lastMessage = shorten(text, LIMITS.lastMessage);
        entries.push(entry('text', { detail: shorten(text, LIMITS.logDetail) }));
        continue;
      }

      if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
        const input = block.input;
        state.toolCounts[name] = (state.toolCounts[name] ?? 0) + 1;
        if (typeof block.id === 'string') toolNamesById.set(block.id, name);

        if (WRITE_TOOLS.has(name)) {
          recordFile(inputPath(input));
          state.phase = PHASES.EDITING;
        } else if (name === 'Bash') {
          // Distingue "rodando" de "verificando" pelo comando, que e o unico
          // sinal disponivel em modo headless.
          state.phase = inferPhaseFromCommand(isObject(input) ? input.command : '');
        } else if (READ_TOOLS.has(name)) {
          state.phase = PHASES.READING;
        }

        entries.push(entry('tool', {
          name,
          detail: describeToolInput(name, input, cwd),
        }));
        continue;
      }

      // thinking, redacted_thinking e blocos futuros: nem log nem estado.
    }

    // Um evento de assistente que so trouxe raciocinio nao muda nada, e
    // gravar estado por causa dele seria puro desgaste de disco.
    return entries.length > 0;
  }

  function onUser(ev, entries) {
    openTurn(entries);
    let produced = false;

    for (const block of contentBlocks(ev.message)) {
      if (block.type !== 'tool_result') continue;
      // So resultado com erro entra no log. Resultado bem-sucedido de
      // ferramenta e volume puro: o que importa dele ja esta na contagem.
      if (block.is_error !== true) continue;
      const name = toolNamesById.get(block.tool_use_id) ?? 'ferramenta';
      entries.push(entry('tool-result', {
        name: String(name),
        detail: shorten(flattenResultContent(block.content) || 'erro sem texto', LIMITS.logDetail),
      }));
      produced = true;
    }

    return produced;
  }

  function onResult(ev, entries) {
    const text = typeof ev.result === 'string' ? ev.result : '';

    // Turno pode fechar sem nunca ter sido aberto, se o primeiro evento lido
    // do processo for um `result`. Abrir ANTES de classificar, e nao depois,
    // porque `openTurn` poe o status em `working` e apagaria o desfecho.
    if (!inTurn) openTurn(entries);

    // Negacoes primeiro, para que a entrada de negacao apareca no log ANTES
    // do fechamento do turno, na ordem em que os fatos aconteceram.
    const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    state.lastReportedDenials = denials.length;
    if (denials.length > 0) {
      // Somar esta correto: medido que este campo vem POR TURNO, ao
      // contrario do custo. Ver a nota no topo do arquivo.
      state.permissionDenials += denials.length;
      const samples = [];
      for (const denial of denials) {
        const sample = describeDenial(denial, cwd);
        if (!state.denialSamples.includes(sample) && !samples.includes(sample)) {
          samples.push(sample);
        }
      }
      for (const sample of samples) {
        if (state.denialSamples.length >= LIMITS.denialSamples) break;
        state.denialSamples.push(sample);
      }
      // Uma entrada por turno, com o total, em vez de uma por negacao: dez
      // negacoes da mesma ferramenta nao devem empurrar o log inteiro para
      // fora da pagina.
      entries.push(entry('denial', {
        name: 'turno',
        detail: shorten(
          `${denials.length} negacao(oes): ${denials.map((d) => describeDenial(d, cwd)).join(', ')}`,
          LIMITS.logDetail,
        ),
      }));
    }

    // A classificacao e SEMPRE por sentinela. Turno sem marcador e ambiguo,
    // nunca concluido: uma pergunta real lida como tarefa entregue e o pior
    // modo de falha possivel deste sistema.
    const verdict = classifyTurn(text);
    let outcome = verdict.status;

    // `is_error` do proprio fluxo vence a sentinela, porque a spec define
    // resultado com erro como falha e um turno que abortou nao concluiu nada,
    // mesmo que o texto traga um marcador.
    if (ev.is_error === true) {
      outcome = STATUS.FAILED;
      state.error = shorten(text || ev.subtype || 'result com is_error', LIMITS.lastMessage);
    }

    state.status = outcome;
    state.pendingQuestion = verdict.question
      ? shorten(verdict.question, LIMITS.question)
      : null;
    if (text.trim().length > 0) {
      state.lastMessage = shorten(text, LIMITS.lastMessage);
    }

    const cost = money(ev.total_cost_usd);
    state.lastReportedCostUsd = cost;
    // MEDIDO em 2026-09-11, duas mensagens no mesmo processo: o campo chegou
    // 0.146507 no primeiro resultado e 0.161494 no segundo. A diferenca de
    // cerca de 0.015 corresponde a um segundo turno trivial aproveitando
    // cache, nao ao custo cheio de um turno novo. Para comparar, uma sessao
    // isolada de um unico turno equivalente custou 0.148516 sozinha. Logo o
    // campo ja vem ACUMULADO por sessao, e somar multiplicaria o valor a cada
    // turno, reportando gasto que nunca existiu.
    //
    // O maximo protege contra um resultado que chegue com valor menor, o que
    // aconteceria se o campo faltasse e virasse zero: o acumulado nunca cai.
    const previousTotal = state.totalCostUsd;
    state.totalCostUsd = money(Math.max(cost, previousTotal));
    // O custo do turno isolado e a diferenca entre leituras consecutivas, que
    // e a unica forma de te-lo sem que o Claude o reporte separadamente.
    const turnCost = money(Math.max(0, state.totalCostUsd - previousTotal));

    const ms = Number.isFinite(Number(ev.duration_ms))
      ? Number(ev.duration_ms)
      : Math.max(0, now() - turnStartedAtMs);

    state.turnLog.push({ n: state.turn, outcome, ms, costUsd: turnCost });
    while (state.turnLog.length > LIMITS.turnHistory) state.turnLog.shift();
    state.turnsCompleted += 1;
    state.outcomeCounts[outcome] = (state.outcomeCounts[outcome] ?? 0) + 1;
    state.lastOutcome = outcome;
    state.phase = null;
    inTurn = false;

    // Texto integral do turno vai para o log, nao para o estado. E o unico
    // registro duravel por turno que existe: `turns.jsonl` aparece na secao
    // 4.3 da spec mas nao existe em `FILES` do protocol.mjs, que e a fonte de
    // verdade. `ccx result --turn <n>` se resolve procurando a entrada
    // `turn-end` com este `turn`.
    entries.push(entry('turn-end', {
      name: outcome,
      detail: shorten(text, LIMITS.logDetail),
      turn: state.turn,
      text,
      isError: ev.is_error === true,
      stopReason: ev.stop_reason ?? null,
      numTurns: Number.isFinite(Number(ev.num_turns)) ? Number(ev.num_turns) : null,
      // Custo DESTE turno, nao o acumulado da sessao. O acumulado vive em
      // state.totalCostUsd e apareceria inflado aqui.
      costUsd: turnCost,
      ms,
    }));

    return true;
  }

  // -------------------------------------------------------------------------
  // Eventos sinteticos do supervisor
  // -------------------------------------------------------------------------

  function onCommand(ev, entries) {
    const stage = ev.stage === 'delivered' || ev.stage === 'dropped' ? ev.stage : 'queued';
    const kind = typeof ev.kind === 'string' ? ev.kind : COMMAND_KIND.SAY;
    const text = shorten(ev.text ?? '', LIMITS.logDetail);
    const seq = Number.isFinite(Number(ev.seq)) ? Number(ev.seq) : null;

    // O cursor do canal sobe na leitura, em qualquer estagio, para que uma
    // releitura nunca reprocesse o mesmo comando.
    if (seq !== null && seq > state.lastCommandSeq) state.lastCommandSeq = seq;

    if (stage === 'queued') {
      state.queuedCommands += 1;
    } else {
      state.queuedCommands = Math.max(0, state.queuedCommands - 1);
    }

    if (stage === 'delivered' && kind !== COMMAND_KIND.STOP) {
      // Entrega de mensagem abre o turno aqui, e nao quando o Claude
      // responde, para que o orquestrador nunca veja `asking` depois de ja
      // ter respondido. `stop` e a excecao: encerra, nao inicia trabalho.
      openTurn(entries);
    }

    entries.push(entry('command', {
      name: kind,
      detail: shorten([stage, ev.note ?? null, text].filter(Boolean).join(' | '), LIMITS.logDetail),
      seq,
    }));
    return true;
  }

  function onExit(ev, entries) {
    const exitCode = Number.isFinite(Number(ev.exitCode)) ? Number(ev.exitCode) : null;
    state.exitCode = exitCode;
    state.alive = false;
    state.phase = null;
    state.queuedCommands = 0;

    if (ev.reason === 'stopped') {
      // Parada explicita. Sobrescreve o status porque `stopped` e terminal e
      // `rm` depende disso; o desfecho real do trabalho sobrevive em
      // `lastOutcome`.
      state.status = STATUS.STOPPED;
    } else if (ev.fatal === true) {
      // O supervisor declarou falha: spawn recusado, pre-requisito ausente,
      // excecao nao tratada. Sem esta porta, uma sessao que nunca chegou a
      // abrir turno ficaria parada em `starting` com `alive: false`, que nao
      // e estado de coisa nenhuma.
      state.status = STATUS.FAILED;
      state.error = shorten(ev.error ?? ev.stderr ?? 'falha do supervisor', LIMITS.lastMessage);
    } else if (inTurn) {
      // Morreu com turno aberto: e o caso que sem tratamento deixaria a
      // sessao presa em "trabalhando" para sempre.
      state.status = STATUS.FAILED;
      state.error = shorten(
        ev.error
          ?? ev.stderr
          ?? `processo terminou no meio do turno ${state.turn} com codigo ${exitCode}`,
        LIMITS.lastMessage,
      );
    } else if (exitCode !== null && exitCode !== 0) {
      // Turno fechado, mas saida suja: guarda o codigo e o motivo sem apagar
      // o desfecho do ultimo turno, que foi legitimo.
      state.error = shorten(
        ev.error ?? ev.stderr ?? `processo terminou com codigo ${exitCode}`,
        LIMITS.lastMessage,
      );
    }

    inTurn = false;

    entries.push(entry(state.status === STATUS.FAILED ? 'error' : 'system', {
      name: ev.reason === 'stopped' ? 'stopped' : 'exit',
      detail: shorten(
        [
          `codigo ${exitCode === null ? 'nenhum' : exitCode}`,
          ev.signal ? `sinal ${ev.signal}` : null,
          ev.stderr ? shorten(ev.stderr, 120) : null,
        ].filter(Boolean).join(' '),
        LIMITS.logDetail,
      ),
    }));
    return true;
  }

  function onNote(ev, entries) {
    entries.push(entry(EVENT_KINDS.has(ev.kind) ? ev.kind : 'error', {
      name: typeof ev.name === 'string' ? ev.name : null,
      detail: shorten(ev.detail ?? ev.message ?? '', LIMITS.logDetail),
    }));
    // Nota nao muda semantica de estado, mas mexeu no contador de eventos, e
    // o supervisor precisa gravar o `cursor` novo.
    return true;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  function apply(ev) {
    const entries = [];
    if (!isObject(ev) || typeof ev.type !== 'string') {
      return { changed: false, entries };
    }
    if (NOISE_TYPES.has(ev.type)) return { changed: false, entries };
    if (ev.type === 'system' && NOISE_SYSTEM_SUBTYPES.has(ev.subtype)) {
      return { changed: false, entries };
    }

    let changed = false;
    switch (ev.type) {
      case 'system':
        changed = onSystem(ev, entries);
        break;
      case 'assistant':
        changed = onAssistant(ev, entries);
        break;
      case 'user':
        changed = onUser(ev, entries);
        break;
      case 'result':
        changed = onResult(ev, entries);
        break;
      case SYNTHETIC.COMMAND:
        changed = onCommand(ev, entries);
        break;
      case SYNTHETIC.EXIT:
        changed = onExit(ev, entries);
        break;
      case SYNTHETIC.NOTE:
        changed = onNote(ev, entries);
        break;
      default:
        // Tipo desconhecido: vai para o log e nao mexe em estado. Nem abre
        // turno, porque um evento que nao sabemos ler nao e prova de
        // atividade.
        entries.push(entry('system', { name: ev.type, detail: '' }));
        changed = true;
        break;
    }

    if (changed || entries.length > 0) touch();
    return { changed: changed || entries.length > 0, entries };
  }

  /** Copia defensiva para gravacao. O `state` exposto e o objeto vivo. */
  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  return { state, apply, snapshot };
}
