// Parser estrito de argumentos.
//
// O defeito que este arquivo existe para impedir e concreto e foi medido no
// plugin oficial `openai-codex`: um `--wait` esquecido na linha de comando
// cai nos positionais e vaza literalmente para dentro do prompt enviado ao
// modelo. Aqui opcao com dois tracos desconhecida e erro de uso, e o teste
// principal verifica as duas metades disso: que da erro, e que nao vaza.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EXIT } from '../src/protocol.mjs';

let argsMod = null;
let ausente = null;
try {
  argsMod = await import('../src/args.mjs');
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  ausente = err;
}
const skip = ausente ? `src/args.mjs ainda nao existe: ${ausente.message}` : false;

const SPEC_SAY = {
  booleans: ['json'],
  strings: ['label'],
  numbers: ['timeout-ms'],
};

// ---------------------------------------------------------------------------
// A regra central: opcao desconhecida e erro e nao vaza
// ---------------------------------------------------------------------------

test('opcao com dois tracos desconhecida e erro de uso', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(
    () => parse(['--wait', 'sessao', 'mensagem'], SPEC_SAY),
    (err) => {
      assert.equal(err.code, EXIT.USAGE, 'o erro precisa carregar o codigo de uso');
      assert.match(err.message, /--wait/, 'a mensagem precisa nomear a opcao recusada');
      return true;
    },
  );
});

test('opcao desconhecida nunca vaza para os argumentos posicionais', { skip }, () => {
  const { parse } = argsMod;
  let vazou = null;
  try {
    const out = parse(['a3f1', '--wait', 'termine a refatoracao'], SPEC_SAY);
    vazou = out.positionals;
  } catch {
    vazou = null;
  }
  assert.equal(vazou, null, `--wait chegou nos positionais: ${JSON.stringify(vazou)}`);
});

test('a mensagem de recusa lista o que o subcomando aceita, para ser acionavel', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(
    () => parse(['--desconhecida'], SPEC_SAY),
    (err) => {
      assert.match(err.message, /--json/);
      assert.match(err.message, /--label/);
      return true;
    },
  );
});

test('opcao desconhecida de um traco tambem e erro', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(() => parse(['-x'], SPEC_SAY), (err) => err.code === EXIT.USAGE);
});

// ---------------------------------------------------------------------------
// Valor faltando
// ---------------------------------------------------------------------------

test('opcao que exige valor sem valor e erro de uso', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(() => parse(['--label'], SPEC_SAY), (err) => {
    assert.equal(err.code, EXIT.USAGE);
    assert.match(err.message, /--label/);
    return true;
  });
});

test('opcao de valor seguida de outra opcao nao engole a opcao seguinte', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(() => parse(['--label', '--json'], SPEC_SAY), (err) => err.code === EXIT.USAGE);
});

test('numero negativo e aceito como valor, nao confundido com opcao', { skip }, () => {
  const { parse } = argsMod;
  const out = parse(['--timeout-ms', '-1'], SPEC_SAY);
  assert.equal(out.options['timeout-ms'], -1);
});

test('valor nao numerico em opcao numerica e erro de uso', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(() => parse(['--timeout-ms', 'depressa'], SPEC_SAY), (err) => err.code === EXIT.USAGE);
});

// ---------------------------------------------------------------------------
// Formas aceitas
// ---------------------------------------------------------------------------

test('booleano liga sem valor e aceita valor embutido', { skip }, () => {
  const { parse } = argsMod;
  assert.equal(parse(['--json'], SPEC_SAY).options.json, true);
  assert.equal(parse(['--json=false'], SPEC_SAY).options.json, false);
  assert.equal(parse(['--json=true'], SPEC_SAY).options.json, true);
});

test('opcao de valor aceita as duas formas, separada e com igual', { skip }, () => {
  const { parse } = argsMod;
  assert.equal(parse(['--label', 'refactor-auth'], SPEC_SAY).options.label, 'refactor-auth');
  assert.equal(parse(['--label=refactor-auth'], SPEC_SAY).options.label, 'refactor-auth');
});

test('a chave devolvida e identica ao nome na linha de comando', { skip }, () => {
  const { parse } = argsMod;
  const out = parse(['--timeout-ms', '2000'], SPEC_SAY);
  assert.ok(Object.hasOwn(out.options, 'timeout-ms'), 'a chave virou outra coisa');
  assert.ok(!Object.hasOwn(out.options, 'timeoutMs'), 'houve conversao para camelCase');
});

test('positionais saem na ordem, sem as opcoes', { skip }, () => {
  const { parse } = argsMod;
  const out = parse(['a3f1', 'termine a tarefa', '--json'], SPEC_SAY);
  assert.deepEqual(out.positionals, ['a3f1', 'termine a tarefa']);
  assert.equal(out.options.json, true);
});

test('tudo depois de dois tracos isolados e positional, mesmo parecendo opcao', { skip }, () => {
  const { parse } = argsMod;
  const out = parse(['a3f1', '--', '--wait', '-x'], SPEC_SAY);
  assert.deepEqual(out.positionals, ['a3f1', '--wait', '-x']);
});

test('linha de comando vazia devolve estrutura vazia e nao lanca', { skip }, () => {
  const { parse } = argsMod;
  const out = parse([], SPEC_SAY);
  assert.deepEqual(out.positionals, []);
  assert.equal(typeof out.options, 'object');
});

test('spec sem opcao nenhuma recusa qualquer opcao', { skip }, () => {
  const { parse } = argsMod;
  const out = parse(['a3f1'], {});
  assert.deepEqual(out.positionals, ['a3f1']);
  assert.throws(() => parse(['--json'], {}), (err) => err.code === EXIT.USAGE);
});

test('alias resolve para o nome canonico', { skip }, () => {
  const { parse } = argsMod;
  const spec = { booleans: ['json'], aliases: { j: 'json' } };
  assert.equal(parse(['-j'], spec).options.json, true);
});

test('opcao repetivel acumula em lista', { skip }, () => {
  const { parse } = argsMod;
  const spec = { strings: ['tool'], repeatable: ['tool'] };
  const out = parse(['--tool', 'Read', '--tool', 'Edit'], spec);
  assert.deepEqual(out.options.tool, ['Read', 'Edit']);
});

test('opcao nao repetivel repetida e erro, em vez de o ultimo vencer em silencio', { skip }, () => {
  const { parse } = argsMod;
  assert.throws(
    () => parse(['--label', 'um', '--label', 'dois'], SPEC_SAY),
    (err) => err.code === EXIT.USAGE,
  );
});
