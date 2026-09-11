// O digest, alimentado pelos eventos do Claude falso.
//
// Todos os testes deste arquivo sao puros: `sessionScript` devolve os eventos
// como objetos, sem spawnar nada. O digest e uma maquina de estados sem I/O,
// entao o teste dele tambem pode ser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, STATUS, STATE_SCHEMA } from '../src/protocol.mjs';
import { sessionScript, FAKE_SESSION_ID } from './fake-claude.mjs';

// A ausencia do modulo de outro agente nao deve ser confundida com modulo
// quebrado. So ERR_MODULE_NOT_FOUND vira skip: erro de sintaxe ou de escopo
// sobe e falha o arquivo, que e o comportamento correto.
let digestMod = null;
let ausente = null;
try {
  digestMod = await import('../src/digest.mjs');
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  ausente = err;
}
const skip = ausente ? `src/digest.mjs ainda nao existe: ${ausente.message}` : false;

/** Alimenta o digest com uma sessao inteira do Claude falso. */
function digerir(behavior, prompts = ['tarefa'], seed = {}) {
  const { createDigest } = digestMod;
  const d = createDigest({
    id: 'aaaa1111',
    label: 'refactor-auth',
    pid: 4242,
    cwd: 'C:\\proj',
    startedAt: '2026-09-11T12:00:00.000Z',
    now: () => 0,
    ...seed,
  });
  const { events } = sessionScript({ behavior, prompts });
  const passos = [];
  for (const ev of events) {
    passos.push({ ev, res: d.apply(ev) });
  }
  return { state: d.snapshot(), passos, events, digest: d };
}

/** Todas as entradas de log geradas na sessao. */
function entradas(passos) {
  return passos.flatMap((p) => p.res.entries);
}

// ---------------------------------------------------------------------------
// Filtragem de ruido
// ---------------------------------------------------------------------------

test('ruido do fluxo nao muda estado nem gera entrada de log', { skip }, () => {
  const { passos } = digerir('done');
  const ruidosos = passos.filter(({ ev }) => (
    ev.type === 'rate_limit_event'
    || ev.type === 'stream_event'
    || (ev.type === 'system' && ['thinking_tokens', 'hook_started', 'hook_response'].includes(ev.subtype))
  ));

  assert.ok(ruidosos.length >= 5, `esperava ruido no fixture, achei ${ruidosos.length}`);
  for (const { ev, res } of ruidosos) {
    const nome = `${ev.type}/${ev.subtype ?? ''}`;
    assert.equal(res.changed, false, `${nome} mudou o estado`);
    assert.deepEqual(res.entries, [], `${nome} gerou entrada de log`);
  }
});

test('evento de fluxo parcial e ignorado, porque delta e ruido puro aqui', { skip }, () => {
  const { passos } = digerir('unknown-event');
  const parciais = passos.filter(({ ev }) => ev.type === 'stream_event');
  assert.ok(parciais.length >= 1);
  for (const { res } of parciais) {
    assert.equal(res.changed, false);
    assert.deepEqual(res.entries, []);
  }
});

test('evento de tipo desconhecido vai para o log e nao derruba o digest', { skip }, () => {
  const { state, passos } = digerir('unknown-event');
  const desconhecidos = passos.filter(({ ev }) => ev.type === 'quantum_flux_event');
  assert.equal(desconhecidos.length, 1);
  assert.ok(desconhecidos[0].res.entries.length >= 1, 'o evento novo deveria aparecer no log');
  // Compatibilidade para frente: o turno segue e fecha normalmente.
  assert.equal(state.status, STATUS.DONE);
});

// ---------------------------------------------------------------------------
// Identificador de sessao atraves de um segundo init
// ---------------------------------------------------------------------------

test('o identificador de sessao do Claude e preenchido pelo init', { skip }, () => {
  const { state } = digerir('done');
  assert.equal(state.claudeSessionId, FAKE_SESSION_ID);
});

test('um segundo init no mesmo processo nao troca o identificador nem reinicia contadores', { skip }, () => {
  // Medido em 2026-09-11: um init novo chega no comeco de cada turno, com o
  // mesmo session_id. Ler isso como sessao nova apagaria o trabalho anterior.
  const { state, events } = digerir('multi-turn', ['parte 1', 'parte 2', 'parte 3']);
  const inits = events.filter((ev) => ev.type === 'system' && ev.subtype === 'init');

  assert.equal(inits.length, 3, 'o fixture precisa emitir um init por turno');
  assert.equal(new Set(inits.map((ev) => ev.session_id)).size, 1, 'o fixture mudou o session_id');

  assert.equal(state.claudeSessionId, FAKE_SESSION_ID);
  assert.equal(state.turn, 3, 'o contador de turno foi reiniciado por um init');
  assert.equal(state.toolCounts.Read, 3, 'as contagens de ferramenta foram reiniciadas');
  assert.equal(state.toolCounts.Edit, 3);
  assert.equal(state.filesTouched.length, 3, 'os arquivos tocados foram esquecidos');
});

// ---------------------------------------------------------------------------
// Agregacao de contagem de ferramentas
// ---------------------------------------------------------------------------

test('chamadas de ferramenta viram contagem por nome, nunca lista de chamadas', { skip }, () => {
  const { state } = digerir('done');
  assert.deepEqual(state.toolCounts, {
    Read: 2, Grep: 1, Edit: 1, Write: 1, NotebookEdit: 1, Bash: 1,
  });
});

test('cada uso de ferramenta gera exatamente uma entrada de log do tipo tool', { skip }, () => {
  const { passos, events } = digerir('done');
  const usos = events.filter((ev) => ev.type === 'assistant' && ev.message.content.some((b) => b.type === 'tool_use'));
  const tool = entradas(passos).filter((e) => e.kind === 'tool');
  assert.equal(tool.length, usos.length);
  assert.deepEqual(
    tool.map((e) => e.name),
    ['Read', 'Read', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
  );
});

test('a fase acompanha o comando de shell em andamento', { skip }, () => {
  const { createDigest } = digestMod;
  const d = createDigest({ id: 'a', pid: 1, cwd: 'C:\\proj', now: () => 0 });
  const { events } = sessionScript({ behavior: 'done' });

  // Aplica ate o uso de Bash, sem chegar no result, que zera a fase.
  const ateBash = [];
  for (const ev of events) {
    ateBash.push(ev);
    const bloco = ev.type === 'assistant' ? ev.message.content.find((b) => b.type === 'tool_use') : null;
    if (bloco?.name === 'Bash') break;
  }
  for (const ev of ateBash) d.apply(ev);

  // O comando do fixture e `npm test -- auth`, logo verificacao.
  assert.equal(d.snapshot().phase, 'verifying');
});

// ---------------------------------------------------------------------------
// Arquivos tocados e o excedente virando contador
// ---------------------------------------------------------------------------

test('arquivos tocados saem de Write, Edit e NotebookEdit, sem repeticao', { skip }, () => {
  const { state } = digerir('done');
  // O fixture edita session.ts, escreve rotate.ts e edita um notebook. As
  // duas leituras de token.ts e session.ts nao entram.
  assert.deepEqual(state.filesTouched, [
    'src/auth/session.ts',
    'src/auth/rotate.ts',
    'docs/analise.ipynb',
  ]);
  assert.equal(state.filesTouchedExtra, 0);
  assert.ok(!state.filesTouched.includes('src/auth/token.ts'), 'leitura nao e arquivo tocado');
});

test('o excedente de arquivos tocados vira contador em vez de crescer a lista', { skip }, () => {
  const { state } = digerir('many-files');
  assert.equal(state.toolCounts.Write, 25, 'o fixture precisa escrever 25 arquivos');
  assert.equal(state.filesTouched.length, LIMITS.filesTouched);
  assert.equal(state.filesTouchedExtra, 25 - LIMITS.filesTouched);
});

test('o estado compacto nao cresce com a duracao do turno', { skip }, () => {
  // O alvo declarado e cerca de quinze linhas para qualquer tarefa. Este
  // teste protege o invariante por construcao, comparando um turno curto com
  // um turno de 95 eventos.
  const curto = digerir('blocked').state;
  const longo = digerir('many-files').state;

  assert.ok(longo.filesTouched.length <= LIMITS.filesTouched);
  assert.ok(longo.lastMessage.length <= LIMITS.lastMessage + 3);
  assert.ok(longo.turnLog.length <= LIMITS.turnHistory);
  assert.ok(longo.denialSamples.length <= LIMITS.denialSamples);
  assert.deepEqual(Object.keys(curto).sort(), Object.keys(longo).sort(), 'o estado ganhou campos novos no turno longo');
});

test('a ultima frase do assistente e truncada no limite', { skip }, () => {
  const { state, events } = digerir('many-files');
  const textoFinal = events.at(-1).result;
  assert.ok(textoFinal.length > LIMITS.lastMessage * 2, 'o fixture precisa de um texto bem longo');
  assert.ok(state.lastMessage.length <= LIMITS.lastMessage + 3, `lastMessage com ${state.lastMessage.length}`);
});

// ---------------------------------------------------------------------------
// Resultado de ferramenta com erro
// ---------------------------------------------------------------------------

test('resultado de ferramenta marcado com erro gera entrada propria', { skip }, () => {
  const { passos } = digerir('blocked');
  const comErro = entradas(passos).filter((e) => e.kind === 'tool-result');
  assert.ok(comErro.length >= 2, `esperava dois resultados com erro, achei ${comErro.length}`);
});

test('resultado de ferramenta bem sucedido nao polui o log', { skip }, () => {
  const { passos } = digerir('done');
  const comErro = entradas(passos).filter((e) => e.kind === 'tool-result');
  assert.deepEqual(comErro, [], 'so o resultado com erro deveria virar entrada');
});

// ---------------------------------------------------------------------------
// Negacoes de permissao
// ---------------------------------------------------------------------------

test('negacoes de permissao viram contagem com amostras de ferramenta e caminho', { skip }, () => {
  const { state } = digerir('denials');
  assert.equal(state.permissionDenials, 3);
  assert.deepEqual(state.denialSamples, [
    'Write C:\\fora\\do\\escopo\\x.ts',
    'Edit C:\\Windows\\System32\\drivers\\etc\\hosts',
    'NotebookEdit C:\\outro\\repo\\nb.ipynb',
  ]);
});

test('a amostra de negacao le notebook_path quando a ferramenta e NotebookEdit', { skip }, () => {
  const { state } = digerir('denials');
  const amostra = state.denialSamples.find((s) => s.startsWith('NotebookEdit'));
  assert.ok(amostra.includes('nb.ipynb'), `amostra sem caminho: ${amostra}`);
});

test('as amostras de negacao respeitam o limite', { skip }, () => {
  const { state } = digerir('denials');
  assert.ok(state.denialSamples.length <= LIMITS.denialSamples);
});

test('sessao sem negacao reporta zero, nao nulo', { skip }, () => {
  const { state } = digerir('done');
  assert.equal(state.permissionDenials, 0);
  assert.deepEqual(state.denialSamples, []);
});

// ---------------------------------------------------------------------------
// Fechamento de turno e classificacao
// ---------------------------------------------------------------------------

test('turno com marcador de conclusao fecha como concluido, com resumo', { skip }, () => {
  const { state } = digerir('done');
  assert.equal(state.status, STATUS.DONE);
  assert.equal(state.pendingQuestion, null);
  assert.equal(state.turn, 1);
});

test('turno com marcador de pergunta fecha em espera e publica a pergunta', { skip }, () => {
  const { state } = digerir('ask-then-done', ['tarefa']);
  assert.equal(state.status, STATUS.ASKING);
  assert.equal(state.pendingQuestion, 'Devo manter compatibilidade com o token v1?');
});

test('responder a pergunta no turno seguinte limpa a pendencia e fecha concluido', { skip }, () => {
  const { state } = digerir('ask-then-done', ['tarefa', 'mantenha o v1']);
  assert.equal(state.status, STATUS.DONE);
  assert.equal(state.pendingQuestion, null);
  assert.equal(state.turn, 2);
});

test('turno com marcador de bloqueio fecha como bloqueado', { skip }, () => {
  const { state } = digerir('blocked');
  assert.equal(state.status, STATUS.BLOCKED);
});

test('turno sem marcador nenhum fecha como ambiguo, e nunca como concluido', { skip }, () => {
  // A regra da secao 6.2 da spec, medida ponta a ponta pelo digest.
  const { state } = digerir('no-marker');
  assert.equal(state.status, STATUS.AMBIGUOUS);
  assert.notEqual(state.status, STATUS.DONE);
  assert.equal(state.pendingQuestion, null, 'pergunta em prosa nao vira pergunta pendente');
  assert.ok(state.lastMessage.length > 0, 'o estado ambiguo precisa mostrar o texto final');
});

test('resultado marcado com erro nao e lido como conclusao', { skip }, () => {
  const { state } = digerir('error-result');
  assert.notEqual(state.status, STATUS.DONE);
});

test('cada turno fechado empilha um registro em turnLog', { skip }, () => {
  const { state } = digerir('multi-turn', ['a', 'b', 'c']);
  assert.equal(state.turnLog.length, 3);
  for (const t of state.turnLog) {
    assert.equal(typeof t.n, 'number');
    assert.equal(typeof t.ms, 'number');
    assert.equal(typeof t.costUsd, 'number');
    assert.equal(t.outcome, STATUS.DONE);
  }
  assert.deepEqual(state.turnLog.map((t) => t.n), [1, 2, 3]);
});

test('turnLog nao cresce sem limite', { skip }, () => {
  const prompts = Array.from({ length: LIMITS.turnHistory + 5 }, (_, i) => `parte ${i}`);
  const { state } = digerir('multi-turn', prompts);
  assert.equal(state.turnLog.length, LIMITS.turnHistory);
  assert.equal(state.turn, prompts.length, 'o contador de turno segue subindo');
});

test('o cursor acompanha a contagem de eventos digeridos', { skip }, () => {
  const { state } = digerir('done');
  assert.ok(state.eventCount > 0);
  assert.equal(state.cursor, state.eventCount);
});

test('o estado carrega a versao de schema do protocolo', { skip }, () => {
  const { state } = digerir('done');
  assert.equal(state.schema, STATE_SCHEMA);
});

// ---------------------------------------------------------------------------
// Custo
// ---------------------------------------------------------------------------

test('o campo total_cost_usd do fixture e acumulado da sessao, como o binario real', { skip: false }, () => {
  // Fato medido e registrado na secao 11.2 da spec: turno 1 em 0.1465 e
  // turno 2 em 0.1615 no MESMO processo. O segundo valor inclui o primeiro.
  const { events } = sessionScript({ behavior: 'multi-turn', prompts: ['a', 'b', 'c'] });
  const custos = events.filter((ev) => ev.type === 'result').map((ev) => ev.total_cost_usd);
  assert.deepEqual(custos, [0.1465, 0.1615, 0.1765]);
  for (let i = 1; i < custos.length; i += 1) {
    assert.ok(custos[i] > custos[i - 1], 'valor acumulado nunca diminui');
  }
});

test('totalCostUsd reflete o acumulado do ultimo resultado, sem somar acumulados', { skip }, () => {
  // Secao 5.3 da spec: "Custo vem do campo acumulado do evento de resultado".
  // Somar tres valores ja acumulados triplicaria o custo relatado ao
  // orquestrador, que e uma informacao de produto, nao um detalhe interno.
  const { state } = digerir('multi-turn', ['a', 'b', 'c']);
  assert.equal(
    state.totalCostUsd,
    0.1765,
    'o digest somou valores que ja vinham acumulados: 0.1465+0.1615+0.1765 em vez do ultimo',
  );
});

test('custo por turno aparece no turnLog', { skip }, () => {
  // O turnLog guarda o custo DAQUELE turno, nao o acumulado da sessao, que
  // ja vive em totalCostUsd. Como o Claude so reporta o acumulado, o custo
  // isolado e a diferenca entre leituras consecutivas.
  //
  // O fixture cobra 0.1465 no primeiro turno e 0.015 no segundo, imitando o
  // que foi medido: o turno seguinte na mesma sessao aproveita cache e custa
  // uma fracao do primeiro. Esperar 0.1615 aqui seria repetir o acumulado e
  // fazer todo turno parecer tao caro quanto a sessao inteira.
  const { state } = digerir('multi-turn', ['a', 'b']);
  assert.deepEqual(state.turnLog.map((t) => t.costUsd), [0.1465, 0.015]);
});

// ---------------------------------------------------------------------------
// Robustez
// ---------------------------------------------------------------------------

test('o digest aceita ser alimentado com valor que nao e evento, sem lancar', { skip }, () => {
  const { createDigest } = digestMod;
  const d = createDigest({ id: 'a', pid: 1, now: () => 0 });
  for (const lixo of [null, undefined, 0, '', 'texto', [], {}, { type: null }]) {
    assert.doesNotThrow(() => d.apply(lixo), `lancou para ${JSON.stringify(lixo)}`);
  }
  assert.equal(d.snapshot().status, STATUS.STARTING);
});

test('snapshot devolve copia, nao referencia viva do estado interno', { skip }, () => {
  const { state, digest } = digerir('done');
  state.toolCounts.Read = 999;
  state.filesTouched.push('invadido.ts');
  const depois = digest.snapshot();
  assert.equal(depois.toolCounts.Read, 2, 'toolCounts vazou por referencia');
  assert.ok(!depois.filesTouched.includes('invadido.ts'), 'filesTouched vazou por referencia');
});
