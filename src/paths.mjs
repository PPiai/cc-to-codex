// Descoberta de caminhos: onde gravar o estado e onde esta o Claude.
//
// Este modulo carrega as duas licoes mais caras medidas em 2026-09-11 nesta
// maquina, ambas contra-intuitivas:
//
// 1. Gravabilidade nao se presume. Sob o token restrito testado, EPERM em
//    TODOS os candidatos, inclusive o diretorio de trabalho e o temporario do
//    sistema. Por isso cada candidato e testado escrevendo e removendo um
//    arquivo de verdade, e nao por `fs.access`, que mente sob sandbox.
// 2. O sandbox do Codex nao herda PATH. Chamar `claude` por nome falha com
//    erro 2 do Windows na criacao do processo; o mesmo binario funciona por
//    caminho absoluto. Por isso a resolucao e manual e o retorno e sempre
//    absoluto.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { EXIT, FILES, SESSIONS_DIRNAME } from './protocol.mjs';
import { fail } from './errors.mjs';

// ---------------------------------------------------------------------------
// Raiz de estado
// ---------------------------------------------------------------------------

/**
 * Diretorio de estado por plataforma, o quarto candidato da secao 8 da spec.
 * Lido do ambiente injetado, nunca de `process.env` direto, para que o teste
 * consiga simular uma maquina diferente desta.
 */
/**
 * Temporario do sistema, o terceiro candidato.
 *
 * Lido do ambiente injetado em vez de `os.tmpdir()` direto: aquela funcao
 * consulta o `process.env` real e ignoraria o ambiente passado, o que tornaria
 * este candidato impossivel de simular no teste. `os.tmpdir()` fica como
 * ultimo recurso, para quando o ambiente nao declara nada.
 */
function tmpRoot(env) {
  const raw =
    process.platform === 'win32'
      ? env.TEMP || env.TMP || os.tmpdir()
      : env.TMPDIR || os.tmpdir();
  return path.join(raw, 'cc-to-codex');
}

function appStateDir(env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'cc-to-codex');
  }
  const xdg = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(xdg, 'cc-to-codex');
}

/**
 * Candidatos em ordem de precedencia, com a origem anotada.
 *
 * A origem entra no retorno porque a mensagem de erro precisa dizer POR QUE
 * cada caminho foi tentado. "EPERM em C:\Users\x\AppData\Local\cc-to-codex"
 * sozinho nao ajuda ninguem a agir.
 */
function stateRootCandidates({ cwd, env }) {
  const base = path.resolve(cwd || process.cwd());
  const out = [];
  if (env.CCX_STATE_DIR && String(env.CCX_STATE_DIR).trim().length > 0) {
    out.push({ path: path.resolve(String(env.CCX_STATE_DIR).trim()), source: 'CCX_STATE_DIR' });
  }
  out.push({ path: path.join(base, '.ccx'), source: 'diretorio de trabalho' });
  out.push({ path: tmpRoot(env), source: 'temporario do sistema' });
  out.push({ path: appStateDir(env), source: 'estado de aplicacao do usuario' });
  return out;
}

/**
 * Niveis de diretorio que ainda nao existem, do mais raso para o mais fundo.
 * Usado para desfazer exatamente o que a sondagem criou: o `doctor` e
 * declarado como comando que nao altera nada, e criar arvore de diretorio
 * seria alterar.
 */
function missingLevels(dir) {
  const levels = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    levels.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return levels;
}

function removeLevels(levels) {
  // Do mais fundo para o mais raso, e sempre tolerante: se alguem passou a
  // usar o diretorio entre a criacao e a remocao, o rmdir falha por nao estar
  // vazio e isso e o comportamento desejado.
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    try {
      fs.rmdirSync(levels[i]);
    } catch {
      return;
    }
  }
}

/**
 * Teste de gravabilidade real: cria a arvore, escreve, le de volta, remove, e
 * desfaz o que criou.
 *
 * O codigo de erro do `mkdir` conta tanto quanto o do `write`, porque sob
 * sandbox restrito a negacao normalmente aparece primeiro na criacao do
 * diretorio, e era justamente esse codigo que se perdia numa implementacao
 * ingenua que so instrumentava a escrita.
 */
function probeDir(target, { source = null } = {}) {
  const abs = path.resolve(target);
  let created = [];
  try {
    created = missingLevels(abs);
    fs.mkdirSync(abs, { recursive: true });
  } catch (err) {
    return { path: abs, ok: false, code: err.code || 'EMKDIR', source };
  }

  const probe = path.join(abs, `.ccx-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(probe, 'ccx');
    fs.unlinkSync(probe);
  } catch (err) {
    try {
      fs.unlinkSync(probe);
    } catch {
      // Escrita parcial sob sandbox pode deixar o arquivo. Nao e fatal.
    }
    removeLevels(created);
    return { path: abs, ok: false, code: err.code || 'EWRITE', source };
  }

  removeLevels(created);
  return { path: abs, ok: true, code: null, source };
}

function noWritableRootError(candidates) {
  const lines = candidates.map(
    (c, i) => `  ${i + 1}. ${c.path}\n     origem: ${c.source || 'candidato padrao'}   erro: ${c.code || 'desconhecido'}`,
  );
  const message = [
    'Nenhuma raiz de estado gravavel. O ccx recusa despachar em vez de criar',
    'uma sessao que perde o proprio estado.',
    '',
    'Candidatos testados, em ordem:',
    ...lines,
    '',
    'Tres saidas concretas:',
    '  1. Defina CCX_STATE_DIR apontando para um caminho gravavel e repita.',
    '  2. Rode o Codex permitindo escrita num diretorio extra, acrescentando o',
    '     caminho em writable_roots na secao [sandbox_workspace_write] do',
    '     config.toml do Codex.',
    '  3. Marque o projeto como confiavel no config.toml do Codex, com',
    '     trust_level = "trusted" na entrada do projeto em [projects].',
  ].join('\n');
  return fail(EXIT.NO_WRITABLE_ROOT, message, { candidates });
}

/**
 * Resolve a raiz de estado, testando gravabilidade de verdade.
 *
 * Ordem: CCX_STATE_DIR, <cwd>/.ccx, temporario do sistema, diretorio de
 * estado de aplicacao do usuario. Para na primeira que aceita escrita, cria a
 * raiz escolhida junto com o diretorio de sessoes, e devolve a trilha de
 * tentativas para o `doctor` e para a mensagem de erro.
 *
 * @param {{cwd?: string, env?: object}} [opts]
 * @returns {{root: string, candidates: Array<{path:string, ok:boolean, code:string|null, source:string|null}>}}
 */
export function resolveStateRoot({ cwd, env = process.env } = {}) {
  const candidates = [];
  for (const candidate of stateRootCandidates({ cwd, env })) {
    const result = probeDir(candidate.path, { source: candidate.source });
    candidates.push(result);
    if (!result.ok) continue;

    // A sondagem desfaz o que criou, de proposito, para que `probeStateRoots`
    // seja inofensivo. Aqui recriamos o vencedor, que e o unico efeito
    // colateral desejado desta funcao.
    try {
      fs.mkdirSync(sessionsDir(result.path), { recursive: true });
    } catch (err) {
      candidates[candidates.length - 1] = {
        ...result,
        ok: false,
        code: err.code || 'EMKDIR',
      };
      continue;
    }
    return { root: result.path, candidates };
  }
  throw noWritableRootError(candidates);
}

/**
 * Igual ao acima, mas nao cria nada e nao lanca. Para o doctor.
 *
 * Testa todos os candidatos, nao para no primeiro, porque o valor do
 * diagnostico esta em ver a linha inteira.
 *
 * @param {{cwd?: string, env?: object}} [opts]
 * @returns {Array<{path:string, ok:boolean, code:string|null, source:string|null}>}
 */
export function probeStateRoots({ cwd, env = process.env } = {}) {
  return stateRootCandidates({ cwd, env }).map((candidate) =>
    probeDir(candidate.path, { source: candidate.source }),
  );
}

export function sessionsDir(root) {
  return path.join(path.resolve(root), SESSIONS_DIRNAME);
}

export function sessionDir(root, id) {
  return path.join(sessionsDir(root), String(id));
}

/**
 * Caminho de um arquivo de sessao. `key` vem de FILES.
 *
 * Chave desconhecida e erro de uso e nao caminho terminado em "undefined":
 * um erro de digitacao num modulo vizinho precisa estourar no ponto da
 * chamada, nao virar arquivo fantasma em disco.
 */
export function filePath(root, id, key) {
  const name = FILES[key];
  if (!name) {
    throw fail(EXIT.USAGE, `chave de arquivo desconhecida: ${String(key)}. Validas: ${Object.keys(FILES).join(', ')}`);
  }
  return path.join(sessionDir(root, id), name);
}

// ---------------------------------------------------------------------------
// Binario do Claude Code
// ---------------------------------------------------------------------------

function homeDir(env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/**
 * Extensoes executaveis do Windows, na ordem em que vale a pena tentar.
 *
 * `.EXE` e `.COM` vao primeiro porque sao executaveis de verdade. Envelope de
 * script (`.CMD`, `.BAT`) fica por ultimo: desde o Node 20 o spawn de script
 * de lote exige shell, entao preferir o binario real evita empurrar esse
 * problema para o supervisor.
 */
function windowsExtensions(env) {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const list = raw
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  const rank = (ext) => {
    const up = ext.toUpperCase();
    if (up === '.EXE') return 0;
    if (up === '.COM') return 1;
    return 2;
  };
  const sorted = [...new Set(list)].sort((a, b) => rank(a) - rank(b));
  // Nome sem extensao entra no fim: raro no Windows, mas inofensivo e cobre
  // instalacao feita por gerenciador que nao criou envelope.
  sorted.push('');
  return sorted;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isRunnableFile(candidate) {
  if (!isFile(candidate)) return false;
  if (process.platform === 'win32') return true;
  // Script Node e executado pelo Node, entao o bit de execucao nao decide
  // nada. Exigi-lo faria a suite de testes falhar em Linux e macOS, porque
  // arquivo recem escrito por clone de repositorio nao costuma vir marcado
  // como executavel.
  if (/\.(mjs|cjs|js)$/i.test(candidate)) return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Candidatos de binario, em ordem de precedencia, com origem anotada.
 *
 * A varredura de PATH e manual de proposito: `which` e `where` nao sao
 * confiaveis sob sandbox, porque o proprio utilitario pode nao estar
 * alcancavel e porque resolvem contra o PATH do shell, que e exatamente o que
 * nao foi herdado.
 */
function* claudeCandidates(env) {
  const explicit = env.CCX_CLAUDE_BIN && String(env.CCX_CLAUDE_BIN).trim();
  if (explicit) {
    yield { path: path.resolve(explicit), source: 'CCX_CLAUDE_BIN' };
  }

  const isWin = process.platform === 'win32';
  const extensions = isWin ? windowsExtensions(env) : [''];
  // No Windows a variavel chega com caixa variavel. `process.env` disfarca
  // isso, mas o objeto injetado no teste nao, entao conferimos as tres.
  const rawPath = env.PATH || env.Path || env.path || '';
  for (const dir of rawPath.split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    for (const ext of extensions) {
      yield { path: path.resolve(trimmed, `claude${ext}`), source: 'PATH' };
    }
  }

  const home = homeDir(env);
  const known = [
    ['.local', 'bin', 'claude'],
    ['.claude', 'local', 'claude'],
    ['.bun', 'bin', 'claude'],
    ['AppData', 'Roaming', 'npm', 'claude'],
    ['.npm-global', 'bin', 'claude'],
  ];
  for (const parts of known) {
    const base = path.join(home, ...parts);
    for (const ext of extensions) {
      yield { path: `${base}${ext}`, source: 'candidato conhecido sob o home' };
    }
  }
}

/**
 * Confirma que o candidato executa e captura a versao.
 *
 * Validar por execucao, e nao por existencia, e o que distingue "achei um
 * arquivo com o nome certo" de "achei o Claude". `--version` nao inicia
 * sessao e portanto nao consome cota.
 */
function probeVersion(binary) {
  const isBatch = /\.(cmd|bat)$/i.test(binary);
  // Envelope de lote no Windows nao e spawnavel diretamente desde o Node 20.
  // Invocamos o interpretador de comando de forma explicita em vez de ligar a
  // opcao de shell, por dois motivos. Primeiro, passar argumentos com shell
  // ligado emite aviso de depreciacao que poluiria o stderr de todo dispatch e
  // de todo doctor. Segundo, com shell ligado os argumentos sao concatenados
  // sem escape, e foi exatamente esse caminho que truncou o contrato de
  // sentinela quando medido: o interpretador corta o texto no primeiro espaco
  // ou na primeira quebra de linha. Aqui o risco e pequeno porque o argumento
  // e fixo, mas nao queremos o padrao perigoso presente no codigo.
  // Script Node roda pelo Node. O supervisor faz o mesmo, e as duas pontas
  // precisam concordar: se a sondagem rejeita um alvo que o supervisor
  // aceitaria, um Claude falso escrito em Node nunca passa da validacao e o
  // teste de integracao fica impossivel sem binario compilado.
  const isNodeScript = /\.(mjs|cjs|js)$/i.test(binary);
  const [cmd, args] = isBatch
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', binary, '--version']]
    : isNodeScript
      ? [process.execPath, [binary, '--version']]
      : [binary, ['--version']];
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    shell: false,
  });
  if (res.error) {
    return { ok: false, code: res.error.code || String(res.error.errno || 'ESPAWN') };
  }
  if (res.status !== 0) {
    return { ok: false, code: `exit ${res.status}` };
  }
  const text = `${res.stdout || ''} ${res.stderr || ''}`;
  const match = text.match(/(\d+\.\d+\.\d+[\w.+-]*)/);
  return { ok: true, version: match ? match[1] : text.trim().split(/\r?\n/)[0] || 'desconhecida' };
}

/**
 * Encontra o executavel do Claude Code.
 *
 * Percorre TODOS os candidatos antes de desistir: um arquivo com o nome certo
 * que nao responde `--version` nao pode bloquear um candidato seguinte que
 * responde. So depois de esgotar a lista o erro e lancado, com a trilha
 * inteira na mensagem.
 *
 * @param {{env?: object}} [opts]
 * @returns {{path: string, version: string}}
 */
export function resolveClaudeBinary({ env = process.env } = {}) {
  const attempts = [];
  const seen = new Set();

  // Quando o chamador aponta um binario de forma explicita, ele e a UNICA
  // fonte. Cair para o proximo candidato quando o explicito falha e um
  // comportamento perigoso, e nao teorico: custou uma sessao real durante a
  // integracao. Apontamos a variavel para um Claude falso, a sondagem de
  // versao do falso falhou, a busca seguiu para o PATH e subiu o Claude de
  // verdade em modo autonomo com escrita em disco. Quem pede um binario
  // especifico e recebe outro perde justamente a garantia que foi buscar.
  const explicitRequested = Boolean(env.CCX_CLAUDE_BIN && String(env.CCX_CLAUDE_BIN).trim());

  for (const candidate of claudeCandidates(env)) {
    const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key);

    // Com binario explicito pedido, nenhum outro candidato e sequer olhado.
    if (explicitRequested && candidate.source !== 'CCX_CLAUDE_BIN') continue;

    if (!isRunnableFile(candidate.path)) {
      // Nao entra na trilha: a varredura de PATH gera centenas de caminhos
      // inexistentes e listar todos afogaria a mensagem de erro. So o
      // candidato explicito merece registro quando nem existe.
      if (candidate.source === 'CCX_CLAUDE_BIN') {
        attempts.push({ ...candidate, code: 'nao existe ou nao e executavel' });
      }
      continue;
    }

    const probe = probeVersion(candidate.path);
    if (probe.ok) {
      return { path: candidate.path, version: probe.version };
    }
    attempts.push({ ...candidate, code: probe.code });
  }

  if (explicitRequested) {
    throw fail(
      EXIT.MISSING_PREREQ,
      [
        'CCX_CLAUDE_BIN aponta para um binario que nao respondeu --version.',
        '',
        `  caminho: ${path.resolve(String(env.CCX_CLAUDE_BIN).trim())}`,
        attempts.length > 0 ? `  falha:   ${attempts[0].code}` : '',
        '',
        'A busca NAO continua para o PATH quando esta variavel esta definida,',
        'de proposito: quem aponta um binario especifico nao pode receber outro',
        'em silencio e acabar rodando o Claude real pensando que e um falso.',
        '',
        'Saidas: corrija o caminho, faca o alvo responder --version, ou remova',
        'a variavel para deixar a descoberta automatica agir.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
  }

  const trail =
    attempts.length > 0
      ? attempts.map((a) => `  - ${a.path}\n    origem: ${a.source}   falha: ${a.code}`).join('\n')
      : '  (nenhum arquivo chamado claude foi encontrado em CCX_CLAUDE_BIN, no PATH ou nos candidatos sob o home)';

  throw fail(
    EXIT.MISSING_PREREQ,
    [
      'Binario do Claude Code nao encontrado, ou encontrado e sem responder --version.',
      '',
      'Tentativas:',
      trail,
      '',
      'Saida: defina CCX_CLAUDE_BIN com o caminho ABSOLUTO do executavel.',
      'Medido em 2026-09-11: o sandbox do Codex nao herda PATH, entao chamar',
      'por nome falha com erro 2 do Windows e so o caminho absoluto funciona.',
    ].join('\n'),
    { attempts },
  );
}
