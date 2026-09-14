// Configuracao automatica depois de `npm install -g https://github.com/PPiai/cc-to-codex/tarball/main`.
//
// REGRA UNICA E INEGOCIAVEL: este arquivo SEMPRE termina com codigo 0.
//
// Um postinstall que falha aborta a instalacao global inteira. O pacote fica
// meio instalado e o usuario recebe um erro de npm sobre um script que ele
// nunca pediu para rodar. Nada que este arquivo faz vale esse preco: tudo
// aqui e conveniencia, e toda conveniencia pode ser refeita depois com
// `ccx setup`, que e o mesmo trabalho com contrato honesto de codigo de
// saida.
//
// Tres consequencias de desenho vem dessa regra:
//
// 1. NENHUM import estatico de `src/`. Import estatico de ESM resolve ANTES
//    de qualquer linha deste arquivo rodar, entao um modulo ausente ou que
//    lanca no topo mataria o processo com codigo != 0 antes do try/catch
//    existir. Todo modulo do pacote entra por `await import()` dentro de
//    `main`. So builtin `node:` entra estatico.
// 2. Ganchos de ultima instancia para excecao nao capturada e promessa
//    rejeitada, porque nem todo caminho assincrono passa pelo try/catch.
// 3. Toda saida vai para stderr, seguindo a convencao do projeto: stdout e
//    reservado para dado consumivel, e durante um `npm install` ninguem esta
//    consumindo nada daqui.
//
// ESCOTILHAS DE SAIDA (qualquer uma pula este script por inteiro):
//   CCX_SKIP_POSTINSTALL=1   pula. depois, rode `ccx setup` quando quiser
//   CI                       definido em qualquer valor, pula
//   instalacao nao-global    so relata e sai

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Desde a primeira linha. Se o processo morrer por um caminho que nao
// prevemos, ele morre com 0.
process.exitCode = 0;
process.on('uncaughtException', (err) => {
  note(`aviso: a configuracao automatica falhou (${err?.message ?? err}). rode: ccx setup`);
  process.exitCode = 0;
});
process.on('unhandledRejection', (err) => {
  note(`aviso: a configuracao automatica falhou (${err?.message ?? err}). rode: ccx setup`);
  process.exitCode = 0;
});

function note(text) {
  try {
    process.stderr.write(`${text}\n`);
  } catch {
    // stderr fechado durante instalacao nao e motivo para derrubar nada.
  }
}

/**
 * `npm_config_global` chega como a STRING "true" ou "false", nunca como
 * booleano. Um `if (env.npm_config_global)` entraria no ramo global durante
 * uma instalacao local, porque "false" e uma string nao vazia e portanto
 * verdadeira. Este e o defeito classico deste arquivo em outros projetos.
 */
function ehVerdadeiro(valor) {
  if (typeof valor !== 'string') return valor === true;
  return ['true', '1', 'yes', 'on'].includes(valor.trim().toLowerCase());
}

/** Comando de remocao apropriado para a plataforma, para o "como desfazer". */
function comandoDeRemocao(alvo) {
  return process.platform === 'win32'
    ? `Remove-Item -Recurse -Force "${alvo}"`
    : `rm -rf "${alvo}"`;
}

async function main() {
  const env = process.env;

  if (env.CCX_SKIP_POSTINSTALL !== undefined && env.CCX_SKIP_POSTINSTALL !== '') {
    note('ccx: CCX_SKIP_POSTINSTALL definido, configuracao automatica pulada. rode `ccx setup` quando quiser.');
    return;
  }
  if (env.CI !== undefined && env.CI !== '') {
    note('ccx: CI detectado, configuracao automatica pulada.');
    return;
  }
  if (!ehVerdadeiro(env.npm_config_global)) {
    // Instalacao local nao e a instalacao do usuario final: e clone de
    // desenvolvimento ou dependencia de outro pacote. Escrever skill no home
    // de alguem a partir dai seria efeito colateral nao pedido.
    // Nunca sugerir `npx ccx`: o nome `ccx` no registro do npm pertence a
    // outro pacote, e o npx baixaria e executaria esse pacote se nao achasse
    // o binario local.
    note('ccx: instalacao local, nada configurado. para configurar: npm install -g https://github.com/PPiai/cc-to-codex/tarball/main');
    return;
  }

  note('ccx: conferindo pre-requisitos (pode levar alguns segundos)...');

  // Tetos curtos de proposito: os padroes do doctor somam ate ~28s, e meio
  // minuto de silencio no meio de um `npm install -g` parece travamento.
  // Uma sondagem que estoura vira "nao conferido", nunca erro.
  let report = null;
  try {
    const { buildDoctorReport } = await import('../src/doctor.mjs');
    report = buildDoctorReport({
      cwd: PKG_ROOT,
      env,
      pkgRoot: PKG_ROOT,
      timeouts: { claudeHelpMs: 8000, codexVersionMs: 5000 },
    });
  } catch (err) {
    note(`ccx: nao consegui rodar o diagnostico agora (${err?.message ?? err}). rode: ccx doctor`);
  }

  if (report) {
    if (report.claude?.ok) {
      note(`ccx: Claude Code ${report.claude.version} encontrado.`);
    } else {
      // Ausencia do Claude Code AQUI e normal e esperada: muita gente
      // instala a ponte antes da ferramenta que ela conduz. Tratar isso
      // como erro treinaria o usuario a ignorar a saida do instalador.
      note('ccx: Claude Code ainda nao esta instalado nesta maquina. isso e normal agora;');
      note('     instale o Claude Code e rode `ccx doctor` para conferir.');
    }
    if (report.codex?.ok) note(`ccx: Codex CLI ${report.codex.version} encontrado.`);
    else note('ccx: Codex CLI nao detectado no PATH. o ccx funciona sem ele.');

    const outros = (report.problems ?? []).filter(
      (p) => !String(p.what).startsWith('binario do Claude Code'),
    );
    for (const p of outros) note(`ccx: pendencia - ${p.what}`);
  }

  // Instalacao da skill no escopo de USUARIO: `npm install -g` e um gesto de
  // maquina, nao de repositorio, entao escrever em `.agents/skills` do
  // diretorio onde o npm por acaso rodou seria escrever no lugar errado.
  try {
    const { planInstall, applyInstall, verifyHint } = await import('../src/install-skill.mjs');
    const plan = planInstall({ cwd: PKG_ROOT, scope: 'user', env, root: PKG_ROOT });
    const applied = applyInstall(plan);

    // O que foi escrito FORA do pacote, dito por extenso. Um instalador que
    // toca o home do usuario e nao diz onde e um instalador que pede
    // confianca sem prestar contas.
    note('');
    note(`ccx: skill "${plan.name}" instalada no escopo de usuario.`);
    note(`     ${applied.written} arquivo(s), ${applied.bytes}B escritos em:`);
    note(`       ${plan.destDir}`);
    for (const file of plan.files) note(`         ${file.to}`);
    note(`     para desfazer:  ${comandoDeRemocao(plan.destDir)}`);
    note('');
    note(verifyHint(plan));
  } catch (err) {
    note(`ccx: nao consegui instalar a skill agora (${err?.message ?? err}).`);
    note('     rode `ccx setup` para tentar de novo e ver o motivo completo.');
  }

  note('');
  note('ccx: pronto. `ccx setup` refaz isto a qualquer momento; `ccx doctor` so diagnostica.');
}

try {
  await main();
} catch (err) {
  note(`aviso: a configuracao automatica falhou (${err?.message ?? err}). rode: ccx setup`);
}

// A ultima palavra sobre o codigo de saida e desta linha.
process.exitCode = 0;
