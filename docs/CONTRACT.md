# Contrato interno dos modulos

Documento de integracao. Define as assinaturas que cada modulo exporta, para
que partes escritas em paralelo encaixem. `src/protocol.mjs` ja existe e e a
fonte de verdade das constantes. Nenhum modulo redefine constante que ja
esteja lah.

Regras gerais, validas para todos os modulos:

- Node puro, ESM, extensao `.mjs`, zero dependencia externa.
- Nada de `process.exit` dentro de `src/`. Modulos lancam erro, e so
  `bin/ccx.mjs` traduz erro em codigo de saida.
- Erros carregam a propriedade `code` com um valor de `EXIT`, para que a CLI
  traduza sem adivinhar. Use o helper `fail(code, message)` de `src/errors.mjs`.
- Toda escrita de arquivo que possa ser lida concorrentemente usa gravacao
  atomica: escreve em `<arquivo>.tmp` e renomeia.
- Caminhos sempre absolutos internamente. Nunca depender do diretorio atual
  do processo.
- Windows e o alvo validado primeiro, mas nenhum caminho fica cravado. Nada
  de barra invertida literal em codigo: use `path.join`.

---

## src/errors.mjs

```js
/** Cria um erro com codigo de saida anexado. */
export function fail(code, message, extra = {}): Error   // erro.code = code
/** True se o erro tem codigo conhecido de EXIT. */
export function isTagged(err): boolean
```

---

## src/paths.mjs

Responsavel por descobrir onde gravar e onde esta o Claude.

```js
/**
 * Resolve a raiz de estado, testando gravabilidade de verdade.
 * Ordem: env CCX_STATE_DIR, depois <cwd>/.ccx, depois tmpdir/cc-to-codex,
 * depois o diretorio de estado de aplicacao do usuario.
 * Testa escrevendo e removendo um arquivo em cada candidato.
 * Cria a raiz escolhida.
 * Lanca fail(EXIT.NO_WRITABLE_ROOT) com a lista de tentativas na mensagem
 * quando nenhum candidato aceita escrita.
 */
export function resolveStateRoot({ cwd, env = process.env }):
  { root: string, candidates: Array<{ path: string, ok: boolean, code: string|null }> }

/** Igual ao acima, mas nao cria nada e nao lanca. Para o doctor. */
export function probeStateRoots({ cwd, env = process.env }):
  Array<{ path: string, ok: boolean, code: string|null }>

export function sessionsDir(root): string           // <root>/sessions
export function sessionDir(root, id): string        // <root>/sessions/<id>
export function filePath(root, id, key): string     // key vem de FILES

/**
 * Encontra o executavel do Claude Code.
 * Ordem: env CCX_CLAUDE_BIN, depois procura no PATH com resolucao manual
 * (which/where nao sao confiaveis sob sandbox), depois candidatos conhecidos
 * como <home>/.local/bin/claude(.exe).
 * IMPORTANTE: devolve caminho ABSOLUTO. Medido em 2026-09-11 que o sandbox
 * do Codex nao herda PATH, e chamar por nome falha com erro 2 do Windows.
 * Valida rodando --version e capturando a versao.
 * Lanca fail(EXIT.MISSING_PREREQ) se nao achar ou se --version falhar.
 */
export function resolveClaudeBinary({ env = process.env }):
  { path: string, version: string }
```

---

## src/state.mjs

Toda a I/O de estado. Nenhum outro modulo abre esses arquivos na mao.

```js
export function initSession(root, id, meta): void      // cria dir e grava meta
export function readMeta(root, id): object             // fail(EXIT.NO_SESSION) se ausente
export function writeState(root, id, state): void      // atomico
export function readState(root, id): object            // fail(EXIT.NO_SESSION) se ausente
export function patchState(root, id, partial): object  // le, mescla, grava, devolve

export function appendEvent(root, id, entry): number   // devolve n (1-based)
export function appendRaw(root, id, ev): void          // no-op se raw desligado
/**
 * Le entradas digeridas a partir de um cursor.
 * since e o n da ultima entrada ja vista. Zero ou ausente significa do inicio.
 */
export function readEvents(root, id, { since = 0, limit }):
  { entries: object[], cursor: number, remaining: number }

export function appendCommand(root, id, cmd): number   // devolve seq
export function readCommands(root, id, { sinceSeq = 0 }): object[]

export function listSessionIds(root): string[]
export function listStates(root): object[]             // ignora sessao corrompida
/**
 * Resolve id parcial. Aceita prefixo unico, como o git faz com hash.
 * Aceita tambem o label exato.
 * fail(EXIT.NO_SESSION) se nada casar, fail(EXIT.USAGE) se ambiguo.
 */
export function resolveId(root, reference): string

export function isAlive(pid): boolean                  // checagem por sinal 0
export function removeSession(root, id): void

/** Grava o settings.json da sessao e devolve o caminho absoluto. */
export function writeSettings(root, id, settings): string
```

Formato de `state.json`, campos obrigatorios:

```json
{
  "schema": 1,
  "id": "a1b2c3d4",
  "label": "refactor-auth",
  "status": "working",
  "phase": "editing",
  "pid": 12345,
  "alive": true,
  "turn": 3,
  "startedAt": "2026-09-11T12:00:00.000Z",
  "updatedAt": "2026-09-11T12:04:31.000Z",
  "claudeSessionId": "uuid ou null",
  "pendingQuestion": "texto ou null",
  "lastMessage": "texto truncado",
  "toolCounts": { "Read": 12, "Edit": 3 },
  "filesTouched": ["src/a.ts"],
  "filesTouchedExtra": 0,
  "permissionDenials": 0,
  "denialSamples": ["Write src/x.ts"],
  "turnLog": [{ "n": 1, "outcome": "done", "ms": 8400, "costUsd": 0.14 }],
  "totalCostUsd": 0.29,
  "eventCount": 142,
  "cursor": 142,
  "queuedCommands": 0,
  "error": null,
  "exitCode": null
}
```

Entrada de `events.jsonl`, digerida e compacta:

```json
{ "n": 12, "ts": "ISO", "kind": "tool", "name": "Edit", "detail": "src/a.ts" }
```

`kind` aceita: `turn-start`, `text`, `tool`, `tool-result`, `denial`,
`turn-end`, `command`, `error`, `system`.

---

## src/digest.mjs

Traduz o fluxo de eventos em estado compacto. Funcao pura de maquina de
estados, sem I/O, para ser testavel evento por evento.

```js
/**
 * @param {object} seed Estado inicial, ja com id, label, pid, startedAt.
 * @returns {{
 *   state: object,
 *   apply: (ev: object) => { changed: boolean, entries: object[] },
 *   snapshot: () => object
 * }}
 */
export function createDigest(seed)
```

Comportamento exigido:

- Ignora eventos de ruido: `rate_limit_event`, `system/thinking_tokens`,
  `system/hook_started`, `system/hook_response`, e qualquer `stream_event`.
  Eles nao geram entrada de log nem mudam estado.
- `system/init` preenche `claudeSessionId` e mantem o valor do primeiro init.
  Um segundo init no mesmo processo e normal entre turnos, medido em
  2026-09-11, e nao deve trocar o id nem reiniciar contadores.
- `assistant` com bloco `tool_use` incrementa `toolCounts[name]`, gera entrada
  `tool`, e em `Write`, `Edit`, `NotebookEdit` registra o caminho em
  `filesTouched`, respeitando `LIMITS.filesTouched` com excedente em
  `filesTouchedExtra`. Em `Bash` usa `inferPhaseFromCommand` para ajustar
  `phase`.
- `assistant` com bloco `text` atualiza `lastMessage` truncado.
- `user` com `tool_result` marcado como erro gera entrada `tool-result`.
- `result` fecha o turno: usa `classifyTurn` no campo `result`, define
  `status`, `pendingQuestion`, soma `totalCostUsd`, empilha em `turnLog`
  respeitando o limite, e acumula `permissionDenials` do campo
  `permission_denials` com amostras.
- Nunca deixa `status` virar `done` sem sentinela. Sem sentinela e `ambiguous`.

---

## src/supervisor.mjs

Executavel. Um processo por sessao, criado destacado pelo dispatch.

```
node src/supervisor.mjs --root <abs> --id <id>
```

Sequencia:

1. Le `meta.json`. Se ausente, grava no `supervisor.log` e sai com 1.
2. Monta argv do Claude e o spawna com `stdio: ['pipe','pipe','pipe']`.
   Flags obrigatorias: `-p`, `--input-format stream-json`,
   `--output-format stream-json`, `--verbose`,
   `--permission-mode` conforme meta, `--settings <caminho do settings.json>`,
   `--strict-mcp-config`, e `--tools` quando meta pedir.
   Nao usar `--include-partial-messages`: deltas sao ruido puro aqui.
   Usa o caminho absoluto do binario que veio no meta.
3. Envia o primeiro turno com a tarefa, no formato
   `{"type":"user","message":{"role":"user","content":"<texto>"}}` e uma
   quebra de linha. Medido funcionando em 2026-09-11.
4. Le stdout por linha, alimenta o digest, grava evento e estado.
5. Observa `commands.jsonl` com `fs.watch` e, como rede de seguranca contra
   perda de evento de watch em Windows, tambem relê ao fim de cada turno.
   Entrega `say` e `answer` como novo turno pelo stdin. Nunca entrega no meio
   de um turno: enfileira e entrega quando o `result` chegar.
   `stop` encerra o stdin e termina o processo.
6. `answer` so e valido quando o status e `asking`. Se chegar fora disso, o
   supervisor registra entrada de log e trata como `say`, para nao perder a
   mensagem do orquestrador. A recusa por estado acontece na CLI, que e onde
   o orquestrador ve o codigo de saida.
7. Se o processo morre sem `result`, marca `failed`, registra `exitCode` e o
   stderr capturado no `supervisor.log`.
8. Ao sair, sempre grava estado final com `alive: false`.

Escreve stderr do Claude no `supervisor.log`, nunca em stdout.

---

## src/fence.mjs

Executavel. Hook de pre-uso de ferramenta, registrado pelo `settings.json`.

```
node src/fence.mjs --cwd <abs>
```

Le JSON do stdin com `tool_name` e `tool_input`. Nega quando a ferramenta e de
escrita e o caminho resolvido cai fora do diretorio declarado. Ferramentas
consideradas: `Write`, `Edit`, `NotebookEdit`. Resolve o caminho com
`path.resolve` e compara com o prefixo do diretorio, usando comparacao sem
distincao de caixa no Windows, e exige separador na fronteira para nao deixar
`C:\proj-outro` passar por prefixo de `C:\proj`.

Imprime decisao no formato de hook do Claude Code e sai com 0. Em duvida,
permite, e registra. A cerca e defesa em profundidade, nao garantia: a
ferramenta de shell pode contornar, e isso esta declarado na skill e no README.

---

## src/args.mjs

```js
/**
 * Parser estrito. Diferente do plugin oficial do Codex, token com dois
 * tracos desconhecido e ERRO, nunca vira positional. No plugin deles um
 * --wait esquecido vaza para dentro do prompt, e nos nao repetimos isso.
 */
export function parse(argv, spec):
  { options: object, positionals: string[] }
```

`spec` traz `booleans`, `strings`, `numbers`, `aliases` e `repeatable`.
Valor ausente para opcao que exige valor lanca `fail(EXIT.USAGE)`.

---

## src/render.mjs

Saida para humano. A saida de maquina e JSON e nao passa por aqui.

```js
export function renderStatus(state): string      // alvo: ~15 linhas
export function renderList(states): string       // uma linha por sessao
export function renderLog(entries, meta): string
export function renderDispatch(state): string
export function renderDoctor(report): string
```

---

## bin/ccx.mjs

Entrada unica. Faz o despacho de subcomando, traduz erro em codigo de saida,
e garante que JSON de maquina saia em uma linha no stdout.

Subcomandos e contratos, conforme a secao 5 da spec:

| Comando | Notas |
|---|---|
| `dispatch` | `--task` ou `--task-file`, `--cwd`, `--label`, `--tools`, `--model`, `--permission-mode`, `--fence`/`--no-fence`, `--raw`, `--json`. Testa raiz gravavel, resolve binario, grava meta e settings, spawna supervisor destacado, espera o primeiro estado aparecer com prazo curto, e retorna. |
| `status` | Sem referencia lista tudo. Com referencia detalha. `--wait` espera sair de `BUSY_STATUSES`, com `--timeout-ms`, saindo com `EXIT.TIMEOUT` no estouro. |
| `say` | Exige sessao viva. |
| `answer` | Exige `status === asking`, senao `fail(EXIT.BAD_STATE)` com mensagem dizendo qual e o estado atual. |
| `result` | Ultimo desfecho completo, sem truncar. Unico comando que gasta contexto de proposito. |
| `log` | `--since`, `--limit`, `--json`. Devolve o cursor novo. |
| `stop` | Idempotente. Sessao ja parada devolve 0. |
| `rm` | Recusa com `EXIT.BAD_STATE` se `alive` e status em `LIVE_STATUSES`. `--force` permite. |
| `ls` | `--json`, `--all`. |
| `doctor` | Nunca lanca por prerequisito ausente: relata tudo e sai com `EXIT.MISSING_PREREQ` se algo essencial falta. |
| `install-skill` | `--scope project\|user`, `--dir`, `--dry-run`. |

O binario declarado no `package.json` e `ccx`.
