// Classificacao de turno, direto contra src/protocol.mjs.
//
// Prioridade um do conjunto de testes. A regra que este arquivo protege e a
// da secao 6.2 da spec: um turno sem marcador nunca e concluido. Tratar
// ausencia de marcador como conclusao transforma uma pergunta real em tarefa
// entregue, que e o pior modo de falha do produto.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SENTINELS,
  STATUS,
  LIMITS,
  LIVE_STATUSES,
  BUSY_STATUSES,
  TERMINAL_STATUSES,
  SYSTEM_CONTRACT,
  STATE_SCHEMA,
  EXIT,
  classifyTurn,
  parseSentinel,
  shorten,
  newId,
  inferPhaseFromCommand,
} from '../src/protocol.mjs';

// ---------------------------------------------------------------------------
// Cada marcador
// ---------------------------------------------------------------------------

test('marcador de conclusao vira estado concluido com o resumo no payload', () => {
  const out = classifyTurn('@@DONE: extrai a rotacao de token para src/auth/rotate.ts');
  assert.equal(out.status, STATUS.DONE);
  assert.equal(out.summary, 'extrai a rotacao de token para src/auth/rotate.ts');
  assert.equal(out.question, null);
  assert.equal(out.reason, null);
});

test('marcador de pergunta vira estado de espera com a pergunta no payload', () => {
  const out = classifyTurn('@@ASK: Devo manter compatibilidade com o token v1?');
  assert.equal(out.status, STATUS.ASKING);
  assert.equal(out.question, 'Devo manter compatibilidade com o token v1?');
  assert.equal(out.summary, null);
});

test('marcador de bloqueio vira estado bloqueado com o motivo no payload', () => {
  const out = classifyTurn('@@BLOCKED: falta DATABASE_URL, tentei .env e .env.example');
  assert.equal(out.status, STATUS.BLOCKED);
  assert.equal(out.reason, 'falta DATABASE_URL, tentei .env e .env.example');
  assert.equal(out.question, null);
});

test('marcador precedido por texto explicativo no mesmo turno ainda classifica', () => {
  const texto = [
    'Li os tres pontos de entrada e apliquei a mudanca.',
    'Rodei a suite e passou.',
    '',
    '@@DONE: Rotacao extraida e coberta por teste.',
  ].join('\n');
  assert.equal(classifyTurn(texto).status, STATUS.DONE);
});

// ---------------------------------------------------------------------------
// Negrito de markdown ao redor do marcador
// ---------------------------------------------------------------------------

test('negrito envolvendo a linha inteira e tolerado e o payload sai limpo', () => {
  const out = classifyTurn('**@@DONE: resumo curto**');
  assert.equal(out.status, STATUS.DONE);
  assert.equal(out.summary, 'resumo curto');
});

test('negrito com tres asteriscos tambem e tolerado', () => {
  const out = classifyTurn('***@@ASK: qual das duas assinaturas mantenho?***');
  assert.equal(out.status, STATUS.ASKING);
  assert.equal(out.question, 'qual das duas assinaturas mantenho?');
});

test('negrito apenas ao redor do marcador classifica, mas deixa asteriscos no payload', () => {
  // Comportamento real de src/protocol.mjs: a limpeza de negrito age nas
  // pontas da linha, nao no interior. A classificacao, que e o que importa
  // para o produto, esta correta. O residuo no payload esta documentado aqui
  // de proposito, para que uma mudanca futura seja uma decisao e nao um
  // acidente.
  const out = classifyTurn('**@@DONE:** resumo curto');
  assert.equal(out.status, STATUS.DONE);
  assert.equal(out.summary, '** resumo curto');
});

// ---------------------------------------------------------------------------
// Marcador no meio nao vence o da ultima linha
// ---------------------------------------------------------------------------

test('marcador citado no meio do texto nao vence o marcador da ultima linha', () => {
  const texto = [
    'No comeco eu ia fechar com @@DONE: mas mudei de ideia.',
    'Preciso de uma decisao antes.',
    '@@ASK: Devo manter compatibilidade com o token v1?',
  ].join('\n');
  const out = classifyTurn(texto);
  assert.equal(out.status, STATUS.ASKING, 'a ultima linha manda');
  assert.equal(out.question, 'Devo manter compatibilidade com o token v1?');
});

test('marcador no meio de uma linha nao e marcador, porque precisa abrir a linha', () => {
  const out = classifyTurn('Talvez eu use @@DONE: mais tarde neste turno.');
  assert.equal(out.status, STATUS.AMBIGUOUS);
});

test('linhas vazias e espaco no fim nao escondem o marcador', () => {
  const out = classifyTurn('@@BLOCKED: falta credencial   \n\n   \n');
  assert.equal(out.status, STATUS.BLOCKED);
  assert.equal(out.reason, 'falta credencial');
});

test('marcador que nao esta na ultima linha ainda e encontrado pela varredura de baixo para cima', () => {
  // Divergencia conhecida: SYSTEM_CONTRACT exige o marcador como ultima
  // linha, mas parseSentinel varre de baixo para cima e aceita um marcador
  // com prosa depois. Isso e tolerancia, nao permissividade: a alternativa
  // seria classificar como ambiguo um turno que de fato declarou conclusao.
  const out = classifyTurn('@@DONE: terminei\nObrigado pela paciencia.');
  assert.equal(out.status, STATUS.DONE);
  assert.equal(out.summary, 'terminei');
});

// ---------------------------------------------------------------------------
// Ausencia de marcador: a regra nao negociavel
// ---------------------------------------------------------------------------

test('ausencia total de marcador resulta em ambiguo, nunca em concluido', () => {
  const texto = 'Terminei de mapear os tres pontos de entrada e apliquei a mudanca em todos.';
  const out = classifyTurn(texto);
  assert.equal(out.status, STATUS.AMBIGUOUS);
  assert.notEqual(out.status, STATUS.DONE);
  assert.equal(out.summary, null);
  assert.equal(out.question, null);
});

test('pergunta escrita em prosa, sem marcador, da ambiguo e nao estado de espera', () => {
  // Comportamento medido em 2026-09-11: sem ferramenta de pergunta em modo
  // headless, o Claude pergunta em prosa dentro do resultado final. O
  // sistema nao pode adivinhar por interrogacao.
  const texto = 'Antes de mexer, preciso saber: devo manter compatibilidade com o token v1?';
  const out = classifyTurn(texto);
  assert.equal(out.status, STATUS.AMBIGUOUS);
  assert.notEqual(out.status, STATUS.ASKING);
  assert.equal(out.question, null);
});

test('texto vazio da ambiguo', () => {
  assert.equal(classifyTurn('').status, STATUS.AMBIGUOUS);
});

test('texto so de espaco em branco da ambiguo', () => {
  assert.equal(classifyTurn('   \n\n  \t \n').status, STATUS.AMBIGUOUS);
});

test('valor que nao e string da ambiguo em vez de lancar', () => {
  for (const valor of [null, undefined, 0, 42, {}, [], true]) {
    assert.equal(classifyTurn(valor).status, STATUS.AMBIGUOUS, `falhou para ${JSON.stringify(valor)}`);
  }
});

test('resumo em prosa que menciona conclusao nao vira concluido', () => {
  const texto = 'Tarefa concluida com sucesso. Todos os testes passam e o build esta verde.';
  assert.equal(classifyTurn(texto).status, STATUS.AMBIGUOUS);
});

test('marcador com payload vazio ainda classifica', () => {
  const out = classifyTurn('@@DONE:');
  assert.equal(out.status, STATUS.DONE);
  assert.equal(out.summary, '');
});

// ---------------------------------------------------------------------------
// parseSentinel isolado
// ---------------------------------------------------------------------------

test('parseSentinel devolve nulo quando nao ha marcador', () => {
  assert.equal(parseSentinel('texto qualquer sem marcador'), null);
  assert.equal(parseSentinel(''), null);
  assert.equal(parseSentinel(123), null);
});

test('parseSentinel identifica o tipo do marcador', () => {
  assert.equal(parseSentinel('@@ASK: x').kind, 'ask');
  assert.equal(parseSentinel('@@DONE: x').kind, 'done');
  assert.equal(parseSentinel('@@BLOCKED: x').kind, 'blocked');
});

test('as tres constantes de marcador terminam com dois pontos e sao distintas', () => {
  const marcadores = Object.values(SENTINELS);
  assert.equal(marcadores.length, 3);
  assert.equal(new Set(marcadores).size, 3);
  for (const m of marcadores) assert.match(m, /:$/);
});

// ---------------------------------------------------------------------------
// Conjuntos de estado
// ---------------------------------------------------------------------------

test('ambiguo esta entre os estados vivos, para que o orquestrador possa cobrar o marcador', () => {
  assert.ok(LIVE_STATUSES.has(STATUS.AMBIGUOUS));
  assert.ok(LIVE_STATUSES.has(STATUS.ASKING));
  assert.ok(LIVE_STATUSES.has(STATUS.DONE));
});

test('ambiguo nao esta entre os estados ocupados, porque o turno de fato acabou', () => {
  assert.ok(!BUSY_STATUSES.has(STATUS.AMBIGUOUS));
  assert.ok(BUSY_STATUSES.has(STATUS.WORKING));
  assert.ok(BUSY_STATUSES.has(STATUS.STARTING));
});

test('estados vivos e terminais nao se sobrepoem', () => {
  for (const s of TERMINAL_STATUSES) assert.ok(!LIVE_STATUSES.has(s), `${s} esta nos dois conjuntos`);
});

test('todo estado ocupado tambem e vivo', () => {
  for (const s of BUSY_STATUSES) assert.ok(LIVE_STATUSES.has(s), `${s} ocupado mas nao vivo`);
});

// ---------------------------------------------------------------------------
// O contrato anexado ao prompt
// ---------------------------------------------------------------------------

test('o contrato de sistema cita os tres marcadores e proibe pergunta em prosa', () => {
  for (const m of Object.values(SENTINELS)) {
    assert.ok(SYSTEM_CONTRACT.includes(m), `contrato nao cita ${m}`);
  }
  assert.match(SYSTEM_CONTRACT, /plain prose/i);
  assert.match(SYSTEM_CONTRACT, /last line/i);
});

// ---------------------------------------------------------------------------
// Utilitarios de apresentacao
// ---------------------------------------------------------------------------

test('shorten respeita o limite e sinaliza o corte', () => {
  const curto = shorten('cabe inteiro', 100);
  assert.equal(curto, 'cabe inteiro');

  const longo = shorten('a'.repeat(50), 10);
  assert.ok(longo.length <= 13, `passou do limite: ${longo.length}`);
  assert.match(longo, /\.\.\.$/);
});

test('shorten prefere cortar em palavra inteira quando o corte cai perto do fim', () => {
  const out = shorten('palavra palavra palavra palavra', 20);
  assert.equal(out, 'palavra palavra...');
});

test('shorten normaliza espaco e aceita valor ausente', () => {
  assert.equal(shorten('  multi   espaco\nquebra ', 100), 'multi espaco quebra');
  assert.equal(shorten(null, 10), '');
  assert.equal(shorten(undefined, 10), '');
});

test('os limites de apresentacao existem e sao positivos', () => {
  for (const [nome, valor] of Object.entries(LIMITS)) {
    assert.equal(typeof valor, 'number', `${nome} nao e numero`);
    assert.ok(valor > 0, `${nome} nao e positivo`);
  }
  assert.ok(LIMITS.question > LIMITS.lastMessage, 'a pergunta precisa caber mais que a ultima frase');
});

test('newId gera oito caracteres de um alfabeto sem digito ambiguo', () => {
  const id = newId();
  assert.equal(id.length, 8);
  assert.match(id, /^[a-z2-9]{8}$/);
  // Sem 0, 1, l e o, que o orquestrador confundiria ao redigitar.
  assert.doesNotMatch(id, /[01lo]/);
});

test('newId aceita gerador injetado, para teste deterministico', () => {
  assert.equal(newId(() => 0), 'aaaaaaaa');
  assert.equal(newId(() => 0.999999), '99999999');
});

test('inferPhaseFromCommand separa verificacao de execucao comum', () => {
  for (const cmd of ['npm test', 'pnpm test -- auth', 'pytest -k auth', 'tsc --noEmit', 'eslint src', 'cargo test', 'go test ./...']) {
    assert.equal(inferPhaseFromCommand(cmd), 'verifying', `${cmd} deveria ser verificacao`);
  }
  for (const cmd of ['ls -la', 'git status', 'node script.mjs', '', undefined, null]) {
    assert.equal(inferPhaseFromCommand(cmd), 'running', `${JSON.stringify(cmd)} deveria ser execucao`);
  }
});

test('os codigos de saida sao distintos e o sucesso e zero', () => {
  assert.equal(EXIT.OK, 0);
  const valores = Object.values(EXIT);
  assert.equal(new Set(valores).size, valores.length, 'ha codigo de saida duplicado');
});

test('a versao do schema de estado e um inteiro positivo', () => {
  assert.ok(Number.isInteger(STATE_SCHEMA) && STATE_SCHEMA > 0);
});
