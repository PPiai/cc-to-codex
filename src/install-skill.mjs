// Instalador da skill nos caminhos do Codex.
//
// Onde a skill vai, e por que:
//
// - Escopo de projeto (PADRAO): `<dir>/.agents/skills/<nome>/`. E o unico
//   caminho observado em execucao nesta maquina, via dump de prompt do
//   proprio Codex, entao e o padrao por ser o mais firme.
// - Escopo de usuario: `<CODEX_HOME>/skills/<nome>/`, com CODEX_HOME
//   caindo em `~/.codex`. A documentacao do Codex aponta outro caminho,
//   mas a skill embutida de instalacao do proprio Codex declara este, e
//   ferramenta que executa a instalacao descreve o comportamento real
//   melhor que documentacao descreve intencao. Medido em 2026-09-11: o
//   dump de prompt desta maquina lista como raiz ativa
//   `C:/Users/dev/.codex/skills/.system`, que e subpasta exatamente
//   deste diretorio.
//
// O que ficou sem medir: nenhuma skill de USUARIO existia nesta maquina,
// entao o carregamento de `<CODEX_HOME>/skills/<nome>` nao foi observado em
// execucao. Por isso o comando termina imprimindo a instrucao de conferir
// antes de confiar. Ver `verifyHint`.
//
// Este modulo nao imprime nem sai do processo: devolve plano e resultado,
// e `bin/ccx.mjs` decide o que mostrar e com que codigo sair.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT } from './protocol.mjs';
import { fail } from './errors.mjs';

export const SCOPES = ['project', 'user'];

// Nome de pasta usado quando o SKILL.md nao declara `name`. Nao inventamos
// conteudo de skill aqui: o corpo vem do diretorio `skill/` do pacote.
const FALLBACK_NAME = 'cc-to-codex';

// Subcomando de listagem de skills nao existe no Codex 0.154.0 (conferido
// por `codex --help` e por `codex skills --help`, que cai na ajuda geral).
// O que existe, e foi o que provou a raiz ativa nesta maquina, e o dump de
// prompt. Entao a instrucao de conferencia aponta para ele, em vez de citar
// um comando de listagem que nao existiria.
const VERIFY_COMMAND = 'codex debug prompt-input';

/**
 * Raiz do pacote, a partir deste arquivo. Usada para achar `skill/`.
 * Caminho derivado, nunca cravado: o pacote pode estar em qualquer lugar.
 */
export function packageRoot() {
  // fileURLToPath em vez de mexer em `pathname` na mao: no Windows o
  // pathname vem como `/C:/...` e qualquer gambiarra de regex aqui quebra
  // em caminho com espaco ou acento, que e exatamente o caso desta maquina.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Diretorio de configuracao do Codex. */
export function codexHome(env = process.env) {
  return env.CODEX_HOME && env.CODEX_HOME.trim().length > 0
    ? path.resolve(env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

/** Onde skills de projeto ficam, dado um diretorio de trabalho. */
export function projectSkillsDir(cwd) {
  return path.join(path.resolve(cwd), '.agents', 'skills');
}

/** Onde skills de usuario ficam. */
export function userSkillsDir(env = process.env) {
  return path.join(codexHome(env), 'skills');
}

/**
 * Caminhada recursiva propria.
 *
 * `fs.readdirSync(dir, { recursive: true })` so existe no Node 20, e o piso
 * declarado no package.json e 18.18. Dez linhas custam menos que um
 * requisito de versao mais alto.
 *
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]} caminhos relativos, com separador da plataforma
 */
export function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? entry.name : path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Le o nome declarado no frontmatter do SKILL.md.
 *
 * Preferimos o nome declarado porque o diretorio de destino e o que o Codex
 * casa com o nome da skill; divergir criaria uma skill que lista com um
 * nome e mora em outro.
 */
function readDeclaredName(skillMdPath) {
  try {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const fence = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fence) return null;
    const match = fence[1].match(/^name:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Monta o plano de instalacao sem tocar no disco de destino.
 *
 * @param {{ cwd?: string, scope?: string, dir?: string|null, env?: object, root?: string }} opts
 * @returns {{
 *   scope: string, name: string, sourceDir: string, destDir: string,
 *   files: Array<{ rel: string, from: string, to: string, bytes: number }>,
 *   destExists: boolean, overwrites: string[]
 * }}
 */
export function planInstall(opts = {}) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const scope = opts.scope ?? 'project';

  if (!SCOPES.includes(scope)) {
    throw fail(EXIT.USAGE, `escopo invalido: ${scope}. use ${SCOPES.join(' ou ')}.`);
  }

  const sourceDir = path.join(opts.root ?? packageRoot(), 'skill');
  if (!fs.existsSync(sourceDir)) {
    throw fail(
      EXIT.MISSING_PREREQ,
      `diretorio da skill nao existe: ${sourceDir}. ` +
        'o conteudo da skill faz parte do pacote; reinstale o cc-to-codex ou rode a partir da raiz dele.',
    );
  }
  const skillMd = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    throw fail(EXIT.MISSING_PREREQ, `SKILL.md nao existe em ${sourceDir}.`);
  }

  const name = readDeclaredName(skillMd) ?? FALLBACK_NAME;

  // `--dir` troca a RAIZ de destino, nao o caminho final: o sufixo
  // (`.agents/skills` ou `skills`) e o que o Codex procura, entao ele
  // continua sendo aplicado.
  const base = opts.dir ? path.resolve(opts.dir) : null;
  const parent =
    scope === 'project'
      ? base
        ? path.join(base, '.agents', 'skills')
        : projectSkillsDir(cwd)
      : base
        ? path.join(base, 'skills')
        : userSkillsDir(env);

  const destDir = path.join(parent, name);
  const rels = walk(sourceDir).sort();
  const files = rels.map((rel) => {
    const from = path.join(sourceDir, rel);
    return { rel, from, to: path.join(destDir, rel), bytes: fs.statSync(from).size };
  });

  const destExists = fs.existsSync(destDir);
  const overwrites = destExists ? files.filter((f) => fs.existsSync(f.to)).map((f) => f.rel) : [];

  return { scope, name, sourceDir, destDir, files, destExists, overwrites };
}

/**
 * Aplica o plano. Copia arquivo por arquivo em vez de `fs.cpSync` recursivo
 * para poder contar e reportar exatamente o que foi escrito, que e o mesmo
 * que o `--dry-run` promete.
 *
 * @param {ReturnType<typeof planInstall>} plan
 * @returns {{ written: number, bytes: number, destDir: string }}
 */
export function applyInstall(plan) {
  let written = 0;
  let bytes = 0;
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.to), { recursive: true });
    fs.copyFileSync(file.from, file.to);
    written += 1;
    bytes += file.bytes;
  }
  return { written, bytes, destDir: plan.destDir };
}

/**
 * Instrucao de conferencia, impressa sempre ao terminar.
 *
 * Existe porque a incerteza sobre o escopo de usuario e real e estreita:
 * o caminho foi deduzido da ferramenta oficial de instalacao do Codex, mas
 * o carregamento nao foi observado em execucao. Confiar sem conferir seria
 * assumir o que nao medimos.
 *
 * @param {ReturnType<typeof planInstall>} plan
 * @returns {string}
 */
export function verifyHint(plan) {
  const lines = [
    'confira antes de confiar:',
    `  ${VERIFY_COMMAND}`,
    `  e procure "${plan.name}" na secao de skills do dump de prompt.`,
  ];
  if (plan.scope === 'project') {
    lines.push(
      'rode o comando de dentro do diretorio do projeto: a raiz de skills de',
      'projeto so aparece no dump quando existe no diretorio corrente.',
    );
  } else {
    lines.push(
      'escopo de usuario: o caminho vem da skill de instalacao embutida do',
      'proprio Codex, mas nao foi possivel observar o carregamento de skill de',
      'usuario em execucao nesta maquina. se nao aparecer, use --scope project.',
    );
  }
  return lines.join('\n');
}
