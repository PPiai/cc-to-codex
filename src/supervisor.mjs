#!/usr/bin/env node
// Supervisor de uma sessao do Claude Code.
//
//   node src/supervisor.mjs --root <abs> --id <id>
//
// Um processo destes por sessao, criado destacado pelo `ccx dispatch`. Ele e o
// unico dono do fluxo: segura o Claude vivo com entrada e saida em JSON de
// linha, digere cada evento, acrescenta as entradas de log, reescreve o estado
// compacto e injeta no stdin as mensagens que o orquestrador deixa no canal de
// comandos.
//
// Tres fatos medidos nesta maquina em 2026-09-11 mandam no desenho:
//
// 1. O processo fica vivo. `claude -p` com fluxo JSON nos dois sentidos aceita
//    varios turnos no mesmo processo, com o mesmo identificador de sessao.
//    Entao o supervisor nao morre quando um turno fecha: ele espera o proximo
//    comando. Quem encerra e o `stop`, ou a morte do proprio Claude.
// 2. Um segundo evento de inicializacao chega no comeco de cada turno. E
//    normal. O digest ignora o repetido e preserva o primeiro.
// 3. Sem alguem respondendo permissao, a ferramenta e negada em silencio e o
//    turno ainda termina com sucesso. Por isso a negacao e contada e exposta:
//    uma tarefa que "terminou" com dez negacoes nao terminou.
//
// Entrega de mensagem NUNCA acontece no meio de um turno. O canal e lido por
// `fs.watch` e tambem por releitura ao fim de cada turno e por uma sondagem
// periodica barata, porque evento de watch se perde no Windows.
//
// Nada deste arquivo escreve em stdout. O stdout do dispatch e consumido como
// JSON pelo orquestrador; diagnostico e stderr do Claude vao para o
// supervisor.log.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  FILES,
  STATUS,
  STATE_SCHEMA,
  SYSTEM_CONTRACT,
  COMMAND_KIND,
  TERMINAL_STATUSES,
  LIMITS,
  shorten,
} from './protocol.mjs';
import { sessionDir, filePath } from './paths.mjs';
import {
  readMeta,
  writeState,
  appendEvent,
  appendRaw,
  readCommands,
} from './state.mjs';
import { createDigest, SYNTHETIC } from './digest.mjs';

// Prazo entre fechar o stdin do Claude e matar a arvore de processos a forca.
// Fechar o stdin e o encerramento limpo; o prazo existe porque um turno em
// andamento pode demorar a perceber.
const STOP_GRACE_MS = 5000;

// Sondagem de seguranca do canal de comandos. Nao substitui o `fs.watch`: e a
// rede embaixo dele, para o caso de evento perdido, que acontece no Windows.
const COMMAND_POLL_MS = 1000;

// Prazo entre `exit` e `close` do processo filho. O encerramento correto e no
// `close`, que e o unico que garante stdout drenado; este prazo cobre o caso
// em que um neto herdou o cano e segura o `close` para sempre.
const CLOSE_GRACE_MS = 2000;

// Pedaco final do stderr guardado em memoria para virar `state.error`. O log
// recebe tudo; o estado compacto so precisa do suficiente para diagnosticar.
const STDERR_TAIL = 4000;

// Guarda contra linha sem fim: se o Claude despejar um megabyte sem quebra de
// linha, e melhor registrar e descartar que estourar a memoria do supervisor.
const MAX_LINE_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

/**
 * Leitura minima e local de `--root` e `--id`.
 *
 * De proposito nao usa `src/args.mjs`: o supervisor precisa conseguir abrir o
 * proprio log de erro antes de qualquer outra coisa, e depender do parser
 * estrito aqui criaria um caminho em que ele morre sem deixar rastro de por
 * que morreu.
 */
function readArgs(argv) {
  const out = { root: null, id: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') out.root = argv[i + 1] ?? null;
    else if (argv[i] === '--id') out.id = argv[i + 1] ?? null;
  }
  return out;
}

const args = readArgs(process.argv.slice(2));

if (!args.root || !args.id) {
  // Sem raiz e id nao existe supervisor.log para escrever. Unico caso em que
  // o stderr do proprio supervisor e o destino possivel.
  process.stderr.write('supervisor: faltam --root e --id\n');
  process.exit(1);
}

const root = path.resolve(args.root);
const id = args.id;
const logPath = filePath(root, id, 'supervisorLog');

/** Acrescenta uma linha ao supervisor.log. Nunca lanca. */
function logLine(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    // Perder o log e ruim; derrubar a sessao por nao conseguir logar e pior.
  }
}

/** Morte antes de existir estado digerido. */
function die(message, err) {
  logLine(`FATAL ${message}${err ? `: ${err.stack ?? err.message ?? err}` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

let meta;
try {
  meta = readMeta(root, id);
} catch (err) {
  die('meta.json ilegivel ou ausente', err);
}

/**
 * Campo obrigatorio do meta. Falha ruidosa e proposital: um `undefined`
 * chegando no `spawn` reaparece como erro 2 do Windows, que nao diz nada.
 * "meta.json sem a chave claudeBin" se resolve em segundos na integracao.
 */
function requireMeta(key) {
  const value = meta?.[key];
  if (value === undefined || value === null || value === '') {
    die(`meta.json sem a chave obrigatoria ${key}`);
  }
  return value;
}

const task = String(requireMeta('task'));
const claudeBin = String(requireMeta('claudeBin'));
const workdir = String(requireMeta('cwd'));

// settings.json e derivavel: o dispatch grava com `writeSettings`, que devolve
// o caminho. Se o meta nao trouxer, o caminho canonico da sessao vale.
const settingsPath = typeof meta.settingsPath === 'string' && meta.settingsPath
  ? meta.settingsPath
  : filePath(root, id, 'settings');

// Modo cru NAO e detectado aqui. `appendRaw` grava se e somente se o
// `raw.jsonl` ja existe, e quem cria o arquivo vazio e o dispatch ao receber
// a flag. Duplicar a deteccao pelo meta criaria um segundo interruptor que
// pode discordar do primeiro, e o raro que discorda e sempre o que quebra.

// ---------------------------------------------------------------------------
// Digest e persistencia
// ---------------------------------------------------------------------------

const digest = createDigest({
  schema: STATE_SCHEMA,
  id,
  label: meta.label ?? null,
  cwd: workdir,
  // `pid` e o do supervisor, nao o do Claude: e este processo que `isAlive`
  // consulta para decidir se a sessao esta viva e se `rm` pode apagar.
  pid: process.pid,
  startedAt: meta.createdAt ?? new Date().toISOString(),
  status: STATUS.STARTING,
});

let stateDirty = false;

function flushState() {
  try {
    writeState(root, id, digest.snapshot());
    stateDirty = false;
  } catch (err) {
    stateDirty = true;
    logLine(`ERRO ao gravar state.json: ${err.stack ?? err.message ?? err}`);
  }
}

/**
 * Caminho unico por onde todo evento passa: digere, acrescenta as entradas de
 * log na ordem em que foram geradas, e grava o estado somente quando algo
 * mudou de fato. Gravar a cada evento de ruido seria desgaste puro num turno
 * com centenas de chamadas de ferramenta.
 */
function feed(ev) {
  let result;
  try {
    result = digest.apply(ev);
  } catch (err) {
    logLine(`ERRO no digest com evento ${ev?.type}: ${err.stack ?? err.message ?? err}`);
    return;
  }
  for (const entry of result.entries) {
    try {
      appendEvent(root, id, entry);
    } catch (err) {
      logLine(`ERRO ao gravar events.jsonl: ${err.stack ?? err.message ?? err}`);
    }
  }
  if (result.changed || stateDirty) flushState();
}

/** Entrada de log avulsa, sem semantica de estado. */
function note(kind, name, detail) {
  feed({ type: SYNTHETIC.NOTE, kind, name, detail });
}

flushState();

// ---------------------------------------------------------------------------
// Linha de comando do Claude
// ---------------------------------------------------------------------------

function buildClaudeArgs() {
  const argv = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // O contrato de sentinela e a peca mais importante do sistema: sem ele,
    // um turno que pergunta e indistinguivel de um turno que concluiu.
    '--append-system-prompt', SYSTEM_CONTRACT,
    // Ignora servidores externos que nao vieram deste despacho. Reduz custo
    // de criacao de cache e superficie de ferramenta.
    '--strict-mcp-config',
  ];

  // Deliberadamente ausente: `--include-partial-messages`. Delta de texto e
  // ruido puro aqui, e o digest ja descarta `stream_event`.

  if (meta.permissionMode) argv.push('--permission-mode', String(meta.permissionMode));
  if (meta.model) argv.push('--model', String(meta.model));
  if (meta.tools !== undefined && meta.tools !== null) argv.push('--tools', String(meta.tools));

  // Configuracao vai em ARQUIVO, nunca embutida na linha de comando: o limite
  // de comprimento de argumento no Windows morde exatamente nesse tipo de
  // payload e nao foi medido. Se o arquivo nao existe, a flag nao entra, para
  // nao fazer o Claude falhar por caminho inexistente.
  if (fs.existsSync(settingsPath)) {
    argv.push('--settings', settingsPath);
  } else {
    logLine(`AVISO settings.json ausente em ${settingsPath}; seguindo sem --settings`);
  }

  return argv;
}

/** Encerra a sessao antes de existir turno, deixando motivo no estado. */
function fatalSession(message) {
  logLine(`FATAL ${message}`);
  note('error', 'supervisor', message);
  feed({ type: SYNTHETIC.EXIT, reason: 'died', fatal: true, exitCode: null, error: message });
  digest.state.alive = false;
  flushState();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ACHADO DE 2026-09-11, MEDIDO, NAO SUPOSTO: NENHUM SPAWN POR INTERPRETADOR
// DE COMANDO.
//
// O `--append-system-prompt` carrega o SYSTEM_CONTRACT inteiro, que tem 28
// linhas. Argumento com quebra de linha NAO sobrevive ao cmd.exe. Os dois
// caminhos foram testados nesta maquina, com um programa que so imprime o
// proprio argv:
//
//   spawn(shim.cmd, args, { shell: true })      -> chegou "contract"
//   cmd /d /s /c "<linha inteira citada>"       -> chegou "## Reporting contract"
//   spawn(binario.exe, args)                    -> chegou IGUAL, 28 linhas
//
// Ou seja: pelo interpretador, o contrato e cortado na primeira quebra de
// linha. E esse e o pior estrago que este sistema pode sofrer, porque a falha
// e silenciosa: sem o contrato inteiro, o modelo nunca emite sentinela, TODO
// turno volta `ambiguous`, e nada no log aponta para o spawn.
//
// Por isso, quem for "simplificar" isto depois: `shell: true` nao e
// equivalente, e envolver em cmd.exe tambem nao. A unica forma segura de
// carregar o contrato e o spawn direto, sem shell. Script de lote fica
// recusado; script Node roda pelo proprio Node, que tambem e spawn direto.
// ---------------------------------------------------------------------------

/**
 * Escolhe o que spawnar: o comando e o prefixo de argumentos que vem antes
 * dos argumentos do Claude.
 *
 * @returns {{ command: string, prefix: string[] }}
 */
function resolveLaunch() {
  const ext = path.extname(claudeBin).toLowerCase();

  // Script Node roda com o Node ATUAL, e nao como executavel. Serve ao Claude
  // falso da suite de teste, que assim e um `.mjs` comum: sem compilar nada,
  // sem envelope, e identico nos tres sistemas. Continua sem shell, entao o
  // contrato chega inteiro pelo mesmo motivo de sempre.
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
    logLine(`binario e script Node; executando com ${process.execPath}`);
    return { command: process.execPath, prefix: [claudeBin] };
  }

  if (process.platform !== 'win32' || (ext !== '.cmd' && ext !== '.bat')) {
    return { command: claudeBin, prefix: [] };
  }

  // Resgate barato: o npm instala o envelope ao lado do binario de verdade
  // com frequencia, e nesse caso da para seguir sem incomodar ninguem.
  const base = claudeBin.slice(0, claudeBin.length - ext.length);
  for (const alt of ['.exe', '.com']) {
    if (fs.existsSync(base + alt)) {
      logLine(`envelope de lote ${claudeBin} trocado pelo binario ${base + alt}`);
      return { command: base + alt, prefix: [] };
    }
  }

  // A instrucao acionavel vem PRIMEIRO de proposito: `state.error` e cortado
  // em LIMITS.lastMessage, e mensagem de erro que perde a saida no
  // truncamento nao serve para nada. O texto completo fica no supervisor.log.
  fatalSession(
    `Aponte CCX_CLAUDE_BIN para o claude.exe. O binario informado e envelope `
    + `de lote (${claudeBin}) e nao ha .exe ao lado; o interpretador de comandos `
    + 'do Windows trunca o contrato de sentinela na primeira quebra de linha, o '
    + 'que faria todo turno voltar ambiguo.',
  );
  return null; // inalcancavel: fatalSession sai do processo
}

/**
 * Spawna o Claude. O caminho vem absoluto do meta porque o sandbox do Codex
 * nao herda PATH: medido em 2026-09-11, chamar por nome falha com erro 2 do
 * Windows na criacao do processo.
 */
function spawnClaude() {
  const { command, prefix } = resolveLaunch();
  return spawn(command, [...prefix, ...buildClaudeArgs()], {
    cwd: workdir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
}


logLine(`iniciando: ${claudeBin} em ${workdir}`);

let child;
try {
  child = spawnClaude();
} catch (err) {
  fatalSession(`spawn do Claude falhou: ${err.message}`);
}

// pid do Claude fica no estado para o painel mostrar, separado do pid do
// supervisor, que e o que define se a sessao esta viva.
digest.state.claudePid = child.pid ?? null;
flushState();

// ---------------------------------------------------------------------------
// Leitura do fluxo
// ---------------------------------------------------------------------------

let stdoutBuffer = '';
let sawResultThisRun = false;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  // Acumula e corta por quebra de linha. Um pedaco do fluxo pode terminar no
  // meio de um objeto JSON, e uma mensagem longa chega partida em varios
  // pedacos: parsear pedaco a pedaco funcionaria no teste de mesa e quebraria
  // no primeiro turno grande de verdade.
  stdoutBuffer += chunk;
  if (stdoutBuffer.length > MAX_LINE_BYTES) {
    logLine(`ERRO linha maior que ${MAX_LINE_BYTES} bytes sem quebra; descartada`);
    note('error', 'overflow', 'linha do fluxo excedeu o limite e foi descartada');
    stdoutBuffer = '';
    return;
  }
  let nl = stdoutBuffer.indexOf('\n');
  while (nl >= 0) {
    const line = stdoutBuffer.slice(0, nl);
    stdoutBuffer = stdoutBuffer.slice(nl + 1);
    handleLine(line);
    nl = stdoutBuffer.indexOf('\n');
  }
});

function handleLine(rawLine) {
  const line = rawLine.replace(/\r$/, '').trim();
  if (line.length === 0) return;

  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    // Linha nao JSON no meio da saida nao derruba a sessao: vira entrada de
    // log e o laco continua. Ja aconteceu com aviso de atualizacao impresso
    // por cima do fluxo.
    logLine(`linha nao JSON: ${shorten(line, 400)}`);
    note('error', 'bad-line', `linha nao JSON: ${line}`);
    return;
  }

  // Sempre chamado, inclusive com o modo cru desligado: e no-op nesse caso.
  try {
    appendRaw(root, id, ev);
  } catch (err) {
    logLine(`ERRO ao gravar raw.jsonl: ${err.message}`);
  }

  feed(ev);

  if (ev && ev.type === 'result') {
    sawResultThisRun = true;
    // Fim de turno: releitura de seguranca do canal antes de entregar. E aqui
    // que um evento de watch perdido no Windows deixa de importar.
    drainCommands('fim de turno');
    maybeDeliver();
  }
}

let stderrTail = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
  // stderr do Claude vai INTEIRO para o supervisor.log, nunca para stdout.
  logLine(`claude stderr: ${String(chunk).trimEnd()}`);
});

child.stdin.on('error', (err) => {
  // EPIPE aqui significa que o Claude fechou a entrada. O evento de saida
  // logo abaixo e quem decide o estado; aqui so registramos.
  logLine(`stdin do claude: ${err.message}`);
});

// ---------------------------------------------------------------------------
// Fila de comandos
// ---------------------------------------------------------------------------

/** @type {Array<{seq:number|null, kind:string, text:string}>} */
const queue = [];
let stopRequested = false;
let forceKillTimer = null;

/**
 * Le o canal a partir do ultimo `seq` processado, que vive no estado. Nao
 * entrega nada: so enfileira. A entrega e decidida por `maybeDeliver`, que
 * conhece o estado do turno.
 */
function drainCommands(origin) {
  let commands;
  try {
    commands = readCommands(root, id, { sinceSeq: digest.state.lastCommandSeq });
  } catch (err) {
    logLine(`ERRO ao ler commands.jsonl (${origin}): ${err.message}`);
    return;
  }
  if (!Array.isArray(commands) || commands.length === 0) return;

  for (const cmd of commands) {
    const kind = cmd?.kind ?? COMMAND_KIND.SAY;
    const text = typeof cmd?.text === 'string' ? cmd.text : '';
    const seq = Number.isFinite(Number(cmd?.seq)) ? Number(cmd.seq) : null;

    if (kind === COMMAND_KIND.STOP) {
      // `stop` nao espera fim de turno. As duas outras esperam porque injetar
      // texto no meio de um turno corromperia a conversa; parar e matar, e
      // quem pediu para parar quer parar agora.
      feed({ type: SYNTHETIC.COMMAND, stage: 'delivered', kind, text, seq, note: origin });
      const dropped = queue.splice(0, queue.length);
      for (const pending of dropped) {
        // Decisao registrada: `say, say, stop` descarta os `say`. O
        // orquestrador pediu para parar, e entregar mensagem em seguida
        // contrariaria o pedido mais recente.
        feed({
          type: SYNTHETIC.COMMAND,
          stage: 'dropped',
          kind: pending.kind,
          text: pending.text,
          seq: pending.seq,
          note: 'descartado por stop',
        });
      }
      requestStop(`comando stop (${origin})`);
      return;
    }

    queue.push({ seq, kind, text });
    feed({ type: SYNTHETIC.COMMAND, stage: 'queued', kind, text, seq, note: origin });
  }
}

/**
 * Entrega no maximo uma mensagem, e so fora de turno.
 *
 * O portao e `status === working`, e nao `BUSY_STATUSES`, por um motivo
 * concreto: `starting` tambem esta em `BUSY_STATUSES`, e e exatamente o
 * estado em que o supervisor nasce. Usar o conjunto aqui travaria o envio da
 * primeira tarefa e a sessao nunca sairia do lugar. `working` e o unico
 * estado em que o Claude esta com a palavra, porque o digest so o atribui ao
 * abrir turno e sai dele ao fechar.
 */
function maybeDeliver() {
  if (stopRequested) return;
  if (queue.length === 0) return;
  if (!child.stdin.writable) {
    logLine('stdin fechado: mensagens na fila nao serao entregues');
    return;
  }
  if (digest.state.status === STATUS.WORKING) return;
  if (TERMINAL_STATUSES.has(digest.state.status)) {
    logLine(`sessao em ${digest.state.status}: mensagem nao entregue`);
    return;
  }

  const cmd = queue.shift();
  let noteText = null;

  if (cmd.kind === COMMAND_KIND.ANSWER && digest.state.status !== STATUS.ASKING) {
    // A recusa por estado e da CLI, que e onde o orquestrador ve o codigo de
    // saida. Aqui, rebaixar para `say` e o comportamento certo: perder a
    // mensagem seria pior que entrega-la fora de contexto.
    noteText = `answer fora de asking (status ${digest.state.status}), tratado como say`;
    logLine(noteText);
    note('command', COMMAND_KIND.ANSWER, noteText);
  }

  const payload = { type: 'user', message: { role: 'user', content: cmd.text } };
  try {
    // Uma linha por mensagem, terminada por quebra de linha. Formato medido
    // funcionando em 2026-09-11.
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    logLine(`ERRO ao escrever no stdin: ${err.message}`);
    note('error', 'stdin', `falha ao entregar mensagem: ${err.message}`);
    return;
  }

  // Marca entregue DEPOIS da escrita bem-sucedida. E este evento que abre o
  // turno no digest, entao a ordem importa: estado dizendo `working` sem
  // mensagem escrita travaria a fila para sempre.
  feed({
    type: SYNTHETIC.COMMAND,
    stage: 'delivered',
    kind: cmd.kind === COMMAND_KIND.ANSWER ? COMMAND_KIND.ANSWER : COMMAND_KIND.SAY,
    text: cmd.text,
    seq: cmd.seq,
    note: noteText,
  });
}

function requestStop(reason) {
  if (stopRequested) return;
  stopRequested = true;
  logLine(`encerrando: ${reason}`);
  try {
    child.stdin.end();
  } catch (err) {
    logLine(`ERRO ao fechar stdin: ${err.message}`);
  }
  forceKillTimer = setTimeout(() => {
    logLine(`prazo de ${STOP_GRACE_MS}ms esgotado; matando a arvore de processos`);
    killTree();
  }, STOP_GRACE_MS);
  // O temporizador nao deve segurar o laco de eventos se o Claude sair antes.
  if (typeof forceKillTimer.unref === 'function') forceKillTimer.unref();
}

function killTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Encerra a arvore: o Claude cria processos filhos para ferramenta de
    // shell, e matar so o pai deixaria orfaos segurando arquivo.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (err) {
      logLine(`ERRO no taskkill: ${err.message}`);
    }
    return;
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ja morreu */ }
    }, 2000).unref();
  } catch (err) {
    logLine(`ERRO ao matar processo: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Observacao do canal de comandos
// ---------------------------------------------------------------------------

let watcher = null;
const dir = sessionDir(root, id);

try {
  // Observa o DIRETORIO, e nao o arquivo: `commands.jsonl` pode nao existir
  // ainda quando o supervisor nasce, e observar arquivo inexistente falha.
  watcher = fs.watch(dir, { persistent: false }, (_type, filename) => {
    if (filename && filename !== FILES.commands) return;
    drainCommands('watch');
    maybeDeliver();
  });
  watcher.on('error', (err) => {
    logLine(`fs.watch falhou, seguindo com sondagem: ${err.message}`);
  });
} catch (err) {
  // Degradacao natural e prevista: a sondagem abaixo sozinha ja mantem o
  // contrato, so com latencia maior.
  logLine(`fs.watch indisponivel, seguindo com sondagem: ${err.message}`);
}

// Sondagem barata: so releitura quando o tamanho do arquivo mudou. Existe por
// causa de evento de watch perdido no Windows, que foi observado no
// levantamento e e o motivo da releitura ao fim de cada turno tambem.
let lastCommandsSize = -1;
const commandsPath = filePath(root, id, 'commands');
const pollTimer = setInterval(() => {
  let size = 0;
  try {
    size = fs.statSync(commandsPath).size;
  } catch {
    return; // canal ainda nao existe
  }
  if (size === lastCommandsSize) return;
  lastCommandsSize = size;
  drainCommands('sondagem');
  maybeDeliver();
}, COMMAND_POLL_MS);

// ---------------------------------------------------------------------------
// Primeiro turno
// ---------------------------------------------------------------------------

// A tarefa entra pelo mesmo caminho de qualquer mensagem, inclusive gerando
// entrada de log, para que o `ccx log` mostre desde a primeira linha o que
// foi pedido.
queue.push({ seq: null, kind: COMMAND_KIND.SAY, text: task });
maybeDeliver();

// Comandos podem ter chegado entre o dispatch e este ponto.
drainCommands('inicio');

// ---------------------------------------------------------------------------
// Encerramento
// ---------------------------------------------------------------------------

let finished = false;

function finish(reason, exitCode, signal) {
  if (finished) return;
  finished = true;

  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
  clearInterval(pollTimer);
  if (watcher) {
    try { watcher.close(); } catch { /* ja fechado */ }
  }

  // Resto do buffer: se o Claude morreu no meio de uma linha, o que sobrou
  // ainda pode ser um evento inteiro sem a quebra final.
  if (stdoutBuffer.trim().length > 0) {
    const leftover = stdoutBuffer;
    stdoutBuffer = '';
    handleLine(leftover);
  }

  if (queue.length > 0) {
    logLine(`${queue.length} mensagem(ns) na fila perdida(s) no encerramento`);
    note('error', 'fila', `${queue.length} mensagem(ns) nao entregue(s) no encerramento`);
  }

  // O digest decide o estado final: `stopped` quando foi pedido, `failed`
  // quando morreu com turno aberto. Sem este evento a sessao ficaria presa em
  // trabalhando para sempre.
  feed({
    type: SYNTHETIC.EXIT,
    reason,
    exitCode: exitCode ?? null,
    signal: signal ?? null,
    stderr: stderrTail ? shorten(stderrTail, LIMITS.lastMessage) : null,
    // Erro de criacao de processo e sempre fatal, mesmo sem turno aberto.
    fatal: spawnError !== null,
    error: spawnError ?? undefined,
  });

  // Sempre grava o estado final, mesmo que nada tenha mudado, porque
  // `alive: false` e o que faz a CLI parar de acreditar que ha supervisor.
  digest.state.alive = false;
  flushState();

  logLine(
    `encerrado: motivo=${reason} codigo=${exitCode} sinal=${signal} `
    + `status=${digest.state.status} turnos=${digest.state.turnsCompleted} `
    + `negacoes=${digest.state.permissionDenials}`,
  );

  if (stderrTail && !sawResultThisRun) {
    logLine(`stderr final do claude: ${shorten(stderrTail, 1000)}`);
  }
}

// Falha de criacao do processo, tipicamente binario inexistente. E falha
// fatal, nao morte comum: nenhum turno chegou a existir, e sem marcar assim a
// sessao terminaria em `starting` com `alive: false`, que nao explica nada.
let spawnError = null;
child.on('error', (err) => {
  logLine(`ERRO do processo do claude: ${err.stack ?? err.message}`);
  stderrTail = (stderrTail + `\n${err.message}`).slice(-STDERR_TAIL);
  spawnError = `falha ao executar ${claudeBin}: ${err.message}`;
});

// O encerramento acontece no `close`, e NAO no `exit`, e a diferenca importa:
// `exit` dispara quando o processo morre, com o stdout possivelmente ainda
// cheio. Como o `result` costuma ser a ultima linha do fluxo, encerrar no
// `exit` faria o supervisor fechar a sessao antes de ler o desfecho e marcar
// como falha um turno que tinha concluido.
let exitInfo = null;
let closeFallbackTimer = null;

child.on('exit', (code, signal) => {
  exitInfo = { code, signal };
  closeFallbackTimer = setTimeout(() => {
    logLine(`close nao chegou em ${CLOSE_GRACE_MS}ms depois do exit; encerrando pelo prazo`);
    finish(stopRequested ? 'stopped' : 'died', code, signal);
  }, CLOSE_GRACE_MS);
});

child.on('close', (code, signal) => {
  finish(
    stopRequested ? 'stopped' : 'died',
    code ?? exitInfo?.code ?? null,
    signal ?? exitInfo?.signal ?? null,
  );
});

// Parada do proprio supervisor conta como parada da sessao: o Claude nao pode
// ficar orfao segurando cota.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      logLine(`recebido ${sig}`);
      requestStop(`sinal ${sig}`);
      killTree();
    });
  } catch {
    // SIGBREAK so existe no Windows; ausencia nao e erro.
  }
}

process.on('uncaughtException', (err) => {
  logLine(`EXCECAO NAO TRATADA: ${err.stack ?? err.message}`);
  note('error', 'supervisor', `excecao nao tratada: ${err.message}`);
  requestStop('excecao nao tratada');
  killTree();
  finish('died', null, null);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  logLine(`PROMESSA REJEITADA: ${reason?.stack ?? reason}`);
});

process.on('exit', () => {
  // Ultima linha de defesa: se o processo sair por um caminho que nao passou
  // por `finish`, o estado ainda precisa dizer que nao ha supervisor vivo.
  if (!finished) {
    digest.state.alive = false;
    try { writeState(root, id, digest.snapshot()); } catch { /* nada a fazer */ }
  }
});
