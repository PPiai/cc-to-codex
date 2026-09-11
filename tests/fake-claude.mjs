#!/usr/bin/env node
// Claude falso para os testes do cc-to-codex.
//
// Por que existe: rodar o binario real do Claude Code em teste consome cota
// paga e nao e reproduzivel. Este arquivo fala o mesmo fluxo de eventos do
// `claude -p --input-format stream-json --output-format stream-json --verbose`,
// com comportamentos selecionaveis, e nunca contata a rede.
//
// Duas maneiras de usar:
//
//   1. Como executavel, no lugar do binario real. `installFakeClaude` grava
//      os wrappers de plataforma e `buildEnv` monta o ambiente que aponta
//      `CCX_CLAUDE_BIN` para eles.
//   2. Como biblioteca pura. `sessionScript` devolve os eventos como objetos,
//      sem I/O nenhum, para alimentar `createDigest` evento por evento.
//
// ---------------------------------------------------------------------------
// FORMAS DE EVENTO FIXADAS AQUI
// ---------------------------------------------------------------------------
// Estas formas foram medidas na versao 2.1.268 nesta maquina em 2026-09-11.
// Quem consome o fluxo (o digest, o supervisor) deve programar contra elas.
// Se mudarem, mudam aqui primeiro.
//
//   system/init
//     { type:'system', subtype:'init', session_id, cwd, tools:[...],
//       mcp_servers:[], model, permissionMode, slash_commands:[],
//       apiKeySource, output_style, agents:[], skills:[], uuid }
//
//   system/hook_started
//     { type:'system', subtype:'hook_started', hook_event_name, session_id, uuid }
//
//   system/hook_response
//     { type:'system', subtype:'hook_response', hook_event_name, exit_code,
//       stdout, stderr, session_id, uuid }
//
//   system/thinking_tokens
//     { type:'system', subtype:'thinking_tokens', thinking_tokens, session_id, uuid }
//
//   system/permission_denied
//     { type:'system', subtype:'permission_denied', tool_name, tool_use_id,
//       tool_input, session_id, uuid }
//
//   rate_limit_event
//     { type:'rate_limit_event', rate_limit:{...}, session_id, uuid }
//
//   assistant  (message.content SEMPRE array de blocos)
//     bloco de texto:      { type:'text', text }
//     bloco de ferramenta: { type:'tool_use', id, name, input }
//     { type:'assistant', message:{ id, type:'message', role:'assistant',
//       model, content:[...], stop_reason, stop_sequence, usage },
//       parent_tool_use_id, session_id, uuid }
//
//   user  (devolucao de resultado de ferramenta)
//     bloco: { type:'tool_result', tool_use_id, content, is_error }
//     { type:'user', message:{ role:'user', content:[...] },
//       parent_tool_use_id, session_id, uuid }
//
//   result  (fecha o turno)
//     { type:'result', subtype, is_error, duration_ms, duration_api_ms,
//       num_turns, result, session_id, total_cost_usd, usage,
//       permission_denials:[...], stop_reason, uuid }
//
//   entrada de permission_denials
//     { tool_name, tool_use_id, tool_input }
//     O estado compacto monta a amostra "Write src/x.ts" a partir DESTES
//     campos. tool_input traz o caminho em `file_path` para Write e Edit, e
//     em `notebook_path` para NotebookEdit.
//
// O campo `total_cost_usd` do evento de resultado e ACUMULADO da sessao, nao
// o custo do turno. Foi assim que a sondagem mediu: turno 1 em 0.1465 e turno
// 2 em 0.1615 no mesmo processo. O fake reproduz isso.
//
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FAKE_PATH = fileURLToPath(import.meta.url);

// Identificador de sessao fixo de proposito: teste deterministico e mais
// facil de depurar que teste com uuid sorteado. Pode ser trocado pelo
// ambiente quando um teste precisar de duas sessoes distinguiveis.
export const FAKE_SESSION_ID = '0744770c-7f3a-4c1b-9d2e-5a6b7c8d9e0f';

export const FAKE_VERSION = '2.1.268 (Claude Code)';

export const FAKE_MODEL = 'claude-opus-4-5-20260101';

const DEFAULT_TOOLS = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
  'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch',
];

// Texto de ajuda com exatamente as flags que o supervisor usa. O `doctor`
// confere as flags do codigo contra a ajuda local, e este texto e o alvo
// desse teste. As tres flags inexistentes da secao 3.2 da spec
// (--allow-tools, --max-turns, --max-cost-usd) NAO aparecem aqui.
const FAKE_HELP = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default

Options:
  -p, --print                      Print response and exit
  --input-format <format>          Input format (text, stream-json)
  --output-format <format>         Output format (text, json, stream-json)
  --verbose                        Override verbose mode setting
  --model <model>                  Model for the current session
  --tools <tools>                  Comma-separated list of allowed built-in tools
  --settings <file-or-json>        Path to a settings JSON file or a JSON string
  --strict-mcp-config              Only use MCP servers from --mcp-config
  --permission-mode <mode>         Permission mode (choices: "acceptEdits",
                                   "auto", "bypassPermissions", "manual",
                                   "dontAsk", "plan")
  --permission-prompts <mode>      Permission prompt handling (choices: "host",
                                   "none", default: "host")
  --append-system-prompt <prompt>  Append a system prompt to the default one
  --include-partial-messages       Include partial message chunks
  -v, --version                    Output the version number
  -h, --help                       Display help for command`;

// ---------------------------------------------------------------------------
// Contexto de emissao
// ---------------------------------------------------------------------------

/**
 * Cria o contexto que numera uuids e mantem o identificador de sessao.
 * Determinismo importa: os testes comparam eventos.
 */
function createContext({ sessionId = FAKE_SESSION_ID, cwd = process.cwd(), permissionMode = 'bypassPermissions', model = FAKE_MODEL, tools = DEFAULT_TOOLS } = {}) {
  return {
    sessionId,
    cwd,
    permissionMode,
    model,
    tools,
    seq: 0,
    toolSeq: 0,
    turn: 0,
    costUsd: 0,
  };
}

function nextUuid(ctx) {
  ctx.seq += 1;
  const n = String(ctx.seq).padStart(12, '0');
  return `ev000000-0000-4000-8000-${n}`;
}

function nextToolId(ctx) {
  ctx.toolSeq += 1;
  return `toolu_${String(ctx.toolSeq).padStart(6, '0')}`;
}

function envelope(ctx, extra) {
  return { session_id: ctx.sessionId, uuid: nextUuid(ctx), ...extra };
}

// ---------------------------------------------------------------------------
// Construtores de evento
// ---------------------------------------------------------------------------

function hookPair(ctx, hookEventName) {
  return [
    envelope(ctx, { type: 'system', subtype: 'hook_started', hook_event_name: hookEventName }),
    envelope(ctx, { type: 'system', subtype: 'hook_response', hook_event_name: hookEventName, exit_code: 0, stdout: '', stderr: '' }),
  ];
}

function initEvent(ctx) {
  return envelope(ctx, {
    type: 'system',
    subtype: 'init',
    cwd: ctx.cwd,
    tools: ctx.tools,
    mcp_servers: [],
    model: ctx.model,
    permissionMode: ctx.permissionMode,
    slash_commands: [],
    apiKeySource: 'none',
    output_style: 'default',
    agents: [],
    skills: [],
  });
}

function thinkingEvent(ctx, tokens = 2048) {
  return envelope(ctx, { type: 'system', subtype: 'thinking_tokens', thinking_tokens: tokens });
}

function rateLimitEvent(ctx) {
  return envelope(ctx, {
    type: 'rate_limit_event',
    rate_limit: {
      status: 'allowed',
      unified_rate_limit_fallback_available: false,
      resets_at: 1757620800,
    },
  });
}

function assistantEvent(ctx, content) {
  return envelope(ctx, {
    type: 'assistant',
    message: {
      id: `msg_${String(ctx.seq).padStart(6, '0')}`,
      type: 'message',
      role: 'assistant',
      model: ctx.model,
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, cache_read_input_tokens: 14200, output_tokens: 96 },
    },
    parent_tool_use_id: null,
  });
}

function textEvent(ctx, text) {
  return assistantEvent(ctx, [{ type: 'text', text }]);
}

function toolUseEvent(ctx, name, input, toolUseId) {
  return assistantEvent(ctx, [{ type: 'tool_use', id: toolUseId, name, input }]);
}

function toolResultEvent(ctx, toolUseId, content, isError = false) {
  return envelope(ctx, {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
  });
}

function permissionDeniedEvent(ctx, denial) {
  return envelope(ctx, {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: denial.tool_name,
    tool_use_id: denial.tool_use_id,
    tool_input: denial.tool_input,
  });
}

function resultEvent(ctx, { result, isError = false, subtype = 'success', denials = [], stopReason = 'end_turn', turnCost = 0.1465, durationMs = 8421 }) {
  ctx.costUsd = Number((ctx.costUsd + turnCost).toFixed(6));
  return envelope(ctx, {
    type: 'result',
    subtype,
    is_error: isError,
    duration_ms: durationMs,
    duration_api_ms: Math.max(0, durationMs - 500),
    num_turns: ctx.turn,
    result,
    total_cost_usd: ctx.costUsd,
    usage: { input_tokens: 12, cache_creation_input_tokens: 14200, output_tokens: 480 },
    permission_denials: denials,
    stop_reason: stopReason,
  });
}

/**
 * Emite um par de uso e resultado de ferramenta, ja com o hook em volta.
 * Devolve os eventos e o identificador da chamada.
 */
function toolCall(ctx, name, input, { content = 'ok', isError = false, withHook = false } = {}) {
  const id = nextToolId(ctx);
  const out = [];
  if (withHook) out.push(...hookPair(ctx, 'PreToolUse'));
  out.push(toolUseEvent(ctx, name, input, id));
  out.push(toolResultEvent(ctx, id, content, isError));
  return { events: out, id };
}

/**
 * Trabalho tipico de um turno: alguma leitura, uma busca, uma edicao e uma
 * verificacao, com ruido intercalado. Existe para o digest ter o que agregar.
 */
function typicalWork(ctx) {
  const out = [];
  out.push(thinkingEvent(ctx));
  out.push(textEvent(ctx, 'Vou comecar mapeando os pontos de entrada da autenticacao.'));
  out.push(...toolCall(ctx, 'Read', { file_path: 'src/auth/session.ts' }, { content: 'export function session() {}' }).events);
  out.push(...toolCall(ctx, 'Read', { file_path: 'src/auth/token.ts' }, { content: 'export function token() {}' }).events);
  out.push(rateLimitEvent(ctx));
  out.push(...toolCall(ctx, 'Grep', { pattern: 'token', path: 'src' }, { content: '3 matches' }).events);
  out.push(thinkingEvent(ctx, 1024));
  out.push(textEvent(ctx, 'Encontrei os tres pontos de entrada. Aplicando a mudanca.'));
  out.push(...toolCall(ctx, 'Edit', { file_path: 'src/auth/session.ts' }, { withHook: true }).events);
  out.push(...toolCall(ctx, 'Write', { file_path: 'src/auth/rotate.ts' }, {}).events);
  out.push(...toolCall(ctx, 'NotebookEdit', { notebook_path: 'docs/analise.ipynb' }, {}).events);
  out.push(...toolCall(ctx, 'Bash', { command: 'npm test -- auth' }, { content: '12 passing' }).events);
  return out;
}

// ---------------------------------------------------------------------------
// Comportamentos
// ---------------------------------------------------------------------------
//
// Cada comportamento e uma funcao (ctx, turnIndex, prompt) que devolve o
// array de eventos do turno. Marcadores de controle aceitos no array:
//
//   { __raw: 'texto' }  linha escrita literalmente, sem passar por JSON
//   { __delay: ms }     pausa antes de continuar a emitir
//   { __exit: codigo }  encerra o processo na hora, sem emitir mais nada
//
// Consumidores puros descartam os marcadores de controle.

export const BEHAVIORS = {
  'done': {
    describe: 'turno unico que fecha com o marcador de conclusao',
    turn(ctx) {
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        ...typicalWork(ctx),
        textEvent(ctx, 'Pronto.\n\n@@DONE: Rotacao de token extraida para src/auth/rotate.ts e coberta por teste.'),
        resultEvent(ctx, {
          result: 'Pronto.\n\n@@DONE: Rotacao de token extraida para src/auth/rotate.ts e coberta por teste.',
        }),
      ];
    },
  },

  'ask-then-done': {
    describe: 'turno 1 fecha com pergunta, turno 2 responde e fecha com conclusao',
    turn(ctx, turnIndex, prompt) {
      if (turnIndex === 0) {
        const text = 'Mapeei os tres pontos de entrada.\n\n@@ASK: Devo manter compatibilidade com o token v1?';
        return [
          ...hookPair(ctx, 'SessionStart'),
          initEvent(ctx),
          ...typicalWork(ctx),
          textEvent(ctx, text),
          resultEvent(ctx, { result: text }),
        ];
      }
      const text = `Segui a sua decisao: ${String(prompt).slice(0, 60)}\n\n@@DONE: Compatibilidade tratada conforme a resposta do orquestrador.`;
      return [
        initEvent(ctx),
        thinkingEvent(ctx),
        ...toolCall(ctx, 'Edit', { file_path: 'src/auth/compat.ts' }, {}).events,
        textEvent(ctx, text),
        resultEvent(ctx, { result: text, turnCost: 0.015, durationMs: 4210 }),
      ];
    },
  },

  'blocked': {
    describe: 'turno que fecha com o marcador de bloqueio',
    turn(ctx) {
      const text = 'Tentei rodar a suite e ela nao sobe.\n\n@@BLOCKED: Falta a variavel DATABASE_URL. Tentei ler .env e .env.example, nenhum dos dois existe.';
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        thinkingEvent(ctx),
        ...toolCall(ctx, 'Read', { file_path: '.env' }, { content: 'ENOENT', isError: true }).events,
        ...toolCall(ctx, 'Bash', { command: 'npm test' }, { content: 'cannot connect', isError: true }).events,
        textEvent(ctx, text),
        resultEvent(ctx, { result: text, turnCost: 0.0312 }),
      ];
    },
  },

  'no-marker': {
    describe: 'turno que termina SEM nenhum marcador, com a pergunta em prosa. Deve virar ambiguo, nunca concluido',
    turn(ctx) {
      // Este e o caso mais importante do conjunto. O texto abaixo e o
      // comportamento real medido: sem ferramenta de pergunta em headless, o
      // Claude pergunta em prosa e o turno fecha com sucesso normal.
      const text = 'Terminei de mapear os tres pontos de entrada. Antes de mexer, preciso saber: devo manter compatibilidade com o token v1? Isso muda bastante o desenho.';
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        ...typicalWork(ctx),
        textEvent(ctx, text),
        resultEvent(ctx, { result: text, turnCost: 0.0884 }),
      ];
    },
  },

  'denials': {
    describe: 'turno com negacoes de permissao: resultado de ferramenta com erro e lista preenchida no resultado final',
    turn(ctx) {
      const out = [...hookPair(ctx, 'SessionStart'), initEvent(ctx)];
      const denials = [];
      const alvos = [
        { tool_name: 'Write', tool_input: { file_path: 'C:\\fora\\do\\escopo\\x.ts' } },
        { tool_name: 'Edit', tool_input: { file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' } },
        { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'C:\\outro\\repo\\nb.ipynb' } },
      ];
      for (const alvo of alvos) {
        const id = nextToolId(ctx);
        const denial = { tool_name: alvo.tool_name, tool_use_id: id, tool_input: alvo.tool_input };
        denials.push(denial);
        out.push(...hookPair(ctx, 'PreToolUse'));
        out.push(toolUseEvent(ctx, alvo.tool_name, alvo.tool_input, id));
        out.push(permissionDeniedEvent(ctx, denial));
        out.push(toolResultEvent(ctx, id, 'Permissao negada pela cerca de diretorio do cc-to-codex.', true));
      }
      out.push(...toolCall(ctx, 'Write', { file_path: 'src/dentro.ts' }, {}).events);
      const text = 'Escrevi o que estava no escopo.\n\n@@DONE: Arquivo dentro do escopo criado. Tres gravacoes fora do diretorio foram negadas.';
      out.push(textEvent(ctx, text));
      out.push(resultEvent(ctx, { result: text, denials, turnCost: 0.0721 }));
      return out;
    },
  },

  'crash': {
    describe: 'processo morre no meio do turno, sem emitir resultado',
    turn(ctx) {
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        thinkingEvent(ctx),
        textEvent(ctx, 'Comecando a investigacao do bug de sessao.'),
        ...toolCall(ctx, 'Read', { file_path: 'src/auth/session.ts' }, {}).events,
        { __raw: 'FATAL: heap out of memory' },
        { __exit: 134 },
      ];
    },
  },

  'slow': {
    describe: 'turno lento, para exercitar espera com prazo e interrupcao',
    turn(ctx) {
      const delay = Number(process.env.CCX_FAKE_DELAY_MS || 5000);
      const text = 'Levou, mas saiu.\n\n@@DONE: Refatoracao lenta concluida.';
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        textEvent(ctx, 'Isso vai demorar, a suite e grande.'),
        ...toolCall(ctx, 'Bash', { command: 'npm test' }, { content: 'rodando' }).events,
        { __delay: delay },
        textEvent(ctx, text),
        resultEvent(ctx, { result: text, durationMs: delay + 200 }),
      ];
    },
  },

  'multi-turn': {
    describe: 'varios turnos no mesmo processo, com novo init por turno e o mesmo identificador de sessao',
    turn(ctx, turnIndex, prompt) {
      const out = [];
      if (turnIndex === 0) out.push(...hookPair(ctx, 'SessionStart'));
      // Um novo init a cada turno foi medido em 2026-09-11, com o mesmo
      // session_id. Nao deve ser lido como sessao nova.
      out.push(initEvent(ctx));
      out.push(thinkingEvent(ctx));
      out.push(...toolCall(ctx, 'Read', { file_path: `src/parte-${turnIndex + 1}.ts` }, {}).events);
      out.push(...toolCall(ctx, 'Edit', { file_path: `src/parte-${turnIndex + 1}.ts` }, {}).events);
      const text = `Turno ${turnIndex + 1} recebeu: ${String(prompt).slice(0, 80)}\n\n@@DONE: Parte ${turnIndex + 1} concluida.`;
      out.push(textEvent(ctx, text));
      out.push(resultEvent(ctx, { result: text, turnCost: turnIndex === 0 ? 0.1465 : 0.015 }));
      return out;
    },
  },

  'bad-json': {
    describe: 'linha nao JSON no meio da saida, para exercitar a robustez do parser',
    turn(ctx) {
      const text = 'Apesar do lixo na saida.\n\n@@DONE: Parser sobreviveu a linha invalida.';
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        { __raw: 'nao sou json, sou aviso de terminal' },
        thinkingEvent(ctx),
        { __raw: '{"type":"assistant","message":{ truncado' },
        ...toolCall(ctx, 'Read', { file_path: 'src/a.ts' }, {}).events,
        { __raw: '' },
        textEvent(ctx, text),
        resultEvent(ctx, { result: text }),
      ];
    },
  },

  'unknown-event': {
    describe: 'evento de tipo desconhecido, para compatibilidade para frente',
    turn(ctx) {
      const text = 'Ignorou o que nao conhece.\n\n@@DONE: Evento desconhecido nao quebrou nada.';
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        envelope(ctx, { type: 'quantum_flux_event', payload: { intensidade: 7 } }),
        envelope(ctx, { type: 'system', subtype: 'subtipo_do_futuro', campo_novo: true }),
        envelope(ctx, { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'par' } } }),
        ...toolCall(ctx, 'Read', { file_path: 'src/a.ts' }, {}).events,
        textEvent(ctx, text),
        resultEvent(ctx, { result: text }),
      ];
    },
  },

  'many-files': {
    describe: 'saida muito longa e muitos arquivos tocados, para exercitar truncamento e excedente',
    turn(ctx) {
      const out = [...hookPair(ctx, 'SessionStart'), initEvent(ctx)];
      for (let i = 1; i <= 25; i += 1) {
        out.push(...toolCall(ctx, 'Write', { file_path: `src/gerado/modulo-${String(i).padStart(2, '0')}.ts` }, {}).events);
      }
      for (let i = 0; i < 40; i += 1) {
        out.push(textEvent(ctx, `Passo ${i + 1} de uma explicacao deliberadamente longa. ${'detalhe '.repeat(30)}`));
      }
      const text = `${'Resumo muito longo que precisa ser truncado no estado compacto. '.repeat(20)}\n\n@@DONE: Vinte e cinco modulos gerados.`;
      out.push(textEvent(ctx, text));
      out.push(resultEvent(ctx, { result: text, turnCost: 0.4812 }));
      return out;
    },
  },

  'error-result': {
    describe: 'resultado marcado com erro, sem marcador nenhum',
    turn(ctx) {
      const text = 'Execution failed after 2 turns';
      return [
        ...hookPair(ctx, 'SessionStart'),
        initEvent(ctx),
        ...toolCall(ctx, 'Bash', { command: 'npm run build' }, { content: 'exit 1', isError: true }).events,
        resultEvent(ctx, {
          result: text,
          isError: true,
          subtype: 'error_during_execution',
          stopReason: 'error',
          turnCost: 0.021,
        }),
      ];
    },
  },
};

export const DEFAULT_BEHAVIOR = 'done';

/**
 * Resolve o nome do comportamento a partir de argumento e ambiente.
 * Argumento explicito ganha do ambiente.
 * @param {string[]} argv
 * @param {Record<string,string|undefined>} env
 * @returns {{ behavior: string, argv: string[] }}
 */
export function selectBehavior(argv = [], env = {}) {
  const rest = [];
  let fromArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token === 'string' && token.startsWith('--fake-behavior=')) {
      fromArg = token.slice('--fake-behavior='.length);
      continue;
    }
    if (token === '--fake-behavior') {
      fromArg = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    rest.push(token);
  }
  const name = fromArg || env.CCX_FAKE_BEHAVIOR || DEFAULT_BEHAVIOR;
  if (!Object.hasOwn(BEHAVIORS, name)) {
    throw new Error(`comportamento desconhecido do Claude falso: ${name}. Conhecidos: ${Object.keys(BEHAVIORS).join(', ')}`);
  }
  return { behavior: name, argv: rest };
}

// ---------------------------------------------------------------------------
// Uso como biblioteca pura, sem I/O
// ---------------------------------------------------------------------------

/**
 * Gera os eventos de um turno como objetos, sem tocar em disco nem em stdout.
 * @param {string} behavior
 * @param {number} turnIndex Base zero.
 * @param {string} prompt
 * @param {object} ctx Contexto reaproveitado entre turnos da mesma sessao.
 * @returns {object[]} Inclui marcadores de controle.
 */
export function turnScript(behavior, turnIndex, prompt, ctx) {
  const spec = BEHAVIORS[behavior];
  if (!spec) throw new Error(`comportamento desconhecido: ${behavior}`);
  ctx.turn = turnIndex + 1;
  return spec.turn(ctx, turnIndex, prompt);
}

/**
 * Gera os eventos de uma sessao inteira, um turno por prompt.
 *
 * Por padrao remove os marcadores de controle, entregando apenas eventos que
 * o parser do supervisor veria depois de enquadrar as linhas.
 *
 * @param {object} options
 * @param {string} options.behavior
 * @param {string[]} [options.prompts]
 * @param {boolean} [options.includeControl] Mantem __raw, __delay e __exit.
 * @param {object} [options.context] Opcoes de createContext.
 * @returns {{ events: object[], turns: object[][], context: object }}
 */
export function sessionScript({ behavior, prompts = ['tarefa'], includeControl = false, context = {} } = {}) {
  const ctx = createContext(context);
  const turns = [];
  for (let i = 0; i < prompts.length; i += 1) {
    const raw = turnScript(behavior, i, prompts[i], ctx);
    turns.push(includeControl ? raw : raw.filter((ev) => !isControl(ev)));
    // Um comportamento que mata o processo nao produz turnos seguintes.
    if (raw.some((ev) => ev && typeof ev.__exit === 'number')) break;
  }
  return { events: turns.flat(), turns, context: ctx };
}

/** True para marcador de controle, que nao e evento do fluxo. */
export function isControl(ev) {
  return Boolean(ev) && (typeof ev.__raw === 'string' || typeof ev.__delay === 'number' || typeof ev.__exit === 'number');
}

// ---------------------------------------------------------------------------
// Uso como executavel
// ---------------------------------------------------------------------------

function loadFakeState(statePath) {
  if (!statePath) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { spawns: 0, sessions: [], turns: [], argv: [] };
  }
}

function saveFakeState(statePath, state) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

/** Le o estado persistido do Claude falso. Devolve null se nunca rodou. */
export function readFakeState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

/**
 * Registra um spawn do fixture. Chamado no comeco de `main`, antes de
 * qualquer atalho, para que a existencia do arquivo seja prova de execucao.
 */
function recordSpawn(statePath, { behavior, argv }) {
  if (!statePath) return;
  const state = loadFakeState(statePath) || { spawns: 0, sessions: [], turns: [], argv: [] };

  // Dois contadores, porque o arquivo responde a duas perguntas diferentes e
  // um numero so nao serve para as duas.
  //
  // `invocations` conta TUDO, inclusive as sondagens de --version e --help.
  // E a prova de que foi este fixture, e nao o binario real, que a CLI
  // executou.
  //
  // `spawns` conta somente processo que abriu sessao. E a prova de reuso: o
  // valor do desenho e manter um unico processo vivo entre turnos, e cada
  // comando da CLI que resolve o binario dispara uma sondagem de versao. Somar
  // as duas coisas faria uma sessao reusada corretamente aparecer como tres
  // spawns, acusando um respawn que nunca houve.
  const isProbe = argv.includes('--version') || argv.includes('-v')
    || argv.includes('--help') || argv.includes('-h');
  state.invocations = (state.invocations || 0) + 1;
  if (!isProbe) state.spawns = (state.spawns || 0) + 1;
  state.behavior = behavior;
  state.pid = process.pid;
  state.argv = argv;
  state.cwd = process.cwd();
  saveFakeState(statePath, state);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Ponto de entrada do executavel. Fala o fluxo JSON no stdout e le turnos
 * do stdin, um por linha.
 */
export async function main(rawArgv = process.argv.slice(2), env = process.env) {
  const { behavior, argv } = selectBehavior(rawArgv, env);
  const statePath = env.CCX_FAKE_STATE || null;

  // O registro do spawn vem ANTES de qualquer atalho, inclusive --version.
  // Isso e o que permite a um teste PROVAR que foi o fixture, e nao o binario
  // real, que a CLI executou: o arquivo so existe se este processo rodou.
  // Checar a prosa do `doctor` nao provaria nada, porque ela pode citar o
  // caminho pedido mesmo quando a resolucao caiu em outro binario.
  recordSpawn(statePath, { behavior, argv });

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${FAKE_VERSION}\n`);
    return 0;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${FAKE_HELP}\n`);
    return 0;
  }

  const ctx = createContext({
    sessionId: env.CCX_FAKE_SESSION_ID || FAKE_SESSION_ID,
    cwd: process.cwd(),
    permissionMode: readFlag(argv, '--permission-mode') || 'bypassPermissions',
    model: readFlag(argv, '--model') || FAKE_MODEL,
  });

  // O estado persistido e o que prova reuso de processo: um spawn com dois
  // turnos registrados significa que o supervisor manteve o Claude vivo.
  const state = loadFakeState(statePath) || { spawns: 0, sessions: [], turns: [], argv: [] };
  state.sessions = [...(state.sessions || []), ctx.sessionId];
  state.turns = state.turns || [];
  saveFakeState(statePath, state);

  const write = (line) => new Promise((resolve) => {
    if (!process.stdout.write(`${line}\n`)) process.stdout.once('drain', resolve);
    else resolve();
  });

  let turnIndex = 0;
  let chain = Promise.resolve();
  let exited = false;

  const runTurn = async (prompt) => {
    if (exited) return;
    const index = turnIndex;
    turnIndex += 1;
    const events = turnScript(behavior, index, prompt, ctx);
    for (const ev of events) {
      if (typeof ev.__delay === 'number') {
        await sleep(ev.__delay);
        continue;
      }
      if (typeof ev.__exit === 'number') {
        exited = true;
        state.turns.push({ n: index + 1, prompt, outcome: 'exit', exitCode: ev.__exit });
        saveFakeState(statePath, state);
        // Sai sem emitir resultado. E exatamente o caso de falha do produto.
        process.exit(ev.__exit);
      }
      if (typeof ev.__raw === 'string') {
        await write(ev.__raw);
        continue;
      }
      await write(JSON.stringify(ev));
    }
    state.turns.push({ n: index + 1, prompt, outcome: 'result' });
    saveFakeState(statePath, state);
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let prompt = trimmed;
    try {
      const parsed = JSON.parse(trimmed);
      const content = parsed?.message?.content;
      if (typeof content === 'string') prompt = content;
      else if (Array.isArray(content)) {
        prompt = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || trimmed;
      }
    } catch {
      // Entrada nao JSON: trata o texto cru como prompt em vez de morrer.
    }
    chain = chain.then(() => runTurn(prompt)).catch((err) => {
      process.stderr.write(`fake-claude: ${err.message}\n`);
    });
  });

  await new Promise((resolve) => {
    rl.on('close', () => { chain.then(resolve, resolve); });
  });
  return 0;
}

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0 && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const prefixed = argv.find((t) => typeof t === 'string' && t.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : null;
}

// ---------------------------------------------------------------------------
// Instalacao dos wrappers de plataforma
// ---------------------------------------------------------------------------
//
// Medido nesta maquina em 2026-09-11 com Node 24.19.0:
//   spawn('claude.cmd')            -> EINVAL   (precisa de shell: true)
//   spawn('claude.cmd', {shell})   -> funciona, MAS trunca argumento
//   spawn('claude.mjs')            -> EFTYPE
//
// O truncamento e o que decide a questao. Medido no mesmo dia: um argumento
// com quebra de linha atravessando `cmd.exe` chega so com a primeira linha.
// Como o contrato de sentinela vai em `--append-system-prompt` e tem varias
// linhas, um envelope de lote faria TODO turno voltar sem marcador, ou seja
// ambiguo, sem causa visivel. Por isso o supervisor recusa `.cmd` e `.bat`,
// e por isso o caminho limpo do fixture e apontar direto para este `.mjs`,
// que o supervisor spawna com o proprio Node. Sem shim, sem compilar nada,
// igual nas tres plataformas.
//
// Os wrappers de lote continuam sendo gravados por um motivo unico: o teste
// que prova que a recusa de `.cmd` acontece e tem mensagem acionavel.

/**
 * Grava os wrappers que fazem o Claude falso parecer um binario instalado.
 * @param {object} options
 * @param {string} options.binDir Diretorio onde gravar. E criado.
 * @param {string} [options.statePath] Caminho do estado persistido.
 * @returns {{ binDir, scriptPath, cmdPath, posixPath, launcherPath, statePath }}
 */
export function installFakeClaude({ binDir, statePath } = {}) {
  if (!binDir) throw new Error('installFakeClaude precisa de binDir');
  fs.mkdirSync(binDir, { recursive: true });

  // Launcher em vez de copia do fonte: uma fonte de verdade so.
  const launcherPath = path.join(binDir, 'claude-fake-launcher.mjs');
  fs.writeFileSync(
    launcherPath,
    [
      '// Gerado por installFakeClaude. Nao editar.',
      `import { main } from ${JSON.stringify(pathToFileURL(FAKE_PATH).href)};`,
      'const code = await main(process.argv.slice(2), process.env);',
      'if (typeof code === "number" && code !== 0) process.exit(code);',
      '',
    ].join('\n'),
    'utf8',
  );

  const cmdPath = path.join(binDir, 'claude.cmd');
  fs.writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0claude-fake-launcher.mjs" %*\r\n`, 'utf8');

  const posixPath = path.join(binDir, 'claude');
  fs.writeFileSync(
    posixPath,
    `#!/bin/sh\nexec node "$(dirname "$0")/claude-fake-launcher.mjs" "$@"\n`,
    'utf8',
  );
  try {
    fs.chmodSync(posixPath, 0o755);
  } catch {
    // Windows nao tem bit de execucao. Sem problema.
  }

  return {
    binDir,
    scriptPath: FAKE_PATH,
    cmdPath,
    posixPath,
    launcherPath,
    statePath: statePath ?? null,
  };
}

/**
 * Monta o ambiente que faz a CLI encontrar o Claude falso.
 *
 * @param {object} options
 * @param {object} options.install Retorno de installFakeClaude.
 * @param {string} options.behavior
 * @param {string} [options.statePath]
 * @param {string} [options.stateDir] Vira CCX_STATE_DIR.
 * @param {'script'|'cmd'|'posix'|'launcher'|'auto'} [options.strategy] O que
 *   apontar em CCX_CLAUDE_BIN. O padrao e 'script', que entrega este proprio
 *   `.mjs` para o supervisor spawnar com Node: e o caminho portatil, sem
 *   envelope de plataforma. 'cmd' existe para o teste da recusa de lote.
 * @param {Record<string,string|undefined>} [options.base]
 * @returns {Record<string,string>}
 */
export function buildEnv({ install, behavior = DEFAULT_BEHAVIOR, statePath, stateDir, strategy = 'auto', base = process.env, extra = {} } = {}) {
  if (!install) throw new Error('buildEnv precisa do retorno de installFakeClaude');
  const sep = process.platform === 'win32' ? ';' : ':';
  const chosen = strategy === 'auto' ? 'script' : strategy;
  const binByStrategy = {
    script: FAKE_PATH,
    cmd: install.cmdPath,
    posix: install.posixPath,
    launcher: install.launcherPath,
  };
  const env = {
    ...base,
    PATH: `${install.binDir}${sep}${base.PATH ?? ''}`,
    CCX_CLAUDE_BIN: binByStrategy[chosen],
    CCX_FAKE_BEHAVIOR: behavior,
    ...extra,
  };
  if (statePath ?? install.statePath) env.CCX_FAKE_STATE = statePath ?? install.statePath;
  if (stateDir) env.CCX_STATE_DIR = stateDir;
  // O fake nunca fala com a rede, mas deixar explicito evita que uma
  // implementacao distraida caia no binario real.
  env.CCX_FAKE_CLAUDE = '1';
  return env;
}

/**
 * Roda o Claude falso como processo filho, entrega os prompts em sequencia e
 * colhe a saida. Sempre spawna por process.execPath, entao nao depende de
 * wrapper de plataforma.
 *
 * @param {object} options
 * @param {string} options.behavior
 * @param {string[]} [options.prompts] Um por turno. O seguinte so e enviado
 *   depois que o resultado do anterior chegar.
 * @param {number} [options.timeoutMs]
 * @param {string} [options.cwd]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string[]} [options.args] Argumentos extra, como --version.
 * @returns {Promise<{events:object[], lines:string[], badLines:string[], exitCode:number|null, stderr:string}>}
 */
export function runFake({ behavior = DEFAULT_BEHAVIOR, prompts = ['tarefa'], timeoutMs = 20000, cwd = process.cwd(), env = {}, args = [], statePath } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, CCX_FAKE_BEHAVIOR: behavior, ...env };
    if (statePath) childEnv.CCX_FAKE_STATE = statePath;

    const child = spawn(process.execPath, [FAKE_PATH, ...args], {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    const badLines = [];
    const events = [];
    let stderr = '';
    let pending = 0;
    let buffer = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`runFake: prazo de ${timeoutMs}ms estourou no comportamento ${behavior}`));
    }, timeoutMs);

    const sendNext = () => {
      if (pending >= prompts.length) {
        child.stdin.end();
        return;
      }
      const prompt = prompts[pending];
      pending += 1;
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    };

    const handleLine = (line) => {
      lines.push(line);
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        badLines.push(line);
        return;
      }
      events.push(ev);
      if (ev.type === 'result') sendNext();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        handleLine(buffer.slice(0, idx).replace(/\r$/, ''));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (buffer.length) handleLine(buffer.replace(/\r$/, ''));
      resolve({ events, lines, badLines, exitCode: code, stderr, state: statePath ? readFakeState(statePath) : null });
    });

    if (args.length === 0) sendNext();
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------

const isEntry = typeof import.meta.main === 'boolean'
  ? import.meta.main
  : (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    const a = path.resolve(entry);
    const b = path.resolve(FAKE_PATH);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  })();

if (isEntry) {
  const code = await main();
  if (typeof code === 'number' && code !== 0) process.exit(code);
}
