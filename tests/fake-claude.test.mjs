// Testes do proprio Claude falso.
//
// Um fixture errado produz testes que passam contra um protocolo que nao
// existe, que e pior que nao ter teste. Este arquivo fixa a superficie de
// eventos que o resto do conjunto assume, e nao depende de nenhum modulo de
// `src/` alem do protocolo, entao roda sempre.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SENTINELS, STATUS, classifyTurn } from '../src/protocol.mjs';
import {
  BEHAVIORS,
  DEFAULT_BEHAVIOR,
  FAKE_SESSION_ID,
  FAKE_VERSION,
  buildEnv,
  installFakeClaude,
  isControl,
  readFakeState,
  runFake,
  selectBehavior,
  sessionScript,
} from './fake-claude.mjs';

function tempDir(prefix = 'ccx-fake-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const resultados = (events) => events.filter((ev) => ev.type === 'result');
const inits = (events) => events.filter((ev) => ev.type === 'system' && ev.subtype === 'init');

// ---------------------------------------------------------------------------
// Cobertura de comportamentos
// ---------------------------------------------------------------------------

test('o fixture cobre os nove comportamentos exigidos pela spec', () => {
  const exigidos = [
    'done', 'ask-then-done', 'blocked', 'no-marker', 'denials',
    'crash', 'slow', 'multi-turn', 'bad-json',
  ];
  for (const nome of exigidos) {
    assert.ok(Object.hasOwn(BEHAVIORS, nome), `comportamento ausente: ${nome}`);
    assert.equal(typeof BEHAVIORS[nome].turn, 'function');
    assert.equal(typeof BEHAVIORS[nome].describe, 'string');
  }
});

test('todo comportamento emite a sequencia que o Claude real emite', () => {
  for (const nome of Object.keys(BEHAVIORS)) {
    const { events } = sessionScript({ behavior: nome, prompts: ['tarefa'] });
    const primeiroInit = events.findIndex((ev) => ev.type === 'system' && ev.subtype === 'init');
    assert.ok(primeiroInit >= 0, `${nome} nao emitiu init`);

    // Os eventos de hook vem ANTES do init. Foi assim que a sondagem mediu.
    const hooks = events.slice(0, primeiroInit).filter((ev) => ev.subtype === 'hook_started' || ev.subtype === 'hook_response');
    assert.ok(hooks.length >= 2, `${nome} nao emitiu hook antes do init`);

    for (const ev of events) {
      assert.equal(typeof ev.type, 'string', `${nome} emitiu evento sem type`);
      assert.equal(typeof ev.uuid, 'string', `${nome} emitiu evento sem uuid`);
      assert.equal(ev.session_id, FAKE_SESSION_ID, `${nome} emitiu evento com session_id errado`);
    }
  }
});

test('todo evento de assistente traz content como array de blocos', () => {
  for (const nome of Object.keys(BEHAVIORS)) {
    const { events } = sessionScript({ behavior: nome, prompts: ['t'] });
    for (const ev of events.filter((e) => e.type === 'assistant')) {
      assert.ok(Array.isArray(ev.message.content), `${nome}: content nao e array`);
      for (const bloco of ev.message.content) {
        assert.ok(['text', 'tool_use'].includes(bloco.type), `${nome}: bloco ${bloco.type}`);
        if (bloco.type === 'tool_use') {
          assert.equal(typeof bloco.name, 'string');
          assert.equal(typeof bloco.id, 'string');
          assert.equal(typeof bloco.input, 'object');
        }
      }
    }
  }
});

test('todo resultado de ferramenta traz tool_result com is_error booleano', () => {
  const { events } = sessionScript({ behavior: 'blocked', prompts: ['t'] });
  const users = events.filter((ev) => ev.type === 'user');
  assert.ok(users.length >= 2);
  for (const ev of users) {
    for (const bloco of ev.message.content) {
      assert.equal(bloco.type, 'tool_result');
      assert.equal(typeof bloco.is_error, 'boolean');
      assert.equal(typeof bloco.tool_use_id, 'string');
    }
  }
});

test('o evento de resultado traz todos os campos que o supervisor le', () => {
  const { events } = sessionScript({ behavior: 'done', prompts: ['t'] });
  const [res] = resultados(events);
  for (const campo of [
    'result', 'subtype', 'is_error', 'num_turns', 'total_cost_usd',
    'stop_reason', 'permission_denials', 'duration_ms', 'session_id', 'uuid',
  ]) {
    assert.ok(Object.hasOwn(res, campo), `o resultado nao traz ${campo}`);
  }
  assert.equal(typeof res.is_error, 'boolean');
  assert.ok(Array.isArray(res.permission_denials));
});

// ---------------------------------------------------------------------------
// Cada desfecho, conferido contra a classificacao real
// ---------------------------------------------------------------------------

test('o comportamento de conclusao produz um turno que classifica como concluido', () => {
  const { events } = sessionScript({ behavior: 'done', prompts: ['t'] });
  assert.equal(classifyTurn(resultados(events)[0].result).status, STATUS.DONE);
});

test('o comportamento de bloqueio produz um turno que classifica como bloqueado', () => {
  const { events } = sessionScript({ behavior: 'blocked', prompts: ['t'] });
  assert.equal(classifyTurn(resultados(events)[0].result).status, STATUS.BLOCKED);
});

test('o comportamento de pergunta pergunta no primeiro turno e conclui no segundo', () => {
  const { turns } = sessionScript({ behavior: 'ask-then-done', prompts: ['tarefa', 'mantenha o v1'] });
  const primeiro = classifyTurn(turns[0].at(-1).result);
  const segundo = classifyTurn(turns[1].at(-1).result);
  assert.equal(primeiro.status, STATUS.ASKING);
  assert.ok(primeiro.question.length > 0);
  assert.equal(segundo.status, STATUS.DONE);
});

test('o segundo turno enxerga o texto da resposta do orquestrador', () => {
  const { turns } = sessionScript({ behavior: 'ask-then-done', prompts: ['tarefa', 'mantenha o v1'] });
  assert.match(turns[1].at(-1).result, /mantenha o v1/);
});

test('o comportamento sem marcador nao carrega marcador nenhum e da ambiguo', () => {
  const { events } = sessionScript({ behavior: 'no-marker', prompts: ['t'] });
  const texto = resultados(events)[0].result;
  for (const marcador of Object.values(SENTINELS)) {
    assert.ok(!texto.includes(marcador), `o fixture vazou o marcador ${marcador}`);
  }
  // Traz uma pergunta em prosa, que e o comportamento real medido, e ainda
  // assim precisa dar ambiguo e nao espera de resposta.
  assert.match(texto, /\?/);
  assert.equal(classifyTurn(texto).status, STATUS.AMBIGUOUS);
});

test('o comportamento de negacao preenche a lista de negacoes e marca erro na ferramenta', () => {
  const { events } = sessionScript({ behavior: 'denials', prompts: ['t'] });
  const [res] = resultados(events);
  assert.equal(res.permission_denials.length, 3);
  for (const d of res.permission_denials) {
    assert.equal(typeof d.tool_name, 'string');
    assert.equal(typeof d.tool_use_id, 'string');
    assert.equal(typeof d.tool_input, 'object');
  }

  const comErro = events.filter((ev) => ev.type === 'user' && ev.message.content.some((b) => b.is_error));
  assert.equal(comErro.length, 3, 'cada negacao precisa devolver resultado de ferramenta com erro');

  const negados = events.filter((ev) => ev.subtype === 'permission_denied');
  assert.equal(negados.length, 3, 'a negacao tambem aparece como evento de sistema durante o fluxo');
});

test('a negacao de NotebookEdit usa notebook_path, nao file_path', () => {
  const { events } = sessionScript({ behavior: 'denials', prompts: ['t'] });
  const d = resultados(events)[0].permission_denials.find((x) => x.tool_name === 'NotebookEdit');
  assert.ok(Object.hasOwn(d.tool_input, 'notebook_path'));
});

// ---------------------------------------------------------------------------
// Execucao como processo
// ---------------------------------------------------------------------------

test('responde --version como o binario real', async () => {
  const r = await runFake({ args: ['--version'] });
  assert.equal(r.exitCode, 0);
  assert.equal(r.lines.join('').trim(), FAKE_VERSION);
});

test('a ajuda cita as flags que o supervisor usa e nenhuma das flags inexistentes', async () => {
  const r = await runFake({ args: ['--help'] });
  const ajuda = r.lines.join('\n');
  for (const flag of ['-p', '--input-format', '--output-format', '--verbose', '--permission-mode', '--settings', '--strict-mcp-config', '--tools', '--append-system-prompt']) {
    assert.ok(ajuda.includes(flag), `a ajuda nao cita ${flag}`);
  }
  // Secao 3.2 da spec: estas tres nao existem nesta versao e nao podem
  // aparecer nem no fixture, para nao induzir o codigo ao erro.
  for (const flag of ['--allow-tools', '--max-turns', '--max-cost-usd']) {
    assert.ok(!ajuda.includes(flag), `a ajuda cita a flag inexistente ${flag}`);
  }
});

test('um turno real pelo stdin devolve a sequencia completa e fecha com resultado', async () => {
  const r = await runFake({ behavior: 'done', prompts: ['refatore auth'] });
  assert.equal(r.exitCode, 0);
  assert.equal(r.badLines.length, 0);
  assert.equal(resultados(r.events).length, 1);
  assert.equal(r.events[0].subtype, 'hook_started');
  assert.equal(r.events.at(-1).type, 'result');
});

test('o processo fica vivo entre turnos e o identificador de sessao nao muda', async () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'estado.json');
  const r = await runFake({
    behavior: 'multi-turn',
    prompts: ['parte 1', 'parte 2', 'parte 3'],
    statePath,
  });

  assert.equal(resultados(r.events).length, 3, 'faltou turno');
  assert.equal(inits(r.events).length, 3, 'o init precisa chegar em cada turno');
  assert.equal(new Set(inits(r.events).map((ev) => ev.session_id)).size, 1, 'o identificador de sessao mudou');

  const estado = readFakeState(statePath);
  assert.equal(estado.spawns, 1, 'o Claude foi respawnado em vez de reusado');
  assert.equal(estado.turns.length, 3);
  assert.equal(new Set(estado.sessions).size, 1);
});

test('o turno seguinte recebe o texto que o orquestrador mandou', async () => {
  const r = await runFake({ behavior: 'multi-turn', prompts: ['primeira', 'segunda'] });
  const textos = resultados(r.events).map((ev) => ev.result);
  assert.match(textos[0], /primeira/);
  assert.match(textos[1], /segunda/);
});

test('o processo morre no meio do turno sem emitir resultado', async () => {
  const r = await runFake({ behavior: 'crash', prompts: ['investigue o bug'] });
  assert.equal(resultados(r.events).length, 0, 'nao pode haver resultado neste caso');
  assert.notEqual(r.exitCode, 0, 'a morte precisa ter codigo de saida diferente de zero');
  assert.ok(inits(r.events).length === 1, 'o turno chegou a comecar antes de morrer');
});

test('linha nao JSON no meio da saida nao interrompe o fluxo', async () => {
  const r = await runFake({ behavior: 'bad-json', prompts: ['t'] });
  assert.ok(r.badLines.length >= 2, `esperava lixo na saida, achei ${r.badLines.length}`);
  assert.equal(resultados(r.events).length, 1, 'o turno precisa fechar apesar do lixo');
  assert.equal(classifyTurn(resultados(r.events)[0].result).status, STATUS.DONE);
});

test('o turno lento respeita o atraso configurado', async () => {
  const inicio = Date.now();
  const r = await runFake({ behavior: 'slow', prompts: ['t'], env: { CCX_FAKE_DELAY_MS: '400' }, timeoutMs: 15000 });
  const decorrido = Date.now() - inicio;
  assert.equal(resultados(r.events).length, 1);
  assert.ok(decorrido >= 350, `terminou rapido demais: ${decorrido}ms`);
});

test('o turno lento pode ser interrompido antes de fechar', async () => {
  // Exercita o caminho de prazo estourado: o supervisor que espera menos que
  // o turno precisa ver o processo ir embora, e nao um resultado tardio.
  await assert.rejects(
    () => runFake({ behavior: 'slow', prompts: ['t'], env: { CCX_FAKE_DELAY_MS: '8000' }, timeoutMs: 600 }),
    /prazo de 600ms/,
  );
});

test('o estado persistido registra a linha de comando recebida', async () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'estado.json');
  await runFake({
    behavior: 'done',
    prompts: ['t'],
    statePath,
    args: [],
  });
  const estado = readFakeState(statePath);
  assert.equal(estado.behavior, 'done');
  assert.equal(typeof estado.pid, 'number');
  assert.ok(Array.isArray(estado.argv));
});

test('readFakeState devolve nulo quando o Claude falso nunca rodou', () => {
  const dir = tempDir();
  assert.equal(readFakeState(path.join(dir, 'nao-existe.json')), null);
});

// ---------------------------------------------------------------------------
// Selecao de comportamento
// ---------------------------------------------------------------------------

test('o comportamento vem do ambiente quando nao ha argumento', () => {
  const out = selectBehavior(['-p', '--verbose'], { CCX_FAKE_BEHAVIOR: 'blocked' });
  assert.equal(out.behavior, 'blocked');
  assert.deepEqual(out.argv, ['-p', '--verbose']);
});

test('o argumento explicito vence o ambiente e sai de argv', () => {
  const out = selectBehavior(['--fake-behavior=denials', '-p'], { CCX_FAKE_BEHAVIOR: 'done' });
  assert.equal(out.behavior, 'denials');
  assert.deepEqual(out.argv, ['-p'], 'o argumento do fixture vazou para a linha de comando do Claude');
});

test('a forma separada do argumento tambem funciona', () => {
  const out = selectBehavior(['--fake-behavior', 'slow', '-p'], {});
  assert.equal(out.behavior, 'slow');
  assert.deepEqual(out.argv, ['-p']);
});

test('sem argumento e sem ambiente cai no padrao', () => {
  assert.equal(selectBehavior([], {}).behavior, DEFAULT_BEHAVIOR);
});

test('comportamento desconhecido falha alto, em vez de rodar o padrao em silencio', () => {
  assert.throws(() => selectBehavior([], { CCX_FAKE_BEHAVIOR: 'inexistente' }), /desconhecido/);
});

// ---------------------------------------------------------------------------
// Instalacao dos wrappers
// ---------------------------------------------------------------------------

test('installFakeClaude grava os wrappers das duas plataformas', () => {
  const dir = tempDir();
  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  for (const p of [install.cmdPath, install.posixPath, install.launcherPath]) {
    assert.ok(fs.existsSync(p), `faltou ${p}`);
  }
  assert.match(fs.readFileSync(install.cmdPath, 'utf8'), /claude-fake-launcher\.mjs/);
  assert.match(fs.readFileSync(install.posixPath, 'utf8'), /^#!\/bin\/sh/);
});

test('o launcher gerado importa o fixture por URL absoluta', () => {
  const dir = tempDir();
  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  const fonte = fs.readFileSync(install.launcherPath, 'utf8');
  assert.match(fonte, /^import \{ main \} from "file:\/\/\//m);
});

test('buildEnv aponta o binario e o comportamento, e preserva o PATH', () => {
  const dir = tempDir();
  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  const env = buildEnv({
    install,
    behavior: 'no-marker',
    stateDir: path.join(dir, 'estado'),
    base: { PATH: '/ja/existia' },
  });
  assert.equal(env.CCX_FAKE_BEHAVIOR, 'no-marker');
  assert.equal(env.CCX_STATE_DIR, path.join(dir, 'estado'));
  assert.ok(env.PATH.startsWith(install.binDir), 'o diretorio do fixture precisa vir primeiro');
  assert.ok(env.PATH.includes('/ja/existia'), 'o PATH anterior foi descartado');
});

test('por padrao o binario apontado e este proprio .mjs, sem envelope de plataforma', () => {
  // Um envelope de lote trunca o contrato de sentinela e faria todo turno
  // voltar ambiguo. Apontar o script e o caminho portatil, igual nas tres
  // plataformas, e e o que o supervisor sabe spawnar com o proprio Node.
  const dir = tempDir();
  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  const env = buildEnv({ install });
  assert.equal(env.CCX_CLAUDE_BIN, install.scriptPath);
  assert.match(env.CCX_CLAUDE_BIN, /fake-claude\.mjs$/);
});

test('buildEnv permite escolher o wrapper explicitamente', () => {
  const dir = tempDir();
  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  assert.equal(buildEnv({ install, strategy: 'script' }).CCX_CLAUDE_BIN, install.scriptPath);
  assert.equal(buildEnv({ install, strategy: 'cmd' }).CCX_CLAUDE_BIN, install.cmdPath);
  assert.equal(buildEnv({ install, strategy: 'posix' }).CCX_CLAUDE_BIN, install.posixPath);
  assert.equal(buildEnv({ install, strategy: 'launcher' }).CCX_CLAUDE_BIN, install.launcherPath);
});

// ---------------------------------------------------------------------------
// Uso como biblioteca pura
// ---------------------------------------------------------------------------

test('sessionScript nao devolve marcador de controle por padrao', () => {
  const { events } = sessionScript({ behavior: 'crash', prompts: ['t'] });
  assert.ok(events.every((ev) => !isControl(ev)));
});

test('sessionScript devolve os marcadores de controle quando pedido', () => {
  const { events } = sessionScript({ behavior: 'crash', prompts: ['t'], includeControl: true });
  assert.ok(events.some((ev) => typeof ev.__exit === 'number'));
  assert.ok(events.some((ev) => typeof ev.__raw === 'string'));
});

test('um comportamento que mata o processo nao produz turno seguinte', () => {
  const { turns } = sessionScript({ behavior: 'crash', prompts: ['a', 'b', 'c'] });
  assert.equal(turns.length, 1);
});

test('sessionScript e deterministico entre execucoes', () => {
  const a = sessionScript({ behavior: 'done', prompts: ['t'] }).events;
  const b = sessionScript({ behavior: 'done', prompts: ['t'] }).events;
  assert.deepEqual(a, b);
});

test('os identificadores de uso de ferramenta sao unicos dentro da sessao', () => {
  const { events } = sessionScript({ behavior: 'many-files', prompts: ['t'] });
  const ids = events
    .filter((ev) => ev.type === 'assistant')
    .flatMap((ev) => ev.message.content.filter((b) => b.type === 'tool_use').map((b) => b.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('os uuid de evento sao unicos dentro da sessao', () => {
  const { events } = sessionScript({ behavior: 'many-files', prompts: ['t'] });
  const uuids = events.map((ev) => ev.uuid);
  assert.equal(new Set(uuids).size, uuids.length);
});
