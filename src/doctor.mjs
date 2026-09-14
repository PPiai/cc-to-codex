// Diagnostico de pre-requisitos, separado da CLI.
//
// Por que este modulo existe em vez de a logica morar em `bin/ccx.mjs`:
// tres chamadores diferentes precisam do MESMO relatorio, e dois deles nao
// sao a linha de comando.
//
//   1. `ccx doctor` imprime o relatorio e sai com codigo.
//   2. `ccx setup` decide, a partir do mesmo objeto, se o ambiente esta
//      pronto antes de instalar a skill.
//   3. `scripts/postinstall.mjs` roda durante `npm install -g` e precisa
//      relatar em prosa curta sem nunca falhar.
//
// Fazer o postinstall spawnar `ccx doctor --json` funcionaria, mas pagaria um
// processo a mais e faria a instalacao depender do proprio binario ja estar
// no PATH, que e exatamente o que ainda nao esta garantido nesse momento.
//
// Este modulo NAO imprime e NAO sai do processo: devolve um objeto e quem
// chamou decide o que mostrar. Mesma regra de `install-skill.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { VERSION } from './protocol.mjs';
import { probeStateRoots, resolveClaudeBinary } from './paths.mjs';
import { codexHome, projectSkillsDir, userSkillsDir } from './install-skill.mjs';

// Flags que o supervisor usa na linha de comando do Claude. O doctor
// confere cada uma contra a ajuda local para detectar mudanca de versao
// cedo, em vez de descobrir no meio de um despacho.
export const REQUIRED_CLAUDE_FLAGS = [
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
export const RUNTIME_MODULES = [
  'src/supervisor.mjs',
  'src/fence.mjs',
  'src/state.mjs',
  'src/digest.mjs',
];

// Tetos das sondagens externas. Sao parametros e nao constantes cravadas
// porque o postinstall roda dentro do `npm install -g`, onde meio minuto de
// silencio parece travamento: la os tetos sao apertados de proposito.
export const DEFAULT_TIMEOUTS = { claudeHelpMs: 20000, codexVersionMs: 8000 };

export function missingRuntimeModules(pkgRoot) {
  return RUNTIME_MODULES.filter((rel) => !fs.existsSync(path.join(pkgRoot, rel)));
}

/** Versao do Codex, se houver. Ausencia nao e problema: o ccx roda sem ele. */
export function probeCodex(timeoutMs = DEFAULT_TIMEOUTS.codexVersionMs) {
  try {
    // No Windows o executavel costuma ser .cmd, que so resolve via shell.
    // Nesse caso o comando vai como UMA string, sem lista de argumentos:
    // passar argumentos junto de shell:true dispara DEP0190 e, pior, faz o
    // shell concatenar sem escapar. Comando fixo, sem entrada do usuario.
    const useShell = process.platform === 'win32';
    const res = useShell
      ? spawnSync('codex --version', { encoding: 'utf8', timeout: timeoutMs, shell: true, windowsHide: true })
      : spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (res.status === 0) {
      return { ok: true, version: (res.stdout ?? '').trim().split(/\r?\n/)[0] };
    }
    return { ok: false, error: (res.stderr ?? res.error?.message ?? `saiu com ${res.status}`).trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Confere as flags usadas contra a ajuda local do binario encontrado. */
export function probeClaudeFlags(binPath, timeoutMs = DEFAULT_TIMEOUTS.claudeHelpMs) {
  try {
    const res = spawnSync(binPath, ['--help'], {
      encoding: 'utf8',
      timeout: timeoutMs,
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

/**
 * Monta o relatorio inteiro. NUNCA lanca por pre-requisito ausente: cada
 * sonda e isolada e a ausencia vira entrada em `problems`. E a funcao que se
 * roda quando nada funciona, entao ela mesma nao pode ser mais uma coisa que
 * quebra.
 *
 * @param {{ cwd?: string, env?: object, pkgRoot: string, timeouts?: object }} opts
 * @returns {object} relatorio; `ok` e false quando ha problema essencial
 */
export function buildDoctorReport({ cwd = process.cwd(), env = process.env, pkgRoot, timeouts = {} } = {}) {
  const tempos = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const problems = [];

  let claude = { ok: false, error: 'nao avaliado' };
  try {
    const found = resolveClaudeBinary({ env });
    claude = { ok: true, path: found.path, version: found.version };
  } catch (err) {
    claude = { ok: false, error: err.message };
    problems.push({
      what: 'binario do Claude Code nao encontrado ou nao executa',
      fix: 'CCX_CLAUDE_BIN="<caminho absoluto do claude>" ccx doctor',
    });
  }

  const flags = claude.ok
    ? probeClaudeFlags(claude.path, tempos.claudeHelpMs)
    : { checked: false, error: 'sem binario' };
  if (flags.checked && (flags.missing ?? []).length > 0) {
    problems.push({
      what: `flags que o supervisor usa nao aparecem na ajuda local: ${flags.missing.join(', ')}`,
      fix: `"${claude.path}" --help    e conferir o nome novo antes de despachar`,
    });
  }

  let candidates = [];
  try {
    candidates = probeStateRoots({ cwd, env }) ?? [];
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

  const missingModules = missingRuntimeModules(pkgRoot);
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
  const skillDir = path.join(pkgRoot, 'skill');
  if (!fs.existsSync(skillDir)) {
    warnings.push('o diretorio skill/ nao existe: ccx install-skill nao tem o que copiar.');
  }

  // A ordem importa: o aviso de skill vem antes do de Codex, que e como o
  // relatorio sempre foi lido.
  const codex = probeCodex(tempos.codexVersionMs);
  if (!codex.ok) {
    warnings.push('Codex CLI nao detectado no PATH: o ccx funciona sem ele, mas install-skill nao tem como ser conferido.');
  }

  return {
    version: VERSION,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    claude,
    flags,
    pkg: {
      ok: missingModules.length === 0,
      root: pkgRoot,
      missing: missingModules,
      skillDir: fs.existsSync(skillDir) ? skillDir : null,
    },
    roots: { chosen, candidates },
    codex,
    skills: {
      codexHome: codexHome(env),
      user: userSkillsDir(env),
      project: projectSkillsDir(cwd),
    },
    problems,
    warnings,
    ok: problems.length === 0,
  };
}
