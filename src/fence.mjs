// Cerca de diretorio: hook de pre-uso de ferramenta.
//
//   node src/fence.mjs --cwd <abs>
//
// LIMITE DECLARADO, e a parte mais importante deste arquivo:
// a cerca e DEFESA EM PROFUNDIDADE, NAO FRONTEIRA. Ela cobre as ferramentas
// cujos argumentos carregam caminho. A ferramenta de shell CONTORNA a cerca
// sem esforco: basta mudar de diretorio, usar caminho absoluto, ou invocar
// outro programa que escreva onde quiser. Analisar linha de comando de shell
// para decidir isso e problema mal posto, e uma lista de padroes daria falsa
// confianca. Quem precisa de fronteira real isola por copia de trabalho.
// A skill e o README repetem isso com estas palavras.
//
// Segunda limitacao, da mesma familia: a checagem e LEXICA. Nao resolvemos
// link simbolico, porque `Write` cria arquivo que ainda nao existe e
// `realpath` falharia no caso normal. Logo, um link dentro do diretorio
// apontando para fora passa.
//
// Regra de ouro do canal de saida: o stdout e o canal de DECISAO e so recebe
// JSON quando a decisao e negar. Autorizacao explicita nao e emitida NUNCA,
// porque `permissionDecision: "allow"` no Claude Code nao significa "pode
// passar": significa pular o fluxo normal de permissao, o que sobreporia o
// `--permission-mode` escolhido no despacho e escalaria privilegio em toda
// escrita que a cerca nem se propoe a julgar. Silencio com saida 0 delega ao
// fluxo normal, que e exatamente o desejado. Diagnostico vai para o stderr.
//
// Consequencia agradavel: todo caminho de falha deste script (stdin ilegivel,
// JSON invalido, `--cwd` ausente, campo de caminho inexistente) degrada para
// silencio, o que realiza sozinho a regra "em duvida, permite e registra".

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Ferramentas consideradas, por contrato. Sao as que trazem caminho no
// argumento; incluir a ferramenta de shell aqui seria teatro.
const FENCED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

// Campos de caminho conhecidos, em ordem de especificidade.
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'];

/**
 * Normaliza para comparacao de fronteira.
 *
 * A comparacao e sem distincao de caixa apenas no Windows, onde o sistema de
 * arquivos e assim. Fazer isso em toda plataforma quebraria projeto em Linux
 * com dois diretorios que diferem so na caixa.
 */
function normalizeForCompare(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True se `target` esta dentro de `root`, ou e o proprio `root`.
 *
 * O separador na fronteira e o ponto todo desta funcao: comparacao por
 * prefixo cru deixaria `C:\proj-outro\x.ts` passar como se estivesse dentro
 * de `C:\proj`, porque a string comeca igual. Exigir que o proximo caractere
 * seja separador elimina a classe inteira de irmao com nome prefixo.
 *
 * Exportada para ser testavel isoladamente, que e o unico jeito de provar
 * essa propriedade sem orquestrar um hook.
 */
export function isInside(root, target) {
  const base = normalizeForCompare(root);
  const candidate = normalizeForCompare(target);
  if (candidate === base) return true;
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  return candidate.startsWith(withSep);
}

function firstPathField(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  for (const field of PATH_FIELDS) {
    const value = toolInput[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

/**
 * Decide sobre uma chamada de ferramenta.
 *
 * Funcao pura, sem I/O, para que o teste exercite a decisao sem processo.
 * Devolve o motivo junto, porque o motivo e o que o orquestrador le na lista
 * de negacoes do resultado do turno, e "negado" sem caminho e inutil.
 *
 * @param {{root: string|null, toolName: string, toolInput: object}} input
 * @returns {{deny: boolean, reason: string|null, target: string|null, note: string|null}}
 */
export function decide({ root, toolName, toolInput }) {
  const silent = (note) => ({ deny: false, reason: null, target: null, note });

  if (!root || String(root).trim().length === 0) {
    // Sem diretorio declarado nao existe cerca a aplicar. Nao inventamos um a
    // partir do payload: uma cerca cujo raio vem do proprio vigiado nao cerca.
    return silent('sem --cwd, cerca inativa');
  }
  if (!FENCED_TOOLS.has(toolName)) {
    return silent(`ferramenta fora do escopo da cerca: ${String(toolName)}`);
  }

  const found = firstPathField(toolInput);
  if (!found) {
    return silent(`${toolName} sem campo de caminho reconhecido`);
  }

  let target;
  try {
    // Caminho relativo e resolvido contra o diretorio declarado, que e o
    // mesmo que o Claude recebeu como cwd.
    target = path.resolve(root, found.value);
  } catch {
    return silent('caminho nao resolvivel');
  }

  if (isInside(root, target)) {
    return { deny: false, reason: null, target, note: 'dentro do escopo' };
  }

  return {
    deny: true,
    target,
    note: 'fora do escopo',
    reason:
      `Bloqueado pela cerca do ccx: ${toolName} em "${target}" cai fora do diretorio ` +
      `declarado no despacho ("${path.resolve(root)}"). Trabalhe dentro desse diretorio. ` +
      'Se a tarefa realmente exige escrever fora, pare e pergunte ao orquestrador com @@ASK:.',
  };
}

/**
 * Registra a decisao. Vai para o stderr por padrao, porque o stdout e o canal
 * de decisao e qualquer byte a mais nele viraria JSON invalido.
 *
 * O stderr do hook e capturado pelo Claude Code no evento de resposta de hook,
 * entao o "registra" da regra "em duvida, permite e registra" acontece de
 * verdade e fica no fluxo que o supervisor ja consome.
 */
function log(line, logFile) {
  const text = `[ccx-fence] ${line}\n`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, text);
      return;
    } catch {
      // Log inacessivel nunca pode quebrar a cerca. Cai para o stderr.
    }
  }
  try {
    process.stderr.write(text);
  } catch {
    // Sem stderr tambem nao ha nada a fazer.
  }
}

/**
 * Parser minimo de argumentos, deliberadamente local.
 *
 * Nao importa `src/args.mjs` de proposito: este script roda como hook dentro
 * do processo do Claude, e toda dependencia a mais e uma chance a mais de a
 * cerca nao subir. Superficie de argumento aqui sao duas flags.
 */
function parseArgv(argv) {
  const out = { cwd: null, logFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cwd' && i + 1 < argv.length) {
      out.cwd = argv[i + 1];
      i += 1;
    } else if (token === '--log' && i + 1 < argv.length) {
      out.logFile = argv[i + 1];
      i += 1;
    } else if (token.startsWith('--cwd=')) {
      out.cwd = token.slice('--cwd='.length);
    } else if (token.startsWith('--log=')) {
      out.logFile = token.slice('--log='.length);
    }
  }
  return out;
}

/**
 * Ponto de entrada. Sempre devolve 0: um hook que falha com codigo diferente
 * de zero viraria negacao ou ruido, e nenhum dos dois e o que queremos quando
 * o problema e no proprio script.
 */
export function main(argv = []) {
  const { cwd, logFile } = parseArgv(argv);

  let raw = '';
  try {
    // Descritor 0 lido de forma sincrona: zero dependencia e sem laco de
    // eventos, o que mantem o hook barato no caminho quente.
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    log(`stdin ilegivel (${(err && err.code) || 'erro'}), permitindo`, logFile);
    return 0;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log('stdin nao e JSON, permitindo', logFile);
    return 0;
  }

  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolInput = payload && payload.tool_input;

  let verdict;
  try {
    verdict = decide({ root: cwd, toolName, toolInput });
  } catch (err) {
    log(`decisao falhou (${(err && err.message) || 'erro'}), permitindo`, logFile);
    return 0;
  }

  if (!verdict.deny) {
    log(`permitido ${toolName || '(sem ferramenta)'}: ${verdict.note}`, logFile);
    return 0;
  }

  log(`NEGADO ${toolName} -> ${verdict.target}`, logFile);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: verdict.reason,
      },
    }),
  );
  return 0;
}

// Executa so quando chamado direto. Importar este modulo num teste nao pode
// tentar ler stdin.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
