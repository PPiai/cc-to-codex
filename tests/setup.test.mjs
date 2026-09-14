// `ccx setup` e o postinstall, que sao o mesmo trabalho com contratos de
// codigo de saida opostos.
//
// Nenhum teste deste arquivo despacha sessao, entao nao ha supervisor para
// limpar e a maquinaria de processo de `cli.test.mjs` nao e necessaria aqui.
// O que EXISTE de risco e outro: os dois caminhos escrevem skill em disco.
// Por isso CODEX_HOME e CCX_STATE_DIR sao forcados para diretorio temporario
// em toda invocacao. Um teste que gravasse no `~/.codex` de verdade deixaria
// um efeito que nenhum `afterEach` desfaz de forma confiavel.
//
// Cota paga: CCX_CLAUDE_BIN aponta para o Claude falso, e nenhum comando
// exercitado aqui abre sessao. `setup` so roda --version e --help.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../src/protocol.mjs';
import { buildEnv, installFakeClaude } from './fake-claude.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CCX = path.join(RAIZ, 'bin', 'ccx.mjs');
const POSTINSTALL = path.join(RAIZ, 'scripts', 'postinstall.mjs');

// Nome declarado no frontmatter do SKILL.md do pacote. Lido, e nao cravado:
// se o nome mudar, o teste acompanha em vez de passar a reprovar por um
// motivo que nao e defeito.
const NOME_SKILL = (() => {
  const texto = fs.readFileSync(path.join(RAIZ, 'skill', 'SKILL.md'), 'utf8');
  return texto.match(/^name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m)?.[1] ?? 'cc-to-codex';
})();

const skip = fs.existsSync(CCX) ? false : `bin/ccx.mjs ainda nao existe em ${CCX}`;

/**
 * Ambiente isolado: diretorio temporario proprio, Claude falso injetado,
 * CODEX_HOME e raiz de estado presos dentro dele.
 */
function ambiente({ extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-setup-'));
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch {
      // Temporario sobrevivente nao e defeito do que foi testado.
    }
  });

  const install = installFakeClaude({ binDir: path.join(dir, 'bin') });
  const work = path.join(dir, 'work');
  const codexHome = path.join(dir, 'codex');
  fs.mkdirSync(work, { recursive: true });

  const env = buildEnv({
    install,
    stateDir: path.join(dir, 'state'),
    statePath: path.join(dir, 'fake-state.json'),
    extra: { CODEX_HOME: codexHome, ...extra },
  });

  const rodar = (args, { env: envOverride, cwd = work } = {}) => {
    const r = spawnSync(process.execPath, args, {
      cwd,
      env: envOverride ?? env,
      encoding: 'utf8',
      timeout: 60000,
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  const ccx = (...args) => rodar([CCX, ...args]);
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

  return { dir, work, codexHome, env, install, ccx, json, rodar };
}

const destinoDeUsuario = (amb) => path.join(amb.codexHome, 'skills', NOME_SKILL);

// ---------------------------------------------------------------------------
// Registro do comando
// ---------------------------------------------------------------------------

test('setup aparece na ajuda geral e tem ajuda propria', { skip }, () => {
  const amb = ambiente();

  const geral = amb.ccx('--help');
  assert.equal(geral.code, EXIT.OK);
  assert.match(geral.stdout, /^\s*setup\s+/m, 'setup nao esta listado na ajuda geral');

  const propria = amb.ccx('setup', '--help');
  assert.equal(propria.code, EXIT.OK);
  assert.match(propria.stdout, /--scope/, 'a ajuda de setup nao documenta --scope');
  assert.match(propria.stdout, /--json/, 'a ajuda de setup nao documenta --json');
  // O padrao divergente entre setup (user) e install-skill (project) e
  // exatamente o tipo de detalhe que vira relato de defeito quando fica
  // implicito. A ajuda precisa dize-lo.
  assert.match(propria.stdout, /PADRAO/, 'a ajuda de setup nao diz qual escopo e o padrao');
});

// ---------------------------------------------------------------------------
// Caminho feliz
// ---------------------------------------------------------------------------

test('setup instala a skill no escopo de usuario por padrao e sai com zero', { skip }, () => {
  const amb = ambiente();
  const r = amb.json('setup', '--json');

  assert.equal(r.code, EXIT.OK, `setup falhou: ${r.stdout}\n${r.stderr}`);
  assert.ok(r.json, `setup nao emitiu JSON: ${r.stdout}`);
  assert.equal(r.json.command, 'setup');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.scope, 'user');
  assert.equal(r.json.skill.ok, true);

  const destino = destinoDeUsuario(amb);
  assert.equal(r.json.skill.destDir, destino, 'o destino relatado nao e o de escopo de usuario');
  assert.ok(fs.existsSync(path.join(destino, 'SKILL.md')), `SKILL.md nao foi escrito em ${destino}`);
});

test('setup e idempotente: rodar de novo continua saindo com zero', { skip }, () => {
  const amb = ambiente();
  const primeira = amb.json('setup', '--json');
  assert.equal(primeira.code, EXIT.OK, primeira.stdout + primeira.stderr);

  const segunda = amb.json('setup', '--json');
  assert.equal(segunda.code, EXIT.OK, segunda.stdout + segunda.stderr);
  assert.equal(segunda.json.skill.ok, true);
  assert.equal(
    segunda.json.skill.written,
    primeira.json.skill.written,
    'a segunda passada escreveu um conjunto de arquivos diferente',
  );
  assert.equal(segunda.json.skill.overwrote, true, 'a segunda passada devia reconhecer que sobrescreve');
});

test('setup --scope project grava dentro do diretorio de trabalho', { skip }, () => {
  const amb = ambiente();
  const r = amb.json('setup', '--scope', 'project', '--json');

  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  assert.equal(r.json.scope, 'project');
  const destino = path.join(amb.work, '.agents', 'skills', NOME_SKILL);
  assert.equal(r.json.skill.destDir, destino);
  assert.ok(fs.existsSync(path.join(destino, 'SKILL.md')), `SKILL.md nao foi escrito em ${destino}`);
  assert.ok(
    !fs.existsSync(destinoDeUsuario(amb)),
    'escopo project nao devia ter tocado o escopo de usuario',
  );
});

test('a saida de humano do setup separa o que ficou pronto do que falta', { skip }, () => {
  const amb = ambiente();
  const r = amb.ccx('setup');
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  assert.match(r.stdout, /pronto/, 'o resumo nao tem secao de pronto');
  assert.match(r.stdout, /tudo pronto/, 'o desfecho nao foi declarado');
  assert.match(r.stdout, new RegExp(NOME_SKILL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---------------------------------------------------------------------------
// Recusas
// ---------------------------------------------------------------------------

test('setup recusa escopo invalido com codigo de uso', { skip }, () => {
  const amb = ambiente();
  const r = amb.ccx('setup', '--scope', 'global');
  assert.equal(r.code, EXIT.USAGE, `esperado ${EXIT.USAGE}, veio ${r.code}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /escopo|scope/i);
});

test('setup recusa argumento posicional', { skip }, () => {
  const amb = ambiente();
  const r = amb.ccx('setup', 'user');
  assert.equal(r.code, EXIT.USAGE, `esperado ${EXIT.USAGE}, veio ${r.code}: ${r.stdout}${r.stderr}`);
});

test('pre-requisito ausente sai com 5, e ainda assim instala a skill', { skip }, () => {
  // A diferenca de contrato com o postinstall vive aqui. Apontar
  // CCX_CLAUDE_BIN para um caminho inexistente faz `resolveClaudeBinary`
  // recusar sem cair para o PATH, entao o Claude real nunca e tocado.
  const amb = ambiente();
  const env = { ...amb.env, CCX_CLAUDE_BIN: path.join(amb.dir, 'nao-existe', 'claude') };
  const r = amb.rodar([CCX, 'setup', '--json'], { env });

  assert.equal(
    r.code,
    EXIT.MISSING_PREREQ,
    `esperado ${EXIT.MISSING_PREREQ}, veio ${r.code}: ${r.stdout}${r.stderr}`,
  );

  const payload = JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(payload.ok, false, 'o setup nao devia declarar sucesso sem o Claude Code');
  assert.ok(payload.report.problems.length > 0, 'nenhum problema relatado');

  // O ponto do teste: o diagnostico reprovou, mas a metade que dava para
  // deixar pronta ficou pronta.
  assert.equal(payload.skill.ok, true, 'a skill devia ter sido instalada mesmo com pendencia');
  assert.ok(fs.existsSync(path.join(destinoDeUsuario(amb), 'SKILL.md')));
});

// ---------------------------------------------------------------------------
// postinstall
// ---------------------------------------------------------------------------
//
// A unica coisa que o postinstall NAO pode fazer e sair com codigo != 0:
// falhar la aborta `npm install -g` inteiro. Cada caso abaixo confere o
// codigo de saida antes de qualquer outra coisa.

/** Ambiente de npm, sem as escotilhas que o proprio processo de teste possa ter. */
function envDeNpm(amb, extra = {}) {
  const env = { ...amb.env, ...extra };
  // O runner de CI define CI=true, e o postinstall honra isso pulando tudo.
  // Os testes que exercitam o caminho ATIVO precisam remover a escotilha, ou
  // passariam verdes sem testar nada.
  if (!('CI' in extra)) delete env.CI;
  if (!('CCX_SKIP_POSTINSTALL' in extra)) delete env.CCX_SKIP_POSTINSTALL;
  return env;
}

test('postinstall em instalacao local sai com zero e nao escreve skill', { skip }, () => {
  const amb = ambiente();
  const r = amb.rodar([POSTINSTALL], { env: envDeNpm(amb, { npm_config_global: 'false' }) });

  assert.equal(r.code, 0, `postinstall local saiu com ${r.code}: ${r.stderr}`);
  assert.ok(
    !fs.existsSync(destinoDeUsuario(amb)),
    'instalacao local nao devia escrever no CODEX_HOME de ninguem',
  );
  assert.equal(r.stdout, '', 'o postinstall nao deve emitir nada no stdout');
});

test('a string "false" de npm_config_global nao e lida como verdadeira', { skip }, () => {
  // Defeito classico: `if (env.npm_config_global)` entra no ramo global
  // durante instalacao local, porque "false" e string nao vazia.
  const amb = ambiente();
  const r = amb.rodar([POSTINSTALL], { env: envDeNpm(amb, { npm_config_global: 'false' }) });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /instalacao local/i, `ramo errado: ${r.stderr}`);
});

test('postinstall global instala a skill, anuncia o caminho e sai com zero', { skip }, () => {
  const amb = ambiente();
  const r = amb.rodar([POSTINSTALL], { env: envDeNpm(amb, { npm_config_global: 'true' }) });

  assert.equal(r.code, 0, `postinstall global saiu com ${r.code}: ${r.stderr}`);
  const destino = destinoDeUsuario(amb);
  assert.ok(fs.existsSync(path.join(destino, 'SKILL.md')), `SKILL.md nao foi escrito em ${destino}`);
  // Anunciar o que escreveu fora do pacote e dizer como desfazer nao e
  // cortesia: e a prestacao de contas de um script que ninguem pediu.
  assert.ok(r.stderr.includes(destino), `o postinstall nao anunciou o destino: ${r.stderr}`);
  assert.match(r.stderr, /desfazer/i, 'o postinstall nao disse como desfazer');
  assert.equal(r.stdout, '', 'o postinstall nao deve emitir nada no stdout');
});

test('CCX_SKIP_POSTINSTALL e CI pulam o postinstall sem escrever nada', { skip }, () => {
  for (const escotilha of [{ CCX_SKIP_POSTINSTALL: '1' }, { CI: 'true' }]) {
    const amb = ambiente();
    const r = amb.rodar([POSTINSTALL], {
      env: envDeNpm(amb, { npm_config_global: 'true', ...escotilha }),
    });
    const nome = Object.keys(escotilha)[0];
    assert.equal(r.code, 0, `${nome}: postinstall saiu com ${r.code}`);
    assert.ok(
      !fs.existsSync(destinoDeUsuario(amb)),
      `${nome}: a escotilha nao impediu a escrita da skill`,
    );
  }
});

test('postinstall sai com zero mesmo com o diretorio da skill ausente', { skip }, () => {
  // Simula pacote mutilado: `planInstall` lanca por falta de skill/, e o
  // postinstall precisa engolir e continuar valendo 0. A raiz do pacote e
  // deslocada por um clone que so tem o script.
  const amb = ambiente();
  const falso = path.join(amb.dir, 'pacote-mutilado');
  fs.mkdirSync(path.join(falso, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(falso, 'src'), { recursive: true });
  fs.copyFileSync(POSTINSTALL, path.join(falso, 'scripts', 'postinstall.mjs'));

  const r = amb.rodar([path.join(falso, 'scripts', 'postinstall.mjs')], {
    env: envDeNpm(amb, { npm_config_global: 'true' }),
  });
  assert.equal(r.code, 0, `postinstall mutilado saiu com ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /ccx setup/, 'a saida degradada nao aponta o caminho de recuperacao');
});
