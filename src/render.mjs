// Saida para humano. A saida de maquina e JSON e nao passa por aqui.
//
// Este modulo carrega a razao de existir do projeto: o estado compacto.
// O orquestrador precisa acompanhar uma sessao longa sem ler o fluxo bruto,
// entao `renderStatus` tem contrato de TAMANHO, nao so de conteudo: cabe em
// no maximo MAX_STATUS_LINES linhas para QUALQUER tarefa, por longa que
// seja, e cada linha cabe na largura de um terminal estreito para que
// nenhuma linha logica vire duas linhas visuais.
//
// Os limites de `protocol.mjs` garantem que o ESTADO em disco ja nasce
// agregado. Os limites deste arquivo sao um segundo corte, de APRESENTACAO:
// `LIMITS.question` permite 600 caracteres, que a 68 colunas seriam nove
// linhas e estourariam o orcamento. Por isso existem as constantes DISPLAY
// abaixo, derivadas do orcamento de 15 linhas e nao de gosto pessoal.

import { LIMITS, STATUS, shorten } from './protocol.mjs';

// Orcamento de linhas do estado compacto. A aritmetica que o garante:
// 12 linhas fixas (sessao, estado, fase, cwd, claude, turnos, tools,
// arquivos, negacoes, custo, ultima, cursor) + no maximo 2 linhas de
// pergunta + no maximo 1 linha de erro = 15.
const MAX_STATUS_LINES = 15;

// Largura alvo. 78 e o maior valor que sobrevive a um terminal de 80
// colunas sem reflow, contando o caractere de quebra.
const WIDTH = 78;
const LABEL_WIDTH = 8;
const INDENT = ' '.repeat(LABEL_WIDTH + 2);
const VALUE_WIDTH = WIDTH - LABEL_WIDTH - 2;

const DISPLAY = {
  // Uma linha para a ultima frase do assistente. Quem quer o texto inteiro
  // usa `ccx result`, que gasta contexto de proposito.
  lastMessage: VALUE_WIDTH,
  // Duas linhas para a pergunta pendente: e o unico campo que o
  // orquestrador precisa ler por inteiro para poder responder, e cortar
  // curto demais aqui obrigaria uma segunda chamada so para descobrir a
  // pergunta. O texto integral sai em `--json`.
  questionLines: 2,
  // Quantas ferramentas distintas aparecem nomeadas antes de virar "+n".
  tools: 6,
  // Quantos arquivos aparecem nomeados antes de virar "+n".
  files: 3,
  // Quantas amostras de negacao aparecem nomeadas antes de virar "+n".
  denials: 2,
};

// Rotulos em portugues para leitura humana, conforme a secao 5.4 da spec.
// O valor canonico continua sendo o ingles de STATUS, que e o que sai no
// JSON. Isto e mapa de APRESENTACAO, nao redefinicao de constante.
const STATUS_LABELS = {
  [STATUS.STARTING]: 'iniciando',
  [STATUS.WORKING]: 'trabalhando',
  [STATUS.ASKING]: 'aguardando_resposta',
  [STATUS.AMBIGUOUS]: 'ambiguo',
  [STATUS.BLOCKED]: 'bloqueado',
  [STATUS.DONE]: 'concluido',
  [STATUS.FAILED]: 'falhou',
  [STATUS.STOPPED]: 'parado',
};

/**
 * Rotulo humano de um estado, sem esconder valor desconhecido: se uma
 * versao futura introduzir estado novo, queremos ver o valor cru e nao um
 * "?" que apaga a informacao.
 */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? 'desconhecido');
}

/**
 * Uma linha rotulada, com o valor cortado na largura alvo.
 *
 * O corte pede VALUE_WIDTH-3 porque `shorten` ACRESCENTA reticencias depois
 * de cortar: pedir a largura cheia devolveria largura+3 e a linha passaria
 * de 78 colunas, que e justamente o que estoura em terminal de 80 e
 * transforma uma linha logica em duas visuais.
 */
function row(label, value) {
  return `${label.padEnd(LABEL_WIDTH)}  ${shorten(value, VALUE_WIDTH - 3)}`;
}

/**
 * Linha rotulada montada a mao, preservando espacamento de coluna.
 *
 * Existe porque `shorten` normaliza espaco em branco, entao alinhamento
 * feito com dois ou tres espacos some se passar por ela.
 */
function rawRow(label, value) {
  const text = value.length > VALUE_WIDTH ? `${value.slice(0, VALUE_WIDTH - 3)}...` : value;
  return `${label.padEnd(LABEL_WIDTH)}  ${text}`;
}

/**
 * Corta pela ESQUERDA, preservando o fim.
 *
 * Usado em caminho: `...\projetos\api-gateway` responde "qual projeto?", que e a
 * pergunta que o orquestrador faz ao ler a linha. Cortar pela direita
 * deixaria `C:\Users\dev\Desktop\Sta...`, que nao responde nada.
 */
function tail(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `...${text.slice(text.length - (max - 3))}`;
}

/**
 * Quebra texto em no maximo `maxLines` linhas de VALUE_WIDTH colunas.
 *
 * Corta por espaco quando existe espaco util, e corta seco quando nao
 * existe. O corte seco importa: pergunta sem espaco nenhum (uma URL longa,
 * um identificador) nao pode gerar primeira linha vazia, que era o efeito
 * de empurrar a palavra inteira para a linha seguinte.
 */
function wrap(label, text, maxLines) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const lines = [];
  let rest = clean;

  while (rest.length > 0 && lines.length < maxLines) {
    if (rest.length <= VALUE_WIDTH) {
      lines.push(rest);
      rest = '';
      break;
    }
    let cut = rest.lastIndexOf(' ', VALUE_WIDTH);
    // Espaco perto demais do inicio deixaria a linha quase vazia; nesse
    // caso o corte seco na largura cheia aproveita melhor o espaco.
    if (cut < VALUE_WIDTH * 0.5) cut = VALUE_WIDTH;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  // Sobrou texto: diz onde achar o resto em vez de truncar em silencio.
  // -18 cobre o sufixo de 14 caracteres mais as reticencias que `shorten`
  // acrescenta, sem estourar as 68 colunas de valor.
  if (rest.length > 0) {
    const last = lines[lines.length - 1] ?? '';
    const marked = `${shorten(last, VALUE_WIDTH - 18)} [+ em --json]`;
    if (lines.length === 0) lines.push(marked);
    else lines[lines.length - 1] = marked;
  }

  return lines.map((line, i) => (i === 0 ? `${label.padEnd(LABEL_WIDTH)}  ${line}` : `${INDENT}${line}`));
}

/** Idade legivel. Sem biblioteca, porque sao quatro casos. */
export function formatAge(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '-';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/** Custo com casas suficientes para turno barato, sem zero a toa. */
export function formatUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const fixed = num.toFixed(4);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

function ageFrom(state) {
  const started = Date.parse(state?.startedAt ?? '');
  if (!Number.isFinite(started)) return '-';
  const end = Date.parse(state?.updatedAt ?? '');
  const until = state?.alive === false && Number.isFinite(end) ? end : Date.now();
  return formatAge(until - started);
}

/** `Read x12, Bash x7 (+3 outras)`, ordenado por volume. */
function toolsSummary(toolCounts) {
  const pairs = Object.entries(toolCounts ?? {}).filter(([, n]) => Number(n) > 0);
  if (pairs.length === 0) return 'nenhuma ainda';
  pairs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = pairs.slice(0, DISPLAY.tools).map(([name, n]) => `${name} x${n}`);
  const rest = pairs.length - head.length;
  const total = pairs.reduce((sum, [, n]) => sum + Number(n), 0);
  return `${total} chamadas: ${head.join(', ')}${rest > 0 ? ` (+${rest} outras)` : ''}`;
}

/** Arquivos tocados, com o excedente somado ao que o estado ja descartou. */
function filesSummary(state) {
  const files = Array.isArray(state?.filesTouched) ? state.filesTouched : [];
  if (files.length === 0) return 'nenhum escrito ainda';
  const head = files.slice(0, DISPLAY.files).map((f) => tail(f, 24));
  const hidden = files.length - head.length + Number(state?.filesTouchedExtra ?? 0);
  return `${files.length + Number(state?.filesTouchedExtra ?? 0)}: ${head.join(', ')}${hidden > 0 ? ` (+${hidden})` : ''}`;
}

/**
 * Negacao de permissao nunca e rodape.
 *
 * Uma sessao que terminou com muitas negacoes NAO terminou de verdade: o
 * modelo tentou agir, foi barrado e provavelmente contornou ou desistiu em
 * silencio. Por isso a contagem aparece tambem como sufixo da linha de
 * estado, que e a segunda linha do bloco, e nao apenas na linha `negacoes`.
 */
function denialsSummary(state) {
  const count = Number(state?.permissionDenials ?? 0);
  if (!Number.isFinite(count) || count <= 0) return 'nenhuma';
  const samples = Array.isArray(state?.denialSamples) ? state.denialSamples : [];
  const head = samples.slice(0, DISPLAY.denials).map((s) => shorten(s, 24));
  const rest = Math.max(0, samples.length - head.length);
  const shown = head.length > 0 ? `: ${head.join(', ')}${rest > 0 ? ` (+${rest})` : ''}` : '';
  return `${count}${shown}`;
}

/** `12 turnos, ultimos 3: done x2, ambiguous x1`. */
function turnsSummary(state) {
  const turn = Number(state?.turn ?? 0);
  const log = Array.isArray(state?.turnLog) ? state.turnLog : [];
  if (log.length === 0) {
    return turn > 0 ? `${turn} em andamento, nenhum fechado` : 'nenhum fechado ainda';
  }
  const counts = new Map();
  for (const entry of log) {
    const outcome = String(entry?.outcome ?? 'desconhecido');
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([outcome, n]) => `${statusLabel(outcome)} x${n}`)
    .join(', ');
  const window = log.length < turn ? `, ultimos ${log.length}` : '';
  return `${Math.max(turn, log.length)} fechados${window}: ${breakdown}`;
}

/**
 * Estado compacto de uma sessao. Alvo e teto: 15 linhas.
 *
 * @param {object} state Conteudo de state.json.
 * @returns {string}
 */
export function renderStatus(state) {
  const s = state ?? {};
  const lines = [];

  const label = s.label ? `rotulo ${shorten(s.label, 28)}` : 'sem rotulo';
  lines.push(rawRow('sessao', `${String(s.id ?? '?').padEnd(9)} ${label}`));

  // O alerta de negacao entra na SEGUNDA linha do bloco, colado no estado,
  // e nao num rodape: sessao que fechou com negacao nao terminou de fato, e
  // quem le so o topo do bloco precisa ver isso.
  const denialCount = Number(s.permissionDenials ?? 0);
  const alert = denialCount > 0 ? `   !! ${denialCount} negacoes de permissao` : '';
  lines.push(rawRow('estado', `${statusLabel(s.status).padEnd(denialCount > 0 ? 20 : 0)}${alert}`));

  const phase = s.phase ? `${s.phase}, ` : '';
  lines.push(row('fase', `${phase}turno ${Number(s.turn ?? 0)}, ativa ha ${ageFrom(s)}`));

  lines.push(`${'cwd'.padEnd(LABEL_WIDTH)}  ${tail(s.cwd ?? '?', VALUE_WIDTH)}`);

  const sessionRef = s.claudeSessionId ? String(s.claudeSessionId).slice(0, 8) : 'ainda sem id';
  const alive = s.alive === false ? 'encerrado' : 'vivo';
  // O campo pid do estado e do SUPERVISOR, nao do Claude. Rotular o pid do
  // supervisor como sendo o do Claude manda quem depura inspecionar o
  // processo errado, entao aqui usamos o pid do Claude quando existe.
  lines.push(row('claude', `sessao ${sessionRef}, processo ${s.claudePid ?? s.pid ?? '?'}, ${alive}`));

  lines.push(row('turnos', turnsSummary(s)));
  lines.push(row('tools', toolsSummary(s.toolCounts)));
  lines.push(row('arquivos', filesSummary(s)));
  lines.push(row('negacoes', denialsSummary(s)));
  lines.push(row('custo', `${formatUsd(s.totalCostUsd)} USD acumulado`));
  lines.push(row('ultima', s.lastMessage ? `"${shorten(s.lastMessage, DISPLAY.lastMessage - 2)}"` : '-'));

  if (s.pendingQuestion) {
    for (const line of wrap('pergunta', `"${s.pendingQuestion}"`, DISPLAY.questionLines)) {
      lines.push(line);
    }
  }
  if (s.error) {
    lines.push(row('erro', shorten(s.error, VALUE_WIDTH)));
  }

  const queued = Number(s.queuedCommands ?? 0);
  const queuedNote = queued > 0 ? `, ${queued} comando(s) na fila` : '';
  lines.push(row('cursor', `${Number(s.cursor ?? s.eventCount ?? 0)}${queuedNote}`));

  // Trava de seguranca. A aritmetica acima garante 15, mas um campo novo
  // no estado nao deve poder furar o contrato de tamanho sem que alguem
  // veja: se furar, o corte preserva as linhas de topo e o cursor, que e o
  // que o orquestrador usa para continuar em `ccx log --since`.
  if (lines.length > MAX_STATUS_LINES) {
    return [...lines.slice(0, MAX_STATUS_LINES - 1), lines[lines.length - 1]].join('\n');
  }
  return lines.join('\n');
}

/**
 * Painel de varias sessoes, uma linha por sessao.
 *
 * Leva marcador de negacao tambem, porque num fan-out o `status` detalhado
 * de cada sessao nao vai ser lido: se uma sessao "concluida" esta cheia de
 * negacao, tem que dar para ver daqui.
 */
export function renderList(states) {
  const rows = Array.isArray(states) ? states : [];
  if (rows.length === 0) {
    return 'nenhuma sessao. crie uma com: ccx dispatch --task "..." --cwd <dir>';
  }

  const out = [];
  for (const s of rows) {
    const denials = Number(s?.permissionDenials ?? 0);
    const mark = denials > 0 ? `!${denials}neg` : '';
    const parts = [
      String(s?.id ?? '?').padEnd(9),
      statusLabel(s?.status).padEnd(20),
      `t${Number(s?.turn ?? 0)}`.padEnd(4),
      ageFrom(s).padEnd(7),
      mark.padEnd(7),
      `${formatUsd(s?.totalCostUsd)}USD`.padEnd(10),
      shorten(s?.label ?? '-', 18).padEnd(19),
      tail(s?.cwd ?? '-', 34),
    ];
    out.push(parts.join(' ').replace(/\s+$/, ''));
  }
  return out.join('\n');
}

/**
 * Entradas de log, ja digeridas pelo supervisor.
 *
 * @param {object[]} entries
 * @param {{ id?: string, cursor?: number, remaining?: number }} [meta]
 */
export function renderLog(entries, meta = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const header = row(
    'log',
    `sessao ${meta.id ?? '?'}, ${rows.length} entrada(s), cursor ${Number(meta.cursor ?? 0)}` +
      (Number(meta.remaining ?? 0) > 0 ? `, ${meta.remaining} restante(s)` : ''),
  );
  if (rows.length === 0) {
    return `${header}\n(nada novo desde o cursor informado)`;
  }

  const out = [header];
  for (const e of rows) {
    const n = String(e?.n ?? '?').padStart(5);
    const ts = String(e?.ts ?? '').slice(11, 19) || '--:--:--';
    const kind = String(e?.kind ?? '?').padEnd(11);
    const name = e?.name ? `${e.name} ` : '';
    const detail = shorten(`${name}${e?.detail ?? ''}`, LIMITS.logDetail);
    out.push(`${n}  ${ts}  ${kind} ${detail}`.trimEnd());
  }
  return out.join('\n');
}

/** Retorno do dispatch: curto, e diz qual e o proximo comando. */
export function renderDispatch(state) {
  const s = state ?? {};
  const ref = s.label || s.id || '?';
  return [
    rawRow('sessao', `${String(s.id ?? '?').padEnd(9)} ${s.label ? `rotulo ${s.label}` : 'sem rotulo'}`),
    row('estado', statusLabel(s.status)),
    // Rotulado como supervisor de proposito: e esse o processo que segura a
    // sessao viva, e e o pid que stop e rm consultam.
    row('supervisor', String(s.pid ?? '?')),
    `${'cwd'.padEnd(LABEL_WIDTH)}  ${tail(s.cwd ?? '?', VALUE_WIDTH)}`,
    rawRow('proximo', `ccx status ${ref}    (bloqueando: ccx status ${ref} --wait)`),
  ].join('\n');
}

/**
 * Relatorio do doctor.
 *
 * Este e o comando que o usuario roda quando nada funciona, entao cada
 * problema sai com a instrucao EXATA a executar, e nao com um diagnostico
 * que ele precisa traduzir em acao.
 */
export function renderDoctor(report) {
  const r = report ?? {};
  const mark = (ok) => (ok ? 'ok  ' : 'FALHA');
  const out = [];

  out.push(`ccx ${r.version ?? '?'}   node ${r.node ?? '?'}   ${r.platform ?? '?'}`);
  out.push('');

  out.push('claude code');
  if (r.claude?.ok) {
    out.push(`  ${mark(true)} versao ${r.claude.version}`);
    out.push(`       ${r.claude.path}`);
  } else {
    out.push(`  ${mark(false)} nao encontrado: ${shorten(r.claude?.error ?? 'motivo desconhecido', 120)}`);
  }
  if (r.flags) {
    if (r.flags.checked) {
      const missing = r.flags.missing ?? [];
      out.push(
        missing.length === 0
          ? `  ${mark(true)} todas as flags usadas existem nesta versao`
          : `  ${mark(false)} flags ausentes na ajuda local: ${missing.join(', ')}`,
      );
    } else {
      out.push(`  -     conferencia de flags nao feita: ${shorten(r.flags.error ?? 'sem motivo', 100)}`);
    }
  }
  out.push('');

  // O dispatch spawna modulos deste pacote. Se um deles faltar, a sessao
  // morre sem deixar estado, que e o sintoma mais confuso possivel. Melhor
  // ver a ausencia aqui.
  out.push('pacote');
  if (r.pkg?.ok) {
    out.push(`  ${mark(true)} modulos de execucao presentes`);
  } else {
    out.push(`  ${mark(false)} ausentes: ${(r.pkg?.missing ?? []).join(', ')}`);
  }
  out.push(`       raiz  ${r.pkg?.root ?? '?'}`);
  out.push(`       skill ${r.pkg?.skillDir ?? 'ausente (ccx install-skill nao vai funcionar)'}`);
  out.push('');

  out.push('raiz de estado (primeira gravavel vence)');
  for (const c of r.roots?.candidates ?? []) {
    const chosen = r.roots?.chosen && c.path === r.roots.chosen ? '  <== escolhida' : '';
    const why = c.ok ? 'gravavel' : `nao gravavel (${c.code ?? 'erro'})`;
    // A sonda rotula a origem de cada candidato (variavel de ambiente,
    // diretorio de trabalho, temporario, dados de aplicacao). O nome do
    // campo e lido de forma tolerante porque a lista de candidatos cresceu
    // durante a implementacao e pode crescer de novo: o relatorio nao deve
    // quebrar nem emudecer por causa disso.
    const origin = c.origin ?? c.source ?? c.label ?? c.kind ?? c.from ?? null;
    out.push(`  ${mark(c.ok)} ${origin ? `[${origin}] ` : ''}${c.path}`);
    out.push(`       ${why}${chosen}`);
  }
  if ((r.roots?.candidates ?? []).length === 0) {
    out.push(`  ${mark(false)} nenhum candidato avaliado`);
  }
  out.push('');

  out.push('codex cli');
  out.push(
    r.codex?.ok
      ? `  ${mark(true)} ${r.codex.version}`
      : `  -     nao detectado (${shorten(r.codex?.error ?? 'sem motivo', 80)}). o ccx funciona sem ele.`,
  );
  out.push(`        CODEX_HOME        ${r.skills?.codexHome ?? '?'}`);
  out.push(`        skills de usuario ${r.skills?.user ?? '?'}`);
  out.push(`        skills de projeto ${r.skills?.project ?? '?'}`);
  out.push('');

  if ((r.warnings ?? []).length > 0) {
    out.push('avisos    nao impedem despachar');
    for (const w of r.warnings) out.push(`  - ${w}`);
    out.push('');
  }

  if ((r.problems ?? []).length === 0) {
    const tail = (r.warnings ?? []).length > 0 ? ' avisos acima seguem abertos.' : '';
    out.push(`veredito  pronto para despachar: ccx dispatch --task "..." --cwd <dir>.${tail}`);
  } else {
    out.push('veredito  pendencias abaixo, na ordem de resolucao');
    for (const p of r.problems) {
      out.push(`  - ${p.what}`);
      out.push(`    execute: ${p.fix}`);
    }
  }
  return out.join('\n');
}

/** Exportado para teste: o teto de linhas e parte do contrato, nao detalhe. */
export const STATUS_LINE_BUDGET = MAX_STATUS_LINES;
