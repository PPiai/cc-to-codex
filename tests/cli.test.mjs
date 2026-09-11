// Ciclo de vida ponta a ponta, pela CLI de verdade, contra o Claude falso.
//
// Nenhum teste deste arquivo toca no binario real do Claude: o ambiente
// aponta CCX_CLAUDE_BIN para o fixture. Se algum dia um destes testes
// comecar a custar dinheiro, e porque a injecao quebrou, e o teste de
// sanidade logo abaixo e o que detecta isso.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT, STATUS } from '../src/protocol.mjs';
import { buildEnv, installFakeClaude, readFakeState, FAKE_VERSION } from './fake-claude.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CCX = path.join(RAIZ, 'bin', 'ccx.mjs');

const semCli = fs.existsSync(CCX) ? false : `bin/ccx.mjs ainda nao existe em ${CCX}`;
const semSupervisor = fs.existsSync(path.join(RAIZ, 'src', 'supervisor.mjs'))
  ? false
  : 'src/supervisor.mjs ainda nao existe';
const skip = semCli || semSupervisor;

// PORTAO DE SEGURANCA. Medido em 2026-09-11: quando CCX_CLAUDE_BIN aponta
// para um caminho que a resolucao nao aceita, ela IGNORA o override em
// silencio e cai na busca por PATH, onde acha o binario REAL instalado na
// maquina. Sem este portao a suite deixaria de testar e passaria a gastar
// cota paga, sem nenhum sinal de que isso aconteceu.
//
// A prova e COMPORTAMENTAL, nao textual. `doctor` valida o binario rodando
// `--version`, e o fixture registra todo spawn no arquivo de estado antes de
// qualquer atalho. Entao o arquivo existir significa que foi o fixture que
// executou. Procurar o caminho na prosa do `doctor` nao serviria: a saida
// pode citar o caminho pedido mesmo tendo resolvido outro binario, que e
// exatamente como este furo passou despercebido na primeira versao.
//
// O resultado e memorizado por estrategia: a resolucao do binario nao depende
// do diretorio da sessao, e um `doctor` por teste custaria mais que a suite.
const portoes = new Map();

function verificarInjecao(strategy, executar, statePath) {
  if (portoes.has(strategy)) return portoes.get(strategy);
  const diag = executar('doctor');
  const resultado = { ok: readFakeState(statePath) !== null, diagnostico: diag.stdout };
  portoes.set(strategy, resultado);
  return resultado;
}

/** Monta um ambiente isolado: raiz de estado propria, area de trabalho propria. */
function ambiente({ behavior = 'done', extra = {}, strategy = 'auto' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-e2e-'));
  // Toda sessao despachada e encerrada no fim do teste. Sem isto o supervisor
  // sobrevive ao teste segurando o Claude vivo, e uma suite interrompida
  // deixa dezenas de processos orfaos: medido em 100 de uma vez enquanto este
  // arquivo era escrito. Apagar o diretorio nao basta, porque o processo nao
  // mora nele.
  const despachadas = [];
  test.after(() => {
    for (const id of despachadas) {
      try {
        spawnSync(process.execPath, [CCX, 'stop', id], { cwd: work, env, encoding: 'utf8', timeout: 10000 });
      } catch {
        // Sessao ja encerrada, ou raiz ja removida. Nao ha o que salvar.
      }
    }
    // A remocao e best-effort e NUNCA derruba o teste. No Windows o diretorio
    // fica preso por alguns instantes depois que o processo morre, porque o
    // `cwd` dele era este diretorio, e um EPERM aqui reprovaria um teste que
    // passou. As tentativas cobrem o caso comum; o resto fica para o sistema.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch {
      // Diretorio temporario sobrevivente nao e defeito do que foi testado.
    }
  });

  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  const work = path.join(dir, 'work');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(work, { recursive: true });

  // Fora do teste do envelope de lote, os wrappers saem do caminho. Deixar um
  // `claude.cmd` alcancavel pelo PATH mascararia a pergunta que este arquivo
  // faz: se CCX_CLAUDE_BIN nao for honrado, a busca por PATH acharia o
  // wrapper e o portao de seguranca passaria sem que o binario apontado
  // tivesse sido usado. Sem wrapper, ou o override e honrado, ou o portao
  // aborta. As duas respostas sao verdadeiras.
  if (strategy !== 'cmd' && strategy !== 'posix') {
    for (const p of [install.cmdPath, install.posixPath]) {
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }

  const env = buildEnv({
    install,
    behavior,
    stateDir,
    strategy,
    statePath: path.join(dir, 'fake-state.json'),
    extra: { CCX_FAKE_DELAY_MS: '400', ...extra },
  });

  const executar = (...args) => {
    const r = spawnSync(process.execPath, [CCX, ...args], {
      cwd: work, env, encoding: 'utf8', timeout: 30000,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  const statePath = path.join(dir, 'fake-state.json');
  const portao = verificarInjecao(strategy, executar, statePath);

  const amb = {
    dir, work, stateDir, install, env, statePath, despachadas,
    injecaoOk: portao.ok,
    diagnostico: portao.diagnostico,
    fakeState: statePath,
  };

  // O portao vive no invocador, e nao numa chamada que cada teste precisa
  // lembrar de fazer. Um teste novo que despache sem pensar nisso e barrado
  // do mesmo jeito, que e a unica garantia que vale.
  const ccx = (...args) => {
    if (args[0] === 'dispatch') exigirClaudeFalso(amb);
    return executar(...args);
  };

  const json = (...args) => {
    const r = ccx(...args);
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    } catch {
      parsed = null;
    }
    return { ...r, json: parsed };
  };

  amb.ccx = ccx;
  amb.json = json;
  // Escotilha para os testes que exercitam recusa de ARGUMENTO. A CLI valida
  // a linha de comando antes de resolver binario ou spawnar coisa alguma,
  // entao esses casos nao tem como custar cota. Cada uso confere o codigo de
  // saida de uso, que e a prova de que nada foi executado.
  amb.ccxCru = executar;
  return amb;
}

/**
 * Recusa rodar um teste que gastaria cota paga.
 * Chamado antes de qualquer despacho.
 */
function exigirClaudeFalso(amb) {
  if (amb.injecaoOk) return;
  const linha = amb.diagnostico.split(/\r?\n/).find((l) => /\.exe|\.mjs|\.cmd|\.bat/i.test(l));
  assert.fail(
    'ABORTADO para nao gastar cota paga: a CLI nao executou o Claude falso.\n'
    + `CCX_CLAUDE_BIN foi definido como ${amb.env.CCX_CLAUDE_BIN}\n`
    + `mas o fixture nunca rodou. O doctor resolveu: ${(linha ?? '(nao identificado)').trim()}\n`
    + 'O override explicito precisa ser honrado, ou recusado alto. '
    + 'Cair no PATH em silencio faz o teste chamar o binario real e virar conta a pagar.',
  );
}

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Consulta o estado ate o predicado bater ou o prazo estourar. */
async function esperar(amb, id, predicado, { timeoutMs = 10000 } = {}) {
  const limite = Date.now() + timeoutMs;
  let ultimo = null;
  while (Date.now() < limite) {
    const r = amb.json('status', id, '--json');
    ultimo = r.json?.state ?? null;
    if (ultimo && predicado(ultimo)) return ultimo;
    await dormir(120);
  }
  throw new Error(`prazo esgotado esperando estado. Ultimo: ${JSON.stringify(ultimo)}`);
}

/** Despacha e devolve o identificador curto da sessao. */
function despachar(amb, tarefa, ...extras) {
  exigirClaudeFalso(amb);
  const r = amb.json('dispatch', '--task', tarefa, '--json', ...extras);
  if (r.json?.id) amb.despachadas.push(r.json.id);
  assert.equal(r.code, EXIT.OK, `dispatch falhou: ${r.stdout}\n${r.stderr}`);
  assert.ok(r.json?.id, `dispatch nao devolveu id: ${r.stdout}`);
  return r.json.id;
}

// ---------------------------------------------------------------------------
// Sanidade da injecao
// ---------------------------------------------------------------------------

test('o override explicito do binario e honrado, e o Claude real nunca e chamado', { skip }, () => {
  // Este e o teste que impede a suite inteira de virar uma conta a pagar.
  // Se CCX_CLAUDE_BIN nao for honrado, a resolucao cai no PATH e acha o
  // binario real instalado na maquina.
  const amb = ambiente();
  exigirClaudeFalso(amb);

  // Prova dupla e feita neste ambiente, sem depender da memoizacao do
  // portao: roda o diagnostico aqui e confere que quem executou foi o
  // fixture, e que a versao reportada e a que so ele emite.
  const diag = amb.ccxCru('doctor');
  assert.equal(diag.code, EXIT.OK, diag.stdout + diag.stderr);

  const registro = readFakeState(amb.fakeState);
  // `invocations` e nao `spawns`: o diagnostico so roda --version, que e uma
  // sondagem e nao abre sessao. `spawns` conta exclusivamente processo que
  // abriu sessao, porque e com ele que outro teste prova o reuso entre
  // turnos. A pergunta aqui e outra: quem foi executado, o fixture ou o
  // binario real da maquina.
  assert.ok(registro && registro.invocations >= 1, 'o fixture nao registrou nenhuma invocacao');
  assert.ok(
    diag.stdout.includes(FAKE_VERSION.split(' ')[0]),
    `o doctor nao reportou a versao do fixture: ${diag.stdout.slice(0, 200)}`,
  );
});

test('o diagnostico reporta a raiz de estado escolhida', { skip }, () => {
  const amb = ambiente();
  const r = amb.ccx('doctor');
  assert.ok(r.stdout.includes(amb.stateDir), 'o doctor nao mostrou a raiz escolhida');
});

test('binario terminado em envelope de lote e recusado com mensagem acionavel', { skip: skip || process.platform !== 'win32' }, async () => {
  // Comportamento que custou caro para descobrir e que precisa ficar preso.
  // Medido em 2026-09-11: um argumento com quebra de linha atravessando
  // cmd.exe chega so com a primeira linha. Como o contrato de sentinela tem
  // varias linhas, um envelope de lote faria TODO turno voltar sem marcador,
  // ou seja ambiguo, sem causa visivel em lugar nenhum. Falhar alto custa uma
  // mensagem de erro; deixar passar custa a confianca no sistema inteiro.
  const amb = ambiente({ strategy: 'cmd' });
  exigirClaudeFalso(amb);
  const r = amb.json('dispatch', '--task', 'refatore auth', '--json');

  let motivo = r.stdout + r.stderr;
  if (r.code === EXIT.OK && r.json?.id) {
    const estado = await esperar(amb, r.json.id, (s) => s.status === STATUS.FAILED);
    motivo = String(estado.error ?? '');
  }

  assert.match(motivo, /\.cmd|lote|batch/i, `a recusa precisa nomear o envelope de lote: ${motivo}`);
  assert.match(motivo, /CCX_CLAUDE_BIN|\.exe/i, `a recusa precisa dizer o que fazer: ${motivo}`);
});

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

test('o despacho retorna na hora, com identificador e estado inicial', { skip }, () => {
  const amb = ambiente();
  const r = amb.json('dispatch', '--task', 'refatore auth', '--label', 'refactor-auth', '--json');
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.match(r.json.id, /^[a-z2-9]{8}$/);
  assert.equal(r.json.label, 'refactor-auth');
  assert.equal(typeof r.json.pid, 'number');
  assert.ok([STATUS.STARTING, STATUS.WORKING].includes(r.json.status), `estado inicial inesperado: ${r.json.status}`);
});

test('o despacho sem tarefa e erro de uso', { skip }, () => {
  const amb = ambiente();
  const antes = readFakeState(amb.fakeState)?.spawns ?? 0;
  const r = amb.ccxCru('dispatch', '--json');
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(readFakeState(amb.fakeState)?.spawns ?? 0, antes, 'a recusa de argumento nao pode spawnar nada');
});

test('o despacho grava o contrato de sentinela no prompt entregue ao Claude', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const estadoFake = readFakeState(amb.fakeState);
  assert.ok(estadoFake, 'o fixture nao registrou execucao');
  const linha = estadoFake.argv.join(' ');
  assert.ok(linha.includes('--append-system-prompt'), `o contrato nao foi anexado: ${linha}`);
});

test('o despacho passa as flags de fluxo que a versao 2.1.268 exige', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const argv = readFakeState(amb.fakeState).argv;
  for (const flag of ['-p', '--input-format', '--output-format', '--verbose']) {
    assert.ok(argv.includes(flag), `faltou ${flag} na linha de comando: ${argv.join(' ')}`);
  }
  // Secao 3.2 da spec: estas nao existem e nao podem ser passadas.
  for (const flag of ['--allow-tools', '--max-turns', '--max-cost-usd']) {
    assert.ok(!argv.includes(flag), `passou a flag inexistente ${flag}`);
  }
});

// ---------------------------------------------------------------------------
// O ciclo completo com pergunta
// ---------------------------------------------------------------------------

test('o ciclo de pergunta e resposta leva a sessao ate a conclusao', { skip }, async () => {
  const amb = ambiente({ behavior: 'ask-then-done' });
  const id = despachar(amb, 'refatore auth', '--label', 'refactor-auth');

  const esperando = await esperar(amb, id, (s) => s.status === STATUS.ASKING);
  assert.ok(esperando.pendingQuestion, 'o estado de espera precisa publicar a pergunta');
  assert.match(esperando.pendingQuestion, /token v1/);

  const resposta = amb.json('answer', id, 'mantenha a compatibilidade com o v1', '--json');
  assert.equal(resposta.code, EXIT.OK, resposta.stdout + resposta.stderr);

  const final = await esperar(amb, id, (s) => s.status === STATUS.DONE);
  assert.equal(final.pendingQuestion, null, 'a pergunta ficou pendente depois de respondida');
  assert.equal(final.turn, 2);
});

test('a mensagem de acompanhamento chega e abre um turno novo', { skip }, async () => {
  const amb = ambiente({ behavior: 'multi-turn' });
  const id = despachar(amb, 'parte 1');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const r = amb.ccx('say', id, 'agora a parte 2');
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);

  const depois = await esperar(amb, id, (s) => s.turn === 2 && s.status === STATUS.DONE);
  assert.equal(depois.turn, 2);

  const estadoFake = readFakeState(amb.fakeState);
  assert.equal(estadoFake.spawns, 1, 'o Claude foi respawnado em vez de reusado entre turnos');
  assert.match(estadoFake.turns.at(-1).prompt, /parte 2/);
});

test('o resultado entrega o texto final completo, com o marcador', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const r = amb.ccx('result', id);
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  assert.match(r.stdout, /@@DONE:/, 'o resultado precisa entregar o texto integral');
  assert.match(r.stdout, /rotate\.ts/);
});

test('o estado compacto agrega ferramentas e arquivos sem crescer com o turno', { skip }, async () => {
  const amb = ambiente({ behavior: 'many-files' });
  const id = despachar(amb, 'gere os modulos');
  const estado = await esperar(amb, id, (s) => s.status === STATUS.DONE, { timeoutMs: 25000 });

  assert.equal(estado.toolCounts.Write, 25);
  assert.equal(estado.filesTouched.length, 20);
  assert.equal(estado.filesTouchedExtra, 5);

  const texto = amb.ccx('status', id);
  const linhas = texto.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(linhas.length <= 20, `o estado compacto saiu com ${linhas.length} linhas`);
});

test('o log avanca por cursor em vez de reentregar tudo', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const primeiro = amb.json('log', id, '--limit', '3', '--json');
  assert.equal(primeiro.code, EXIT.OK, primeiro.stdout + primeiro.stderr);
  assert.ok(primeiro.json.cursor > 0, 'o log precisa devolver o cursor novo');

  const segundo = amb.json('log', id, '--since', String(primeiro.json.cursor), '--json');
  assert.equal(segundo.code, EXIT.OK);
  assert.ok(segundo.json.cursor >= primeiro.json.cursor);
  const entradas = segundo.json.entries ?? [];
  assert.ok(entradas.every((e) => e.n > primeiro.json.cursor), 'o log reentregou o que ja tinha sido visto');
});

// ---------------------------------------------------------------------------
// A regra nao negociavel, ponta a ponta
// ---------------------------------------------------------------------------

test('turno sem marcador chega ao orquestrador como ambiguo, jamais como concluido', { skip }, async () => {
  const amb = ambiente({ behavior: 'no-marker' });
  const id = despachar(amb, 'refatore auth');
  const estado = await esperar(amb, id, (s) => !['starting', 'working'].includes(s.status));

  assert.equal(estado.status, STATUS.AMBIGUOUS);
  assert.notEqual(estado.status, STATUS.DONE, 'uma pergunta em prosa virou tarefa entregue');
  assert.equal(estado.pendingQuestion, null);
  assert.ok(estado.lastMessage.length > 0, 'o estado ambiguo precisa mostrar o texto para o orquestrador decidir');
});

test('a sessao ambigua continua viva e aceita cobranca do marcador', { skip }, async () => {
  const amb = ambiente({ behavior: 'no-marker' });
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.AMBIGUOUS);

  const r = amb.ccx('say', id, 'feche o turno com o marcador correto');
  assert.equal(r.code, EXIT.OK, `say recusado numa sessao ambigua: ${r.stdout}${r.stderr}`);
});

test('as negacoes de permissao aparecem no estado compacto', { skip }, async () => {
  const amb = ambiente({ behavior: 'denials' });
  const id = despachar(amb, 'escreva fora do escopo');
  const estado = await esperar(amb, id, (s) => s.status === STATUS.DONE);

  assert.equal(estado.permissionDenials, 3);
  assert.ok(estado.denialSamples.length > 0, 'o orquestrador precisa ver o que foi negado');
});

test('processo que morre sem resultado vira falha, nao fica pendurado em trabalhando', { skip }, async () => {
  const amb = ambiente({ behavior: 'crash' });
  const id = despachar(amb, 'investigue o bug');
  const estado = await esperar(amb, id, (s) => s.status === STATUS.FAILED);

  assert.equal(estado.status, STATUS.FAILED);
  assert.equal(estado.alive, false);
  assert.notEqual(estado.exitCode, 0, 'a falha precisa registrar o codigo de saida');
});

// ---------------------------------------------------------------------------
// Espera com prazo
// ---------------------------------------------------------------------------

test('a espera com prazo curto estoura com o codigo de tempo esgotado', { skip }, () => {
  const amb = ambiente({ behavior: 'slow', extra: { CCX_FAKE_DELAY_MS: '10000' } });
  const id = despachar(amb, 'tarefa lenta');
  const r = amb.ccx('status', id, '--wait', '--timeout-ms', '600', '--json');
  assert.equal(r.code, EXIT.TIMEOUT, `esperava tempo esgotado, veio ${r.code}: ${r.stdout}${r.stderr}`);
  amb.ccx('stop', id);
});

test('a espera retorna assim que o turno fecha', { skip }, () => {
  const amb = ambiente({ behavior: 'slow', extra: { CCX_FAKE_DELAY_MS: '500' } });
  const id = despachar(amb, 'tarefa lenta');
  const r = amb.json('status', id, '--wait', '--timeout-ms', '20000', '--json');
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  assert.equal(r.json.state.status, STATUS.DONE);
});

// ---------------------------------------------------------------------------
// Recusas
// ---------------------------------------------------------------------------

test('responder sem pergunta pendente e recusado com estado incompativel', { skip }, async () => {
  // Sem esta recusa, `answer` viraria um `say` disfarcado e o orquestrador
  // perderia o sinal de que estava respondendo a coisa nenhuma.
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  const estado = await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const r = amb.ccx('answer', id, 'resposta para pergunta que nao existe');
  assert.equal(r.code, EXIT.BAD_STATE, `esperava recusa, veio ${r.code}`);
  const msg = r.stdout + r.stderr;
  assert.ok(msg.includes(estado.status), `a mensagem precisa dizer qual e o estado atual: ${msg}`);
});

test('responder duas vezes a mesma pergunta e recusado na segunda', { skip }, async () => {
  const amb = ambiente({ behavior: 'ask-then-done' });
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.ASKING);

  assert.equal(amb.ccx('answer', id, 'mantenha o v1').code, EXIT.OK);
  await esperar(amb, id, (s) => s.status !== STATUS.ASKING);
  assert.equal(amb.ccx('answer', id, 'de novo').code, EXIT.BAD_STATE);
});

test('remover sessao viva e recusado, e a forca permite', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const recusa = amb.ccx('rm', id);
  assert.equal(recusa.code, EXIT.BAD_STATE, `esperava recusa, veio ${recusa.code}: ${recusa.stdout}`);

  assert.equal(amb.ccx('rm', id, '--force').code, EXIT.OK);
  assert.equal(amb.ccx('status', id).code, EXIT.NO_SESSION);
});

test('remover sessao ja encerrada nao precisa de forca', { skip }, async () => {
  const amb = ambiente({ behavior: 'crash' });
  const id = despachar(amb, 'investigue');
  await esperar(amb, id, (s) => s.status === STATUS.FAILED);
  assert.equal(amb.ccx('rm', id).code, EXIT.OK);
});

test('referencia de sessao ambigua e recusada com erro de uso', { skip }, async () => {
  const amb = ambiente();
  const a = despachar(amb, 'tarefa a');
  const b = despachar(amb, 'tarefa b');
  await esperar(amb, a, (s) => s.status === STATUS.DONE);
  await esperar(amb, b, (s) => s.status === STATUS.DONE);

  // Prefixo de um caractere que casa com as duas sessoes, se houver.
  const comum = [...a].find((ch, i) => a[i] === b[i]);
  if (!comum || a[0] !== b[0]) {
    // Ids sorteados nao colidiram no primeiro caractere. Forca o caso com
    // rotulo duplicado, que e o outro caminho de ambiguidade.
    const amb2 = ambiente();
    despachar(amb2, 'x', '--label', 'mesmo-rotulo');
    despachar(amb2, 'y', '--label', 'mesmo-rotulo');
    const r = amb2.ccx('status', 'mesmo-rotulo');
    assert.equal(r.code, EXIT.USAGE, `esperava ambiguidade, veio ${r.code}: ${r.stdout}${r.stderr}`);
    return;
  }
  const r = amb.ccx('status', a[0]);
  assert.equal(r.code, EXIT.USAGE, `esperava ambiguidade, veio ${r.code}: ${r.stdout}${r.stderr}`);
});

test('sessao inexistente e recusada com sessao nao encontrada', { skip }, () => {
  const amb = ambiente();
  for (const cmd of [['status', 'naoexiste'], ['result', 'naoexiste'], ['log', 'naoexiste'], ['say', 'naoexiste', 'oi']]) {
    const r = amb.ccx(...cmd);
    assert.equal(r.code, EXIT.NO_SESSION, `${cmd[0]} devolveu ${r.code}`);
  }
});

test('subcomando desconhecido e erro de uso', { skip }, () => {
  const amb = ambiente();
  assert.equal(amb.ccx('inventado').code, EXIT.USAGE);
});

test('opcao desconhecida nao vaza para a tarefa despachada', { skip }, () => {
  // O defeito medido no plugin oficial: um --wait esquecido cai nos
  // positionais e vaza literalmente para dentro do prompt do modelo.
  const amb = ambiente();
  const antes = readFakeState(amb.fakeState)?.spawns ?? 0;
  const r = amb.ccxCru('dispatch', '--task', 'refatore auth', '--wait');
  assert.equal(r.code, EXIT.USAGE, `--wait deveria ser recusado, veio ${r.code}`);
  assert.equal(readFakeState(amb.fakeState)?.spawns ?? 0, antes, 'a recusa de argumento nao pode spawnar nada');
});

// ---------------------------------------------------------------------------
// Encerramento
// ---------------------------------------------------------------------------

test('parar e idempotente e preserva os arquivos da sessao', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  assert.equal(amb.ccx('stop', id).code, EXIT.OK);
  await esperar(amb, id, (s) => s.alive === false);
  assert.equal(amb.ccx('stop', id).code, EXIT.OK, 'parar de novo deveria devolver zero');

  assert.equal(amb.ccx('result', id).code, EXIT.OK, 'os arquivos precisam sobreviver ao stop');
});

test('a listagem mostra as sessoes conhecidas', { skip }, async () => {
  const amb = ambiente();
  const id = despachar(amb, 'refatore auth', '--label', 'refactor-auth');
  await esperar(amb, id, (s) => s.status === STATUS.DONE);

  const r = amb.json('ls', '--json', '--all');
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  const sessoes = r.json.sessions ?? [];
  assert.ok(sessoes.some((s) => s.id === id), `a sessao nao apareceu na listagem: ${r.stdout}`);
});
