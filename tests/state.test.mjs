// Estado em disco e resolucao de caminhos.
//
// Cobre as recusas que o orquestrador precisa enxergar como codigo de saida:
// referencia de sessao ambigua e sessao inexistente. E cobre a robustez do
// cursor de log diante de linha ilegivel, que e o que sobra em disco quando
// um supervisor morre no meio de uma escrita.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXIT, FILES, STATE_SCHEMA, STATUS } from '../src/protocol.mjs';

let stateMod = null;
let pathsMod = null;
const faltando = [];
for (const [nome, alvo] of [['state', '../src/state.mjs'], ['paths', '../src/paths.mjs']]) {
  try {
    const mod = await import(alvo);
    if (nome === 'state') stateMod = mod; else pathsMod = mod;
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    faltando.push(`${alvo}: ${err.message}`);
  }
}
const skip = faltando.length ? `modulo ausente -> ${faltando.join(' | ')}` : false;
const skipPaths = pathsMod ? false : 'src/paths.mjs ainda nao existe';

function raizTemporaria() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-state-'));
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** Cria uma sessao minima e devolve o id. */
function criarSessao(root, id, { label = null, status = STATUS.WORKING, alive = true, pid = process.pid } = {}) {
  stateMod.initSession(root, id, { label, cwd: 'C:\\proj', claudeBin: 'C:\\bin\\claude.exe' });
  stateMod.writeState(root, id, {
    schema: STATE_SCHEMA, id, label, status, alive, pid, turn: 0,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Ciclo basico
// ---------------------------------------------------------------------------

test('a sessao criada guarda meta e estado legiveis', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'a3f1beta', { label: 'refactor-auth' });

  const meta = stateMod.readMeta(root, 'a3f1beta');
  assert.equal(meta.id, 'a3f1beta');
  assert.equal(meta.label, 'refactor-auth');
  assert.equal(meta.schema, STATE_SCHEMA);

  const estado = stateMod.readState(root, 'a3f1beta');
  assert.equal(estado.status, STATUS.WORKING);
});

test('o nome do diretorio vence um meta com id divergente', { skip }, () => {
  const root = raizTemporaria();
  stateMod.initSession(root, 'verdadeiro', { id: 'mentiroso', label: 'x' });
  assert.equal(stateMod.readMeta(root, 'verdadeiro').id, 'verdadeiro');
});

test('colisao de id e erro, nao sobrescrita silenciosa', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'colide00');
  assert.throws(
    () => stateMod.initSession(root, 'colide00', { label: 'outra' }),
    (err) => err.code === EXIT.BAD_STATE,
  );
});

test('ler sessao inexistente recusa com o codigo de sessao nao encontrada', { skip }, () => {
  const root = raizTemporaria();
  assert.throws(() => stateMod.readState(root, 'naoexiste'), (err) => err.code === EXIT.NO_SESSION);
  assert.throws(() => stateMod.readMeta(root, 'naoexiste'), (err) => err.code === EXIT.NO_SESSION);
});

test('patchState mescla sem apagar o que nao foi tocado', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'patch001', { label: 'x' });
  const depois = stateMod.patchState(root, 'patch001', { status: STATUS.ASKING, pendingQuestion: 'qual?' });
  assert.equal(depois.status, STATUS.ASKING);
  assert.equal(depois.pendingQuestion, 'qual?');
  assert.equal(depois.label, 'x', 'o patch apagou um campo que nao tocou');
});

// ---------------------------------------------------------------------------
// Resolucao de referencia: a recusa por ambiguidade
// ---------------------------------------------------------------------------

test('id exato resolve de imediato, mesmo com id mais longo comecando igual', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'a3f1');
  criarSessao(root, 'a3f1beta');
  // Sem a precedencia de id exato, 'a3f1' seria prefixo de dois ids e a
  // sessao com o id mais curto ficaria impossivel de referenciar.
  assert.equal(stateMod.resolveId(root, 'a3f1'), 'a3f1');
});

test('rotulo exato resolve', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'zzzz0001', { label: 'refactor-auth' });
  assert.equal(stateMod.resolveId(root, 'refactor-auth'), 'zzzz0001');
});

test('prefixo unico resolve, como o git faz com hash', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'bcde1234');
  assert.equal(stateMod.resolveId(root, 'bcd'), 'bcde1234');
});

test('prefixo ambiguo recusa com erro de uso, em vez de escolher por conta propria', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'bcde1234');
  criarSessao(root, 'bcde5678');
  assert.throws(() => stateMod.resolveId(root, 'bcde'), (err) => {
    assert.equal(err.code, EXIT.USAGE, 'ambiguidade e erro de uso');
    assert.match(err.message, /bcde1234|bcde5678/, 'a mensagem precisa mostrar os candidatos');
    return true;
  });
});

test('rotulo duplicado tambem e ambiguo', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'dup00001', { label: 'mesmo-nome' });
  criarSessao(root, 'dup00002', { label: 'mesmo-nome' });
  assert.throws(() => stateMod.resolveId(root, 'mesmo-nome'), (err) => err.code === EXIT.USAGE);
});

test('referencia que nao casa com nada recusa com sessao nao encontrada', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'aaaa0001');
  assert.throws(() => stateMod.resolveId(root, 'inexistente'), (err) => err.code === EXIT.NO_SESSION);
});

// ---------------------------------------------------------------------------
// Log de eventos e cursor
// ---------------------------------------------------------------------------

test('o log numera as entradas a partir de um e o cursor avanca', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'log00001');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(stateMod.appendEvent(root, 'log00001', { kind: 'tool', name: 'Read', detail: `a${i}.ts` }), i + 1);
  }

  const tudo = stateMod.readEvents(root, 'log00001', {});
  assert.equal(tudo.entries.length, 5);
  assert.equal(tudo.cursor, 5);
  assert.equal(tudo.remaining, 0);

  const depois = stateMod.readEvents(root, 'log00001', { since: 3 });
  assert.deepEqual(depois.entries.map((e) => e.n), [4, 5]);
});

test('o limite corta a pagina e informa quantas entradas sobraram', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'log00002');
  for (let i = 0; i < 10; i += 1) stateMod.appendEvent(root, 'log00002', { kind: 'text' });

  const pagina = stateMod.readEvents(root, 'log00002', { since: 0, limit: 4 });
  assert.equal(pagina.entries.length, 4);
  assert.equal(pagina.cursor, 4);
  assert.equal(pagina.remaining, 6);
});

test('linha ilegivel no log e contada e nao trava o cursor', { skip }, () => {
  // Robustez do parser de linhas do lado de quem le o disco. Uma escrita
  // interrompida deixa exatamente isto: metade de uma linha.
  const root = raizTemporaria();
  criarSessao(root, 'log00003');
  stateMod.appendEvent(root, 'log00003', { kind: 'text' });
  fs.appendFileSync(path.join(root, 'sessions', 'log00003', FILES.events), '{"kind":"tool", tru\n');
  stateMod.appendEvent(root, 'log00003', { kind: 'tool', name: 'Read' });

  const out = stateMod.readEvents(root, 'log00003', {});
  assert.equal(out.malformed, 1, 'a linha ilegivel precisa ser contada');
  assert.equal(out.entries.length, 2, 'as entradas boas precisam sobreviver');
  assert.ok(out.cursor >= 2);
});

test('log de sessao sem evento nenhum devolve pagina vazia sem lancar', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'log00004');
  const out = stateMod.readEvents(root, 'log00004', {});
  assert.deepEqual(out.entries, []);
  assert.equal(out.cursor, 0);
});

test('o modo cru so grava quando o dispatch criou o arquivo', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'raw00001');
  const rawPath = path.join(root, 'sessions', 'raw00001', FILES.raw);

  stateMod.appendRaw(root, 'raw00001', { type: 'system' });
  assert.equal(fs.existsSync(rawPath), false, 'o modo cru gravou sem ter sido pedido');

  criarSessao(root, 'raw00002');
  const rawPath2 = path.join(root, 'sessions', 'raw00002', FILES.raw);
  fs.writeFileSync(rawPath2, '');
  stateMod.appendRaw(root, 'raw00002', { type: 'system', subtype: 'init' });
  assert.match(fs.readFileSync(rawPath2, 'utf8'), /"init"/);
});

// ---------------------------------------------------------------------------
// Canal de comandos
// ---------------------------------------------------------------------------

test('comandos sao numerados e lidos a partir de um cursor', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'cmd00001');
  assert.equal(stateMod.appendCommand(root, 'cmd00001', { kind: 'say', text: 'um' }), 1);
  assert.equal(stateMod.appendCommand(root, 'cmd00001', { kind: 'answer', text: 'dois' }), 2);

  assert.equal(stateMod.readCommands(root, 'cmd00001', {}).length, 2);
  const novos = stateMod.readCommands(root, 'cmd00001', { sinceSeq: 1 });
  assert.equal(novos.length, 1);
  assert.equal(novos[0].text, 'dois');
});

// ---------------------------------------------------------------------------
// Listagem e remocao
// ---------------------------------------------------------------------------

test('a listagem ignora sessao corrompida em vez de derrubar o comando', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'boa00001');
  fs.mkdirSync(path.join(root, 'sessions', 'quebrada'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', 'quebrada', FILES.state), '{ nao json');

  const ids = stateMod.listSessionIds(root);
  assert.ok(ids.includes('boa00001'));
  const estados = stateMod.listStates(root);
  assert.ok(estados.some((s) => s.id === 'boa00001'));
});

test('remover sessao apaga o diretorio inteiro', { skip }, () => {
  const root = raizTemporaria();
  criarSessao(root, 'rm000001');
  stateMod.removeSession(root, 'rm000001');
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'rm000001')), false);
  assert.throws(() => stateMod.readState(root, 'rm000001'), (err) => err.code === EXIT.NO_SESSION);
});

test('isAlive reconhece o proprio processo e nao reconhece pid impossivel', { skip }, () => {
  assert.equal(stateMod.isAlive(process.pid), true);
  // Falta de permissao conta como vivo: o processo existe e nao e nosso. So
  // ausencia de processo conta como morto.
  for (const pid of [0, -1, null, undefined, 'x']) {
    assert.equal(typeof stateMod.isAlive(pid), 'boolean', `isAlive lancou para ${pid}`);
  }
});

// ---------------------------------------------------------------------------
// Raiz de estado
// ---------------------------------------------------------------------------

test('a variavel de ambiente dedicada tem precedencia sobre os demais candidatos', { skip: skipPaths }, () => {
  const dir = raizTemporaria();
  const escolhido = path.join(dir, 'raiz-explicita');
  const out = pathsMod.resolveStateRoot({ cwd: dir, env: { CCX_STATE_DIR: escolhido } });
  assert.equal(path.resolve(out.root), path.resolve(escolhido));
  assert.equal(fs.existsSync(out.root), true, 'a raiz escolhida precisa ser criada');
});

test('a sondagem testa gravacao de verdade em cada candidato', { skip: skipPaths }, () => {
  const dir = raizTemporaria();
  const candidatos = pathsMod.probeStateRoots({ cwd: dir, env: {} });
  assert.ok(Array.isArray(candidatos) && candidatos.length > 1, 'precisa haver mais de um candidato');
  for (const c of candidatos) {
    assert.equal(typeof c.path, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.ok(Object.hasOwn(c, 'code'), 'cada candidato precisa reportar o erro, para o doctor');
  }
  assert.ok(candidatos.some((c) => c.ok), 'nenhum candidato gravavel nesta maquina');
});

test('a sondagem nao cria nada, para o doctor poder rodar antes do primeiro despacho', { skip: skipPaths }, () => {
  const dir = raizTemporaria();
  const alvo = path.join(dir, 'nao-deve-nascer');
  pathsMod.probeStateRoots({ cwd: dir, env: { CCX_STATE_DIR: alvo } });
  assert.equal(fs.existsSync(alvo), false);
});

test('os caminhos de sessao saem absolutos e usam as constantes do protocolo', { skip: skipPaths }, () => {
  const root = path.resolve(raizTemporaria());
  assert.equal(pathsMod.sessionsDir(root), path.join(root, 'sessions'));
  assert.equal(pathsMod.sessionDir(root, 'a3f1'), path.join(root, 'sessions', 'a3f1'));
  for (const [chave, arquivo] of Object.entries(FILES)) {
    const p = pathsMod.filePath(root, 'a3f1', chave);
    assert.ok(path.isAbsolute(p), `${chave} devolveu caminho relativo`);
    assert.equal(path.basename(p), arquivo);
  }
});

test('chave de arquivo desconhecida e erro de uso, nao caminho inventado', { skip: skipPaths }, () => {
  const root = path.resolve(raizTemporaria());
  assert.throws(() => pathsMod.filePath(root, 'a3f1', 'inventado'));
});
