// Invocador da suite, portavel entre as versoes de Node que o pacote declara
// suportar (engines: >=18.18).
//
// POR QUE ISTO EXISTE, medido em 2026-09-14 rodando as quatro versoes:
//
//   forma passada a `node --test`   node 18   node 20   node 22   node 24
//   "tests/"                        194 ok    194 ok    ERRO      ERRO
//   "tests/*.test.mjs"              ERRO      ERRO      194 ok    194 ok
//
// Node 18 e 20 varrem um DIRETORIO e nao expandem glob; 22 e 24 expandem
// glob e tratam o diretorio como um arquivo de teste, falhando com
// MODULE_NOT_FOUND. Nenhuma string literal serve as quatro, e o shell nao
// salva: no Windows o npm roda script por cmd.exe, que nao expande glob.
//
// Entao a lista de arquivos e montada aqui e passada explicitamente, que e a
// unica forma aceita por todas as versoes. Zero dependencia, como o resto do
// projeto: `fs.readdirSync` e um filtro.
//
// Argumentos extras passam adiante, entao `npm test -- --test-name-pattern=x`
// continua funcionando.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR_TESTES = path.join(RAIZ, 'tests');

const arquivos = fs
  .readdirSync(DIR_TESTES, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
  .map((e) => path.join(DIR_TESTES, e.name))
  .sort();

// Suite vazia sai com erro em vez de com 0: "nenhum teste" e indistinguivel
// de "tudo passou" para quem le so o codigo de saida, e essa confusao e
// exatamente o que derruba um CI sem ninguem perceber.
if (arquivos.length === 0) {
  process.stderr.write(`nenhum arquivo *.test.mjs em ${DIR_TESTES}\n`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...arquivos, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: RAIZ,
});

process.exit(res.status === null ? 1 : res.status);
