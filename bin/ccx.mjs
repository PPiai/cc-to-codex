#!/usr/bin/env node
// Entrada unica da CLI.
//
// Tres regras de desenho que valem para todo subcomando daqui para baixo:
//
// 1. SAIDA DE MAQUINA E DE HUMANO SAO SEPARADAS. Com `--json`, sai UMA
//    linha de JSON no stdout e nada mais. Sem `--json`, sai texto curto.
//    Progresso, aviso e diagnostico vao SEMPRE no stderr, para que o
//    stdout seja consumivel sem filtragem. Em erro, o stdout fica vazio.
// 2. NENHUM `process.exit` no meio da logica. Cada subcomando devolve um
//    codigo de EXIT e este arquivo e o unico lugar que encerra o processo.
//    Modulos de `src/` lancam erro com `code`; aqui traduzimos.
// 3. TODA flag documentada e implementada, e toda flag implementada e
//    documentada. O plugin oficial do Codex declara flags que o codigo nao
//    le, e isso e pior que nao ter a flag: o chamador confia e nao tem
//    efeito.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BUSY_STATUSES,
  COMMAND_KIND,
  EXIT,
  FILES,
  LIMITS,
  LIVE_STATUSES,
  STATE_SCHEMA,
  STATUS,
  SYSTEM_CONTRACT,
  TERMINAL_STATUSES,
  VERSION,
  newId,
  shorten,
} from '../src/protocol.mjs';
import { fail, isTagged } from '../src/errors.mjs';
import { parse } from '../src/args.mjs';
import {
  filePath,
  probeStateRoots,
  resolveClaudeBinary,
  resolveStateRoot,
  sessionDir,
} from '../src/paths.mjs';
import * as store from '../src/state.mjs';
import {
  renderDispatch,
  renderDoctor,
  renderList,
  renderLog,
  renderStatus,
  statusLabel,
} from '../src/render.mjs';
import {
  SCOPES,
  applyInstall,
  codexHome,
  planInstall,
  projectSkillsDir,
  userSkillsDir,
  verifyHint,
} from '../src/install-skill.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modos aceitos por `--permission-mode`. A lista vem da ajuda local do
// binario instalado (2.1.268), que e a fonte de verdade: a documentacao
// publicada e relatorio de pesquisa citaram flags que nao existem.
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

// Padrao autonomo, conforme a decisao de autonomia da spec. Fica explicito
// aqui porque e a escolha de maior consequencia do dispatch. A cerca
// continua valendo neste modo: hook de pre-uso de ferramenta dispara antes
// da checagem de modo de permissao, em todos os modos, e um `deny` do hook
// barra a chamada mesmo sob bypassPermissions.
const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

// Flags que o supervisor usa na linha de comando do Claude. O doctor
// confere cada uma contra a ajuda local para detectar mudanca de versao
// cedo, em vez de descobrir no meio de um despacho.
const REQUIRED_CLAUDE_FLAGS = [
  '--input-format',
  '--output-format',
  '--permission-mode',
  '--settings',
  '--strict-mcp-config',
  '--tools',
  '--verbose',
];

// Modulos que o dispatch precisa em disco. Conferidos antes de spawnar,
// para que a falha seja "arquivo ausente" e nao uma sessao cega que morre
// sem deixar estado.
const RUNTIME_MODULES = ['src/supervisor.mjs', 'src/fence.mjs', 'src/state.mjs', 'src/digest.mjs'];

const DISPATCH_FIRST_STATE_MS = 4000;
const DISPATCH_POLL_MS = 100;
const WAIT_DEFAULT_TIMEOUT_MS = 120000;
const WAIT_POLL_MS = 250;

// ---------------------------------------------------------------------------
// Saida
// ---------------------------------------------------------------------------

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function emitJson(payload) {
  // Uma linha, sempre. Quem consome faz JSON.parse na linha e segue.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Progresso e diagnostico. Nunca stdout. */
function note(text) {
  process.stderr.write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Ajuda
// ---------------------------------------------------------------------------

const HELP = {
  dispatch: `ccx dispatch --task <texto> | --task-file <caminho> [opcoes]

  cria a sessao e retorna na hora. nao espera o primeiro turno.

  --task <texto>            tarefa, em uma string
  --task-file <caminho>     tarefa lida de arquivo (exclui --task)
  --cwd <caminho>           diretorio de trabalho (padrao: atual)
  --label <nome>            rotulo para referir a sessao por nome proprio
  --tools <lista>           restringe as ferramentas nativas do Claude.
                            string vazia desliga todas. reduz custo de cache
  --model <modelo>          modelo desta sessao
  --permission-mode <modo>  ${PERMISSION_MODES.join(' | ')}
                            (padrao: ${DEFAULT_PERMISSION_MODE})
  --fence / --no-fence      cerca de escrita fora do --cwd (padrao: ligada).
                            e defesa em profundidade, NAO fronteira: a
                            ferramenta de shell pode contorna-la
  --raw                     guarda tambem o fluxo cru em ${FILES.raw}.
                            custa disco e e o que permite ccx result trazer
                            o texto final sem truncar
  --json                    uma linha de JSON no stdout`,

  status: `ccx status [ref] [opcoes]

  sem ref, imprime uma linha por sessao conhecida. com ref, imprime o
  estado compacto, que cabe em 15 linhas para qualquer tarefa.

  --wait                    bloqueia ate a sessao sair de trabalhando
                            (exige ref)
  --timeout-ms <n>          teto da espera (padrao: ${WAIT_DEFAULT_TIMEOUT_MS}).
                            no estouro imprime o estado e sai com ${EXIT.TIMEOUT}
  --json                    uma linha de JSON no stdout`,

  say: `ccx say <ref> <mensagem> [--json]

  injeta mensagem numa sessao viva. serve para correcao de rumo e funciona
  haja ou nao pergunta pendente. mensagem com espaco vai entre aspas.
  mensagem que comeca com traco vai depois de --, assim:
    ccx say abc123 -- "--force nao era o que eu queria"`,

  answer: `ccx answer <ref> <resposta> [--json]

  responde a pergunta pendente. RECUSA com codigo ${EXIT.BAD_STATE} quando nao
  ha pergunta pendente, de proposito: sem essa recusa, answer viraria um
  say disfarcado e o orquestrador perderia o sinal de que respondeu a
  coisa nenhuma. para falar fora de pergunta, use ccx say.`,

  result: `ccx result <ref> [--turn <n>] [--json]

  entrega o texto final completo, sem truncar. e o unico comando que gasta
  contexto de proposito: use status durante o trabalho e result no fim.

  --turn <n>                turno especifico (padrao: o ultimo fechado)
  --json                    uma linha de JSON no stdout`,

  log: `ccx log <ref> [opcoes]

  devolve o que aconteceu desde um cursor, em forma resumida, e o cursor
  novo. e o acompanhamento incremental para quando o estado compacto nao
  basta.

  --since <cursor>          ultimo n ja visto (padrao: 0, do inicio)
  --limit <n>               teto de entradas (padrao: ${LIMITS.logPage})
  --json                    uma linha de JSON no stdout`,

  stop: `ccx stop <ref> [--json]

  encerra a sessao de forma ordenada. idempotente: sessao ja parada sai
  com 0. os arquivos da sessao sao preservados; use ccx rm para apagar.`,

  rm: `ccx rm <ref> [--force] [--json]

  remove o diretorio da sessao. recusa com codigo ${EXIT.BAD_STATE} se houver
  supervisor vivo, para nao apagar debaixo dele.

  --force                   remove mesmo assim`,

  ls: `ccx ls [--all] [--json]

  uma linha por sessao: id, estado, turno, idade, negacoes, custo, rotulo
  e diretorio. por padrao mostra so sessao com supervisor vivo.

  --all                     inclui sessao encerrada`,

  doctor: `ccx doctor [--json]

  confere pre-requisitos e nunca lanca por pre-requisito ausente: relata
  tudo e so depois sai com codigo ${EXIT.MISSING_PREREQ} se algo essencial faltar.
  reporta versao e caminho absoluto do Claude, conferencia das flags usadas
  contra a ajuda local, teste de escrita em cada candidato de raiz de
  estado, versao do Codex se presente, e os diretorios de skills.`,

  'install-skill': `ccx install-skill [opcoes]

  grava a skill nos caminhos do Codex, copiando o diretorio skill/ do
  pacote. nao gera conteudo.

  --scope <project|user>    project (padrao) grava em .agents/skills/<nome>
                            dentro do --dir ou do diretorio atual.
                            user grava em <CODEX_HOME>/skills/<nome>,
                            com CODEX_HOME caindo em ~/.codex
  --dir <caminho>           troca a RAIZ de destino. o sufixo do escopo
                            (.agents/skills ou skills) continua sendo aplicado
  --dry-run                 mostra exatamente o que faria, sem escrever
  --json                    uma linha de JSON no stdout`,
};

function globalHelp() {
  return `ccx ${VERSION} - despacha e acompanha sessoes do Claude Code pelo terminal

uso   ccx <comando> [opcoes]

  dispatch        cria uma sessao e retorna na hora
  status [ref]    estado compacto; sem ref, lista todas
  say             injeta mensagem numa sessao viva
  answer          responde a pergunta pendente
  result          texto final completo do turno (gasta contexto)
  log             o que aconteceu desde um cursor
  stop            encerra a sessao de forma ordenada
  rm              remove o diretorio da sessao
  ls              lista sessoes conhecidas
  doctor          confere pre-requisitos e diz o que fazer
  install-skill   grava a skill nos caminhos do Codex

globais
  --help, -h      ajuda do comando
  --version       versao
  --json          uma linha de JSON no stdout, e nada mais

ref e o id curto, um prefixo unico dele, ou o rotulo exato.
ajuda de um comando: ccx <comando> --help
codigos de saida: 0 ok, ${EXIT.USAGE} uso, ${EXIT.NO_SESSION} sessao ausente, ${EXIT.BAD_STATE} estado incompativel, ${EXIT.NO_WRITABLE_ROOT} sem raiz gravavel, ${EXIT.MISSING_PREREQ} pre-requisito ausente, ${EXIT.TIMEOUT} tempo esgotado`;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Inteiro nao negativo, com mensagem que diz o que veio errado. */
function requireCount(value, flag) {
  if (!Number.isInteger(value) || value < 0) {
    throw fail(EXIT.USAGE, `--${flag} exige inteiro nao negativo. recebido: ${value}`);
  }
  return value;
}

function requirePositionals(positionals, count, usage) {
  if (positionals.length !== count) {
    throw fail(
      EXIT.USAGE,
      `esperados ${count} argumento(s) posicional(is), recebidos ${positionals.length}. uso:\n${usage}`,
    );
  }
  return positionals;
}

/**
 * Raiz de estado para comandos de LEITURA.
 *
 * Nao basta repetir a ordem de precedencia do dispatch: se o dispatch caiu
 * no diretorio temporario porque o cwd nao era gravavel, um `ccx ls` rodado
 * depois num cwd gravavel escolheria uma raiz vazia e responderia "nenhuma
 * sessao", que e uma mentira. Entao, para leitura, o primeiro candidato que
 * JA TEM sessao vence, e so se nenhum tiver caimos na resolucao normal.
 */
function discoverRoot(ctx) {
  let candidates = [];
  try {
    candidates = probeStateRoots({ cwd: ctx.cwd, env: ctx.env }) ?? [];
  } catch {
    candidates = [];
  }
  for (const candidate of candidates) {
    try {
      if (store.listSessionIds(candidate.path).length > 0) return candidate.path;
    } catch {
      // Candidato inexistente ou ilegivel nao e erro aqui: e so nao ser ele.
    }
  }
  return resolveStateRoot({ cwd: ctx.cwd, env: ctx.env }).root;
}

/** Resolve a referencia e devolve raiz, id e estado. */
function loadSession(ctx, reference) {
  const root = discoverRoot(ctx);
  const id = store.resolveId(root, reference);
  return { root, id, state: store.readState(root, id) };
}

/** Sessao ainda aceita mensagem? `done` com supervisor vivo aceita. */
function acceptsCommands(state) {
  if (state?.alive === false) return false;
  return !TERMINAL_STATUSES.has(state?.status);
}

/**
 * O que fazer, por estado. A recusa de `answer` tem que dizer o estado
 * atual E o proximo passo: negar sem instrucao obriga o orquestrador a
 * adivinhar, e adivinhar aqui significa outra chamada gastando contexto.
 */
function remedyFor(state) {
  const ref = state?.label || state?.id || '<ref>';
  switch (state?.status) {
    case STATUS.STARTING:
    case STATUS.WORKING:
      return `o turno esta em andamento. espere com: ccx status ${ref} --wait`;
    case STATUS.AMBIGUOUS:
      return `o turno fechou sem sentinela. cobre o contrato com: ccx say ${ref} "..."`;
    case STATUS.DONE:
    case STATUS.BLOCKED:
      return `nao ha pergunta aberta. para continuar a conversa: ccx say ${ref} "..."`;
    case STATUS.FAILED:
    case STATUS.STOPPED:
      return `a sessao terminou. veja o desfecho com: ccx result ${ref}`;
    default:
      return `veja o estado com: ccx status ${ref}`;
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

function readTask(options) {
  const hasTask = typeof options.task === 'string';
  const hasFile = typeof options['task-file'] === 'string';
  if (hasTask && hasFile) {
    throw fail(EXIT.USAGE, '--task e --task-file sao exclusivos. escolha um.');
  }
  if (!hasTask && !hasFile) {
    throw fail(EXIT.USAGE, 'informe a tarefa com --task <texto> ou --task-file <caminho>.');
  }
  let text = options.task ?? '';
  if (hasFile) {
    const file = path.resolve(options['task-file']);
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw fail(EXIT.USAGE, `nao consegui ler --task-file ${file}: ${err.code ?? err.message}`);
    }
  }
  if (text.trim().length === 0) {
    throw fail(EXIT.USAGE, 'a tarefa esta vazia.');
  }
  return text.trim();
}

/**
 * Objeto de configuracao da sessao, gravado em arquivo e passado ao Claude
 * com `--settings <caminho>`.
 *
 * Vai em ARQUIVO, e nao embutido na linha de comando, mesmo a flag aceitando
 * JSON como string: o limite de comprimento de argumento no Windows morde
 * exatamente nesse tipo de payload.
 */
function buildSettings({ fenceOn, fencePath, cwd }) {
  if (!fenceOn) return {};
  const command = `"${process.execPath}" "${fencePath}" --cwd "${cwd}"`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|NotebookEdit',
          hooks: [{ type: 'command', command }],
        },
      ],
    },
  };
}

function missingRuntimeModules() {
  return RUNTIME_MODULES.filter((rel) => !fs.existsSync(path.join(PKG_ROOT, rel)));
}

async function cmdDispatch(ctx) {
  const { options, positionals } = parse(ctx.argv, {
    strings: ['task', 'task-file', 'cwd', 'label', 'tools', 'model', 'permission-mode'],
    booleans: ['fence', 'raw', 'json'],
  });

  // Positional sobrando no dispatch e o defeito mais caro possivel aqui: e
  // o comando que monta prompt. O caso concreto e `--fence off`, que a spec
  // escreve assim e o contrato escreve como par de booleanos: sem esta
  // recusa, o `off` viraria positional descartado e a cerca ficaria LIGADA
  // contra o pedido explicito de desligar, em silencio.
  if (positionals.length > 0) {
    throw fail(
      EXIT.USAGE,
      `dispatch nao aceita argumento posicional. recebido: ${positionals.join(', ')}. ` +
        'a tarefa vai em --task ou --task-file, e a cerca desliga com --no-fence (ou --fence=off).',
    );
  }

  const task = readTask(options);
  const cwd = path.resolve(options.cwd ?? ctx.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw fail(EXIT.USAGE, `--cwd nao e um diretorio existente: ${cwd}`);
  }

  const permissionMode = options['permission-mode'] ?? DEFAULT_PERMISSION_MODE;
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw fail(
      EXIT.USAGE,
      `--permission-mode invalido: ${permissionMode}. aceitos: ${PERMISSION_MODES.join(', ')}`,
    );
  }

  // Falha cedo e com instrucao, em vez de criar sessao cega.
  const missing = missingRuntimeModules();
  if (missing.length > 0) {
    throw fail(
      EXIT.MISSING_PREREQ,
      `faltam modulos do pacote: ${missing.join(', ')} (raiz: ${PKG_ROOT}). ` +
        'rode ccx doctor e reinstale o cc-to-codex.',
    );
  }

  const { root } = resolveStateRoot({ cwd, env: ctx.env });
  const claude = resolveClaudeBinary({ env: ctx.env });

  const fenceOn = options.fence !== false;
  const fencePath = path.join(PKG_ROOT, 'src', 'fence.mjs');
  const supervisorPath = path.join(PKG_ROOT, 'src', 'supervisor.mjs');

  // Colisao de id e responsabilidade daqui: `initSession` recusa quando o
  // diretorio ja existe. O alfabeto tem 32 simbolos em 8 posicoes, entao
  // colisao e rara; sortear de novo poucas vezes resolve sem laco infinito.
  let id = null;
  let meta = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = newId();
    if (fs.existsSync(sessionDir(root, candidate))) continue;

    // meta.json e o unico canal entre a CLI e o supervisor no nascimento da
    // sessao. Nomes redundantes de proposito (claudeBin, bin, claude.path):
    // o supervisor e escrito em paralelo a este arquivo, e um campo a mais
    // custa bytes enquanto um campo com nome divergente custa a sessao.
    const attemptMeta = {
      schema: STATE_SCHEMA,
      id: candidate,
      label: options.label ?? null,
      root,
      cwd,
      task,
      systemContract: SYSTEM_CONTRACT,
      claudeBin: claude.path,
      claudeVersion: claude.version,
      bin: claude.path,
      claude: { path: claude.path, version: claude.version },
      model: options.model ?? null,
      tools: options.tools ?? null,
      permissionMode,
      raw: options.raw === true,
      fence: fenceOn,
      fencePath: fenceOn ? fencePath : null,
      settingsPath: filePath(root, candidate, 'settings'),
      supervisorPath,
      createdAt: new Date().toISOString(),
      ccxVersion: VERSION,
      ccxArgv: ['ccx', 'dispatch', ...ctx.argv],
    };

    try {
      store.initSession(root, candidate, attemptMeta);
      id = candidate;
      meta = attemptMeta;
      break;
    } catch (err) {
      // So colisao justifica nova tentativa. Qualquer outra falha sobe.
      if (!isTagged(err) || err.code !== EXIT.BAD_STATE) throw err;
      lastErr = err;
    }
  }
  if (!id) {
    throw fail(
      EXIT.BAD_STATE,
      `nao consegui criar sessao nova em ${root} apos 8 tentativas de id. ` +
        `ultimo erro: ${lastErr?.message ?? 'diretorio ja existente'}`,
    );
  }
  const label = meta.label;

  store.writeSettings(root, id, buildSettings({ fenceOn, fencePath, cwd }));

  // O modo cru depende daqui: `appendRaw` so grava se o arquivo ja existir,
  // que e como o supervisor evita criar `raw.jsonl` em sessao que nao pediu.
  // Entao o dispatch cria o arquivo vazio ANTES de spawnar; sem isso a flag
  // --raw nao teria efeito nenhum.
  if (meta.raw) {
    fs.writeFileSync(filePath(root, id, 'raw'), '', { flag: 'a' });
  }

  const child = spawn(process.execPath, [supervisorPath, '--root', root, '--id', id], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: ctx.env,
  });
  child.unref();
  const pid = child.pid;

  // Espera curta pelo primeiro estado. Nao e espera do primeiro TURNO: o
  // contrato do dispatch e nao bloquear.
  const deadline = Date.now() + DISPATCH_FIRST_STATE_MS;
  let state = null;
  while (Date.now() < deadline) {
    try {
      state = store.readState(root, id);
      break;
    } catch {
      await sleep(DISPATCH_POLL_MS);
    }
  }

  if (!state) {
    const logPath = filePath(root, id, 'supervisorLog');
    if (pid && !store.isAlive(pid)) {
      throw fail(
        EXIT.BAD_STATE,
        `o supervisor morreu sem gravar estado. veja ${logPath} e rode: ccx doctor`,
      );
    }
    // Sessao sem state.json nao aparece em `ccx ls`, entao o aviso precisa
    // dizer isso: o orquestrador veria "nenhuma sessao" e concluiria errado.
    note(
      `aviso: o supervisor nao gravou estado em ${DISPATCH_FIRST_STATE_MS}ms. ` +
        `ate gravar, ${id} nao aparece em ccx ls. se travar, veja ${logPath}`,
    );
    state = {
      id,
      label,
      cwd,
      pid,
      status: STATUS.STARTING,
      alive: true,
      turn: 0,
      startedAt: meta.createdAt,
      updatedAt: meta.createdAt,
    };
  }

  if (options.json) {
    emitJson({
      ok: true,
      command: 'dispatch',
      id,
      label,
      cwd,
      root,
      pid: state.pid ?? pid,
      status: state.status ?? STATUS.STARTING,
      fence: fenceOn,
      permissionMode,
      raw: meta.raw,
      sessionDir: sessionDir(root, id),
    });
  } else {
    out(renderDispatch({ ...state, id, label, cwd, pid: state.pid ?? pid }));
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(ctx) {
  const { options, positionals } = parse(ctx.argv, {
    booleans: ['wait', 'json'],
    numbers: ['timeout-ms'],
  });
  if (positionals.length > 1) {
    throw fail(EXIT.USAGE, `status aceita no maximo uma ref. recebidas: ${positionals.join(', ')}`);
  }

  if (positionals.length === 0) {
    if (options.wait) {
      // Flag declarada tem que ter efeito. Sem ref nao existe o que esperar.
      throw fail(EXIT.USAGE, '--wait exige uma ref: ccx status <ref> --wait');
    }
    const root = discoverRoot(ctx);
    const states = store.listStates(root);
    // `listStates` omite sessao que ainda nao tem state.json, o que inclui a
    // janela entre criar a sessao e o supervisor escrever pela primeira vez.
    // O inventario bruto e `listSessionIds`, e a diferenca vira aviso em vez
    // de sumico silencioso.
    const pending = store.listSessionIds(root).length - states.length;
    if (options.json) {
      emitJson({ ok: true, command: 'status', root, count: states.length, pending, sessions: states });
    } else {
      out(renderList(states));
      if (pending > 0) note(`${pending} sessao(oes) ainda sem estado gravado.`);
    }
    return EXIT.OK;
  }

  const { root, id } = loadSession(ctx, positionals[0]);
  let state = store.readState(root, id);

  if (options.wait) {
    const timeoutMs = requireCount(options['timeout-ms'] ?? WAIT_DEFAULT_TIMEOUT_MS, 'timeout-ms');
    const deadline = Date.now() + timeoutMs;
    note(`esperando ${id} sair de trabalhando (teto ${timeoutMs}ms)...`);
    while (BUSY_STATUSES.has(state.status) && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
      state = store.readState(root, id);
    }
    if (BUSY_STATUSES.has(state.status)) {
      // Estouro de espera nao e erro, e uma observacao concluida: "ainda
      // trabalhando". Por isso imprime o estado ANTES de sair com 6; sair
      // com stdout vazio deixaria o orquestrador cego.
      if (options.json) emitJson({ ok: false, command: 'status', timedOut: true, id, state });
      else out(renderStatus(state));
      note(`tempo esgotado: ${id} continua em ${statusLabel(state.status)}`);
      return EXIT.TIMEOUT;
    }
  }

  if (options.json) emitJson({ ok: true, command: 'status', id, state });
  else out(renderStatus(state));
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// say / answer
// ---------------------------------------------------------------------------

function cmdSay(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['json'] });
  requirePositionals(positionals, 2, HELP.say);
  const [reference, message] = positionals;
  if (message.trim().length === 0) throw fail(EXIT.USAGE, 'mensagem vazia.');

  const { root, id, state } = loadSession(ctx, reference);
  if (!acceptsCommands(state)) {
    throw fail(
      EXIT.BAD_STATE,
      `a sessao ${id} esta em ${statusLabel(state.status)} e nao aceita mensagem. ${remedyFor(state)}`,
    );
  }

  const seq = store.appendCommand(root, id, {
    kind: COMMAND_KIND.SAY,
    text: message,
    ts: new Date().toISOString(),
  });

  if (options.json) emitJson({ ok: true, command: 'say', id, seq, status: state.status });
  else out(`enviado a ${id} (comando ${seq}). acompanhe: ccx status ${id} --wait`);
  return EXIT.OK;
}

function cmdAnswer(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['json'] });
  requirePositionals(positionals, 2, HELP.answer);
  const [reference, answerText] = positionals;
  if (answerText.trim().length === 0) throw fail(EXIT.USAGE, 'resposta vazia.');

  const { root, id, state } = loadSession(ctx, reference);

  // A recusa e o ponto do comando: sem ela, `answer` seria um `say`
  // disfarcado e o orquestrador acharia que respondeu algo.
  if (state.status !== STATUS.ASKING || !state.pendingQuestion) {
    throw fail(
      EXIT.BAD_STATE,
      `a sessao ${id} nao tem pergunta pendente: estado atual e ${statusLabel(state.status)}. ` +
        `${remedyFor(state)}`,
    );
  }

  const seq = store.appendCommand(root, id, {
    kind: COMMAND_KIND.ANSWER,
    text: answerText,
    question: state.pendingQuestion,
    ts: new Date().toISOString(),
  });

  if (options.json) {
    emitJson({ ok: true, command: 'answer', id, seq, question: state.pendingQuestion });
  } else {
    out(`respondido a ${id} (comando ${seq}).`);
    out(`pergunta: ${shorten(state.pendingQuestion, LIMITS.question)}`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

/**
 * Busca o texto final COMPLETO de um turno.
 *
 * Aqui mora a unica ambiguidade real do contrato: a spec previa um
 * `turns.jsonl` com o texto integral de cada turno, mas `FILES` nao tem
 * essa chave e `state.mjs` nao expoe leitor de texto integral. Entao a
 * busca e em cadeia, do mais fiel ao mais degradado, e o resultado diz de
 * onde veio para que ninguem confunda texto integral com texto truncado.
 *
 * 1. `raw.jsonl`, quando o despacho usou --raw: tem o evento `result` cru,
 *    com o campo `result` inteiro. Ler este arquivo aqui e a unica excecao
 *    a regra de que so `state.mjs` abre arquivo de estado, e ela e
 *    deliberada: nao existe leitor de cru no contrato.
 * 2. `events.jsonl` via readEvents, procurando a entrada de fim de turno.
 * 3. `state.turnLog` e `state.lastMessage`, que e TRUNCADO em
 *    LIMITS.lastMessage e por isso vem com aviso no stderr.
 */
function findTurnText(root, id, wantedTurn) {
  const rawPath = filePath(root, id, 'raw');
  if (fs.existsSync(rawPath)) {
    const results = [];
    for (const line of fs.readFileSync(rawPath, 'utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // Linha nao JSON no meio do fluxo nao derruba a leitura.
      }
      if (event?.type === 'result') results.push(event);
    }
    if (results.length > 0) {
      const index = wantedTurn ? wantedTurn - 1 : results.length - 1;
      const picked = results[index];
      if (!picked) {
        throw fail(EXIT.USAGE, `turno ${wantedTurn} nao existe. ha ${results.length} turno(s) fechado(s).`);
      }
      const text = picked.result ?? picked.text ?? null;
      if (typeof text === 'string' && text.length > 0) {
        return {
          text,
          turn: index + 1,
          source: FILES.raw,
          truncated: false,
          costUsd: picked.total_cost_usd ?? null,
          isError: picked.is_error ?? null,
        };
      }
    }
  }

  const { entries } = store.readEvents(root, id, { since: 0 });
  const ends = (entries ?? []).filter((e) => e?.kind === 'turn-end');
  if (ends.length > 0) {
    // Casa pelo numero de turno declarado na entrada quando ele existir, e
    // so cai na posicao quando nao existir: `n` e o numero global da
    // entrada de log, nunca o numero do turno, entao confiar na posicao
    // como primeira opcao seria contar errado em qualquer sessao que tenha
    // perdido uma entrada.
    const index = wantedTurn ? wantedTurn - 1 : ends.length - 1;
    const picked = wantedTurn
      ? (ends.find((e) => Number(e?.turn) === wantedTurn) ?? ends[index])
      : ends[index];
    if (wantedTurn && !picked) {
      throw fail(EXIT.USAGE, `turno ${wantedTurn} nao existe. ha ${ends.length} turno(s) fechado(s).`);
    }
    if (picked) {
      // Nao sabemos qual campo o digest usou para o texto, entao provamos
      // os plausiveis em vez de cravar um e falhar em silencio.
      //
      // A ordem importa alem da disponibilidade: o digest grava `text` com o
      // texto integral do turno e `detail` com a versao encurtada para o log.
      // Tratar os dois como iguais faria todo `result` sem modo cru avisar que
      // o texto pode estar truncado, o que e falso quando veio de `text` e
      // empurraria o usuario a ligar o modo cru sem necessidade. Pior: um
      // aviso que aparece sempre deixa de ser lido, e ai o caso em que o texto
      // ESTA truncado de verdade passa despercebido.
      const integral = typeof picked.text === 'string' && picked.text.length > 0
        ? picked.text
        : null;
      const degradado = picked.result ?? picked.summary ?? picked.detail ?? null;
      const text = integral ?? degradado;
      if (typeof text === 'string' && text.length > 0) {
        return {
          text,
          turn: picked.turn ?? index + 1,
          source: FILES.events,
          truncated: integral === null,
          costUsd: picked.costUsd ?? null,
          isError: null,
        };
      }
    }
  }

  const state = store.readState(root, id);
  const log = Array.isArray(state.turnLog) ? state.turnLog : [];
  const picked = wantedTurn ? log.find((t) => Number(t?.n) === wantedTurn) : log[log.length - 1];

  // Pedir um turno que nao existe tem que RECUSAR, nunca devolver outro
  // turno em silencio: entregar o ultimo turno rotulado com o numero errado
  // e o tipo de resposta que parece certa e leva o orquestrador a concluir
  // sobre trabalho que nao aconteceu.
  if (wantedTurn && !picked) {
    const known = log.map((t) => t?.n).filter((n) => Number.isFinite(n));
    throw fail(
      EXIT.USAGE,
      `turno ${wantedTurn} nao existe nesta sessao. ` +
        (known.length > 0
          ? `turnos guardados no estado: ${known.join(', ')}.`
          : 'nenhum turno fechado ainda.'),
    );
  }

  return {
    text: state.lastMessage ?? '',
    turn: picked?.n ?? state.turn ?? 0,
    source: FILES.state,
    truncated: true,
    costUsd: picked?.costUsd ?? state.totalCostUsd ?? null,
    isError: null,
    outcome: picked?.outcome ?? state.status,
  };
}

function cmdResult(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['json'], numbers: ['turn'] });
  requirePositionals(positionals, 1, HELP.result);
  const wantedTurn = options.turn === undefined ? null : requireCount(options.turn, 'turn');
  if (wantedTurn === 0) throw fail(EXIT.USAGE, '--turn conta de 1.');

  const { root, id, state } = loadSession(ctx, positionals[0]);
  const found = findTurnText(root, id, wantedTurn);

  if (found.truncated) {
    note(
      `aviso: o texto integral do turno nao esta em disco (origem: ${found.source}); ` +
        'este texto pode estar truncado. despache com --raw para preservar o texto final.',
    );
  }

  if (options.json) {
    emitJson({
      ok: true,
      command: 'result',
      id,
      turn: found.turn,
      status: state.status,
      source: found.source,
      truncated: found.truncated,
      costUsd: found.costUsd,
      totalCostUsd: state.totalCostUsd ?? null,
      permissionDenials: state.permissionDenials ?? 0,
      pendingQuestion: state.pendingQuestion ?? null,
      text: found.text,
    });
  } else {
    out(`turno ${found.turn} de ${id} (${statusLabel(state.status)}), origem ${found.source}`);
    if (Number(state.permissionDenials ?? 0) > 0) {
      // Destaque tambem aqui: um resultado "concluido" com negacao pode
      // estar descrevendo trabalho que nao foi feito.
      out(`!! ${state.permissionDenials} negacoes de permissao nesta sessao`);
    }
    out('');
    out(found.text || '(sem texto)');
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

function cmdLog(ctx) {
  const { options, positionals } = parse(ctx.argv, {
    booleans: ['json'],
    numbers: ['since', 'limit'],
  });
  requirePositionals(positionals, 1, HELP.log);
  const since = requireCount(options.since ?? 0, 'since');
  const limit = requireCount(options.limit ?? LIMITS.logPage, 'limit');

  const { root, id } = loadSession(ctx, positionals[0]);
  const page = store.readEvents(root, id, { since, limit });

  if (options.json) {
    emitJson({
      ok: true,
      command: 'log',
      id,
      since,
      cursor: page.cursor,
      remaining: page.remaining,
      count: (page.entries ?? []).length,
      entries: page.entries ?? [],
    });
  } else {
    out(renderLog(page.entries ?? [], { id, cursor: page.cursor, remaining: page.remaining }));
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// stop / rm / ls
// ---------------------------------------------------------------------------

function cmdStop(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['json'] });
  requirePositionals(positionals, 1, HELP.stop);
  const { root, id, state } = loadSession(ctx, positionals[0]);

  // Idempotente por contrato: sessao ja parada devolve 0.
  if (!acceptsCommands(state)) {
    if (options.json) emitJson({ ok: true, command: 'stop', id, alreadyStopped: true, status: state.status });
    else out(`${id} ja estava em ${statusLabel(state.status)}. nada a fazer.`);
    return EXIT.OK;
  }

  const seq = store.appendCommand(root, id, { kind: COMMAND_KIND.STOP, ts: new Date().toISOString() });
  if (options.json) emitJson({ ok: true, command: 'stop', id, seq, alreadyStopped: false });
  else out(`parada pedida a ${id} (comando ${seq}). arquivos preservados; use ccx rm para apagar.`);
  return EXIT.OK;
}

function cmdRm(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['force', 'json'] });
  requirePositionals(positionals, 1, HELP.rm);
  const root = discoverRoot(ctx);
  const id = store.resolveId(root, positionals[0]);

  let state = null;
  try {
    state = store.readState(root, id);
  } catch (err) {
    // Sessao corrompida sem --force continua sendo erro de sessao: quem
    // quer limpar lixo pede --force explicitamente.
    if (!options.force) throw err;
  }

  if (state && state.alive && LIVE_STATUSES.has(state.status) && !options.force) {
    throw fail(
      EXIT.BAD_STATE,
      `a sessao ${id} tem supervisor vivo em ${statusLabel(state.status)}. ` +
        `pare antes com: ccx stop ${id}    (ou force com: ccx rm ${id} --force)`,
    );
  }

  store.removeSession(root, id);
  if (options.json) emitJson({ ok: true, command: 'rm', id, forced: options.force === true });
  else out(`removida: ${id}`);
  return EXIT.OK;
}

function cmdLs(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['all', 'json'] });
  if (positionals.length > 0) {
    throw fail(EXIT.USAGE, `ls nao aceita argumento posicional. recebido: ${positionals.join(', ')}`);
  }
  const root = discoverRoot(ctx);
  const all = store.listStates(root);

  // Sessao "ativa" e a que tem supervisor vivo em estado vivo. `done`
  // entra: sessao concluida com supervisor de pe ainda aceita dialogo, e e
  // exatamente isso que o desenho quer preservar.
  const shown = options.all ? all : all.filter((s) => s?.alive && LIVE_STATUSES.has(s?.status));
  const pending = store.listSessionIds(root).length - all.length;

  if (options.json) {
    emitJson({
      ok: true,
      command: 'ls',
      root,
      count: shown.length,
      total: all.length,
      pending,
      sessions: shown,
    });
  } else {
    out(renderList(shown));
    if (!options.all && all.length > shown.length) {
      note(`${all.length - shown.length} sessao(oes) encerrada(s) oculta(s). use --all.`);
    }
    if (pending > 0) note(`${pending} sessao(oes) ainda sem estado gravado.`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** Versao do Codex, se houver. Ausencia nao e problema: o ccx roda sem ele. */
function probeCodex() {
  try {
    // No Windows o executavel costuma ser .cmd, que so resolve via shell.
    // Nesse caso o comando vai como UMA string, sem lista de argumentos:
    // passar argumentos junto de shell:true dispara DEP0190 e, pior, faz o
    // shell concatenar sem escapar. Comando fixo, sem entrada do usuario.
    const useShell = process.platform === 'win32';
    const res = useShell
      ? spawnSync('codex --version', { encoding: 'utf8', timeout: 8000, shell: true, windowsHide: true })
      : spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status === 0) {
      return { ok: true, version: (res.stdout ?? '').trim().split(/\r?\n/)[0] };
    }
    return { ok: false, error: (res.stderr ?? res.error?.message ?? `saiu com ${res.status}`).trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Confere as flags usadas contra a ajuda local do binario encontrado. */
function probeClaudeFlags(binPath) {
  try {
    const res = spawnSync(binPath, ['--help'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const help = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (help.trim().length === 0) {
      return { checked: false, error: 'a ajuda local voltou vazia' };
    }
    return { checked: true, missing: REQUIRED_CLAUDE_FLAGS.filter((flag) => !help.includes(flag)) };
  } catch (err) {
    return { checked: false, error: err.message };
  }
}

function cmdDoctor(ctx) {
  const { options, positionals } = parse(ctx.argv, { booleans: ['json'] });
  if (positionals.length > 0) {
    throw fail(EXIT.USAGE, `doctor nao aceita argumento posicional. recebido: ${positionals.join(', ')}`);
  }

  const problems = [];

  // Cada sonda e isolada em try/catch porque o contrato do doctor e nunca
  // lancar por pre-requisito ausente: ele RELATA e sai com codigo depois de
  // imprimir tudo. E o comando que se roda quando nada funciona.
  let claude = { ok: false, error: 'nao avaliado' };
  try {
    const found = resolveClaudeBinary({ env: ctx.env });
    claude = { ok: true, path: found.path, version: found.version };
  } catch (err) {
    claude = { ok: false, error: err.message };
    problems.push({
      what: 'binario do Claude Code nao encontrado ou nao executa',
      fix: 'CCX_CLAUDE_BIN="<caminho absoluto do claude>" ccx doctor',
    });
  }

  const flags = claude.ok ? probeClaudeFlags(claude.path) : { checked: false, error: 'sem binario' };
  if (flags.checked && (flags.missing ?? []).length > 0) {
    problems.push({
      what: `flags que o supervisor usa nao aparecem na ajuda local: ${flags.missing.join(', ')}`,
      fix: `"${claude.path}" --help    e conferir o nome novo antes de despachar`,
    });
  }

  let candidates = [];
  try {
    candidates = probeStateRoots({ cwd: ctx.cwd, env: ctx.env }) ?? [];
  } catch (err) {
    candidates = [];
    problems.push({ what: `sondagem de raiz de estado falhou: ${err.message}`, fix: 'ccx doctor --json' });
  }
  const chosen = candidates.find((c) => c.ok)?.path ?? null;
  if (!chosen) {
    problems.push({
      what: 'nenhum candidato de raiz de estado aceita escrita',
      fix: 'CCX_STATE_DIR="<caminho gravavel>" ccx dispatch ...    (ou amplie as raizes gravaveis do Codex)',
    });
  }

  const missingModules = missingRuntimeModules();
  if (missingModules.length > 0) {
    problems.push({
      what: `modulos do pacote ausentes: ${missingModules.join(', ')}`,
      fix: 'reinstale o cc-to-codex, ou rode o ccx da raiz do pacote',
    });
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    problems.push({
      what: `node ${process.versions.node} e anterior ao piso 18.18`,
      fix: 'atualize o Node para 18.18 ou mais novo',
    });
  }

  // Aviso e diferente de problema: aviso nao impede despachar e por isso
  // nao muda o codigo de saida. Misturar os dois faria o doctor mentir nas
  // duas direcoes: ou sairia 5 por skill ausente, ou diria "tudo pronto"
  // com uma pendencia real na tela.
  const warnings = [];
  const skillDir = path.join(PKG_ROOT, 'skill');
  if (!fs.existsSync(skillDir)) {
    warnings.push('o diretorio skill/ nao existe: ccx install-skill nao tem o que copiar.');
  }

  const report = {
    version: VERSION,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    claude,
    flags,
    pkg: {
      ok: missingModules.length === 0,
      root: PKG_ROOT,
      missing: missingModules,
      skillDir: fs.existsSync(skillDir) ? skillDir : null,
    },
    roots: { chosen, candidates },
    codex: (() => {
      const found = probeCodex();
      if (!found.ok) {
        warnings.push('Codex CLI nao detectado no PATH: o ccx funciona sem ele, mas install-skill nao tem como ser conferido.');
      }
      return found;
    })(),
    skills: {
      codexHome: codexHome(ctx.env),
      user: userSkillsDir(ctx.env),
      project: projectSkillsDir(ctx.cwd),
    },
    problems,
    warnings,
    ok: problems.length === 0,
  };

  if (options.json) emitJson({ ok: report.ok, command: 'doctor', report });
  else out(renderDoctor(report));

  // Codigo depois do relatorio inteiro, nunca antes.
  return report.ok ? EXIT.OK : EXIT.MISSING_PREREQ;
}

// ---------------------------------------------------------------------------
// install-skill
// ---------------------------------------------------------------------------

function cmdInstallSkill(ctx) {
  const { options, positionals } = parse(ctx.argv, {
    strings: ['scope', 'dir'],
    booleans: ['dry-run', 'json'],
  });
  if (positionals.length > 0) {
    throw fail(
      EXIT.USAGE,
      `install-skill nao aceita argumento posicional. recebido: ${positionals.join(', ')}. ` +
        `use --scope ${SCOPES.join('|')}`,
    );
  }

  const plan = planInstall({
    cwd: ctx.cwd,
    scope: options.scope ?? 'project',
    dir: options.dir ?? null,
    env: ctx.env,
    root: PKG_ROOT,
  });
  const dryRun = options['dry-run'] === true;
  const applied = dryRun ? null : applyInstall(plan);
  const hint = verifyHint(plan);

  if (options.json) {
    emitJson({
      ok: true,
      command: 'install-skill',
      dryRun,
      scope: plan.scope,
      name: plan.name,
      sourceDir: plan.sourceDir,
      destDir: plan.destDir,
      destExists: plan.destExists,
      overwrites: plan.overwrites,
      files: plan.files.map((f) => ({ rel: f.rel, to: f.to, bytes: f.bytes })),
      written: applied?.written ?? 0,
      verify: hint,
    });
    return EXIT.OK;
  }

  out(`${dryRun ? 'simulacao' : 'instalada'}: skill "${plan.name}" escopo ${plan.scope}`);
  out(`origem   ${plan.sourceDir}`);
  out(`destino  ${plan.destDir}`);
  for (const file of plan.files) {
    const mark = plan.overwrites.includes(file.rel) ? 'sobrescreve' : 'grava';
    out(`  ${dryRun ? `${mark} (simulado)` : mark} ${file.rel}  ${file.bytes}B`);
  }
  if (!dryRun) out(`${applied.written} arquivo(s), ${applied.bytes}B`);
  out('');
  out(hint);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Despacho de subcomando
// ---------------------------------------------------------------------------

const COMMANDS = {
  dispatch: cmdDispatch,
  status: cmdStatus,
  say: cmdSay,
  answer: cmdAnswer,
  result: cmdResult,
  log: cmdLog,
  stop: cmdStop,
  rm: cmdRm,
  ls: cmdLs,
  doctor: cmdDoctor,
  'install-skill': cmdInstallSkill,
};

async function main(argv) {
  const [first, ...rest] = argv;

  if (first === undefined) {
    // Sem comando e erro de uso, entao a ajuda vai no stderr: o stdout
    // continua limpo para quem estiver canalizando a saida.
    note(globalHelp());
    return EXIT.USAGE;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    out(globalHelp());
    return EXIT.OK;
  }
  if (first === '--version' || first === '-v') {
    out(VERSION);
    return EXIT.OK;
  }

  const handler = COMMANDS[first];
  if (!handler) {
    note(`comando desconhecido: ${first}. comandos: ${Object.keys(COMMANDS).join(', ')}`);
    return EXIT.USAGE;
  }

  // Ajuda do subcomando antes do parser estrito, para que `ccx say --help`
  // nao vire "opcao desconhecida".
  if (rest.includes('--help') || rest.includes('-h')) {
    out(HELP[first]);
    return EXIT.OK;
  }

  return handler({ argv: rest, cwd: process.cwd(), env: process.env });
}

// Sniff so para FORMATAR erro: a leitura autoritativa de --json e feita
// pelo parser de cada subcomando.
const wantsJson = process.argv.slice(2).includes('--json');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = Number.isInteger(code) ? code : EXIT.OK;
  })
  .catch((err) => {
    const code = isTagged(err) ? err.code : EXIT.USAGE;
    if (wantsJson) note(JSON.stringify({ ok: false, code, error: err.message }));
    else note(`erro: ${err.message}`);
    if (!isTagged(err) && process.env.CCX_DEBUG) note(err.stack ?? '');
    process.exitCode = code;
  });
