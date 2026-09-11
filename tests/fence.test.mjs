// A cerca de diretorio.
//
// A cerca e defesa em profundidade, nao fronteira: a ferramenta de shell
// pode contorna-la, e isso esta declarado na skill e no README. O que estes
// testes protegem e o que ela DE FATO promete: nenhuma gravacao por caminho
// escapa por prefixo, e a decisao de permitir nunca e emitida, porque no
// formato de hook do Claude Code permitir significa pular o fluxo normal de
// permissao, o que escalaria privilegio em vez de conter.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

let fenceMod = null;
let ausente = null;
try {
  fenceMod = await import('../src/fence.mjs');
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  ausente = err;
}
const skip = ausente ? `src/fence.mjs ainda nao existe: ${ausente.message}` : false;

const R = (...partes) => path.resolve(path.join(...partes));
const RAIZ = R('C:', 'proj');

// ---------------------------------------------------------------------------
// isInside
// ---------------------------------------------------------------------------

test('o proprio diretorio declarado esta dentro', { skip }, () => {
  assert.equal(fenceMod.isInside(RAIZ, RAIZ), true);
});

test('descendente esta dentro, em qualquer profundidade', { skip }, () => {
  assert.equal(fenceMod.isInside(RAIZ, R('C:', 'proj', 'src', 'a.ts')), true);
  assert.equal(fenceMod.isInside(RAIZ, R('C:', 'proj', 'a', 'b', 'c', 'd.ts')), true);
});

test('diretorio irmao com nome que comeca igual NAO passa por prefixo', { skip }, () => {
  // O caso que a comparacao ingenua de prefixo erra. Sem a exigencia de
  // separador na fronteira, C:\proj-outro passaria por ser descendente de
  // C:\proj, e a cerca deixaria escrever no repositorio errado.
  assert.equal(fenceMod.isInside(RAIZ, R('C:', 'proj-outro', 'src', 'a.ts')), false);
  assert.equal(fenceMod.isInside(RAIZ, R('C:', 'projX')), false);
  assert.equal(fenceMod.isInside(RAIZ, R('C:', 'proj2', 'a.ts')), false);
});

test('diretorio acima esta fora', { skip }, () => {
  assert.equal(fenceMod.isInside(RAIZ, R('C:')), false);
  assert.equal(fenceMod.isInside(RAIZ, R('C:', 'outro', 'x.ts')), false);
});

test('travessia por ponto ponto nao escapa, porque o caminho e resolvido antes', { skip }, () => {
  const alvo = path.resolve(RAIZ, '..', 'outro', 'x.ts');
  assert.equal(fenceMod.isInside(RAIZ, alvo), false);
});

test('no Windows a comparacao ignora caixa, porque o sistema de arquivos ignora', { skip: skip || process.platform !== 'win32' }, () => {
  assert.equal(fenceMod.isInside('C:\\Proj', 'c:\\proj\\src\\a.ts'), true);
  assert.equal(fenceMod.isInside('C:\\Proj', 'C:\\PROJ-OUTRO\\a.ts'), false);
});

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

test('gravacao dentro do diretorio nao e negada', { skip }, () => {
  const out = fenceMod.decide({
    root: RAIZ,
    toolName: 'Write',
    toolInput: { file_path: R('C:', 'proj', 'src', 'novo.ts') },
  });
  assert.equal(out.deny, false);
});

test('gravacao fora do diretorio e negada, com o caminho no motivo', { skip }, () => {
  const alvo = R('C:', 'fora', 'x.ts');
  const out = fenceMod.decide({ root: RAIZ, toolName: 'Write', toolInput: { file_path: alvo } });
  assert.equal(out.deny, true);
  assert.ok(out.reason && out.reason.length > 0, 'negar sem motivo e inutil para o orquestrador');
  assert.ok(out.reason.includes('x.ts'), `o motivo precisa dizer o caminho: ${out.reason}`);
});

test('as tres ferramentas de escrita estao cercadas', { skip }, () => {
  const casos = [
    ['Write', { file_path: R('C:', 'fora', 'a.ts') }],
    ['Edit', { file_path: R('C:', 'fora', 'b.ts') }],
    ['NotebookEdit', { notebook_path: R('C:', 'fora', 'c.ipynb') }],
  ];
  for (const [toolName, toolInput] of casos) {
    assert.equal(fenceMod.decide({ root: RAIZ, toolName, toolInput }).deny, true, `${toolName} passou`);
  }
});

test('ferramenta de leitura nao e negada pela cerca', { skip }, () => {
  const out = fenceMod.decide({
    root: RAIZ,
    toolName: 'Read',
    toolInput: { file_path: R('C:', 'fora', 'a.ts') },
  });
  assert.equal(out.deny, false);
});

test('a ferramenta de shell nao e negada pela cerca, e isso e declarado', { skip }, () => {
  // Limite honesto: a cerca cobre ferramentas cujos argumentos carregam
  // caminho. Analisar linha de comando de shell para decidir isso e problema
  // de seguranca mal posto, e uma lista de padroes daria falsa confianca.
  const out = fenceMod.decide({
    root: RAIZ,
    toolName: 'Bash',
    toolInput: { command: `echo oi > ${R('C:', 'fora', 'x.txt')}` },
  });
  assert.equal(out.deny, false);
});

test('caminho relativo e resolvido contra o diretorio declarado', { skip }, () => {
  assert.equal(fenceMod.decide({ root: RAIZ, toolName: 'Write', toolInput: { file_path: 'src/a.ts' } }).deny, false);
  assert.equal(fenceMod.decide({ root: RAIZ, toolName: 'Write', toolInput: { file_path: '../fora/a.ts' } }).deny, true);
});

test('sem diretorio declarado a cerca fica inativa em vez de inventar um raio', { skip }, () => {
  const out = fenceMod.decide({ root: null, toolName: 'Write', toolInput: { file_path: R('C:', 'fora', 'a.ts') } });
  assert.equal(out.deny, false);
  assert.ok(out.note, 'a inatividade precisa ficar registrada');
});

test('chamada sem campo de caminho reconhecido nao e negada, e fica registrada', { skip }, () => {
  const out = fenceMod.decide({ root: RAIZ, toolName: 'Write', toolInput: { conteudo: 'sem caminho' } });
  assert.equal(out.deny, false);
  assert.ok(out.note);
});

test('em duvida a cerca permite, porque negar por engano trava a tarefa', { skip }, () => {
  for (const toolInput of [null, undefined, {}, { file_path: '' }, { file_path: '   ' }]) {
    const out = fenceMod.decide({ root: RAIZ, toolName: 'Write', toolInput });
    assert.equal(out.deny, false, `negou em duvida para ${JSON.stringify(toolInput)}`);
  }
});

test('a cerca NUNCA emite decisao de permitir', { skip }, () => {
  // Permitir, no formato de hook, significa pular o fluxo normal de
  // permissao. Isso escalaria privilegio em vez de conter, entao o caso
  // permitido sai calado.
  const casos = [
    { root: RAIZ, toolName: 'Write', toolInput: { file_path: R('C:', 'proj', 'a.ts') } },
    { root: RAIZ, toolName: 'Read', toolInput: { file_path: R('C:', 'fora', 'a.ts') } },
    { root: null, toolName: 'Write', toolInput: { file_path: R('C:', 'fora', 'a.ts') } },
  ];
  for (const caso of casos) {
    const out = fenceMod.decide(caso);
    assert.equal(out.deny, false);
    assert.ok(!('allow' in out) || out.allow !== true, 'a cerca emitiu permissao explicita');
  }
});
