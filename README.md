# cc-to-codex

**`ccx`** deixa o **Codex CLI da OpenAI** despachar e acompanhar sessões do
**Claude Code** como subagentes.

Node puro, ESM, zero dependência externa.

---

## Por que existe

O Codex já consegue rodar um comando de shell, então tecnicamente já pode chamar
`claude -p "faça X"`. O problema é que isso entrega um único disparo cego, com
três defeitos que inviabilizam orquestração de verdade.

**Bloqueia.** `claude -p` só retorna quando a tarefa acaba. Uma tarefa de vinte
minutos prende o turno do Codex por vinte minutos, sem visibilidade nenhuma.

**Devolve tudo de uma vez.** A saída inteira cai no contexto do Codex. Numa
tarefa longa, isso é dezenas de milhares de tokens de log de ferramenta que o
orquestrador não precisa ver. O Codex passa a gastar o próprio contexto lendo o
trabalho alheio.

**É mudo nas duas direções.** Não há como mandar uma correção de rumo depois do
disparo, nem como responder uma dúvida que o Claude levante no meio do caminho.
Se o Claude precisa de uma decisão, ele adivinha ou para.

O `ccx` fecha as três lacunas. O despacho retorna na hora, o acompanhamento cabe
em cerca de quinze linhas para qualquer tarefa, e o canal de mensagens funciona
nas duas direções enquanto a sessão está viva.

Como funciona: um supervisor por sessão segura o `claude` vivo com entrada e
saída em fluxo JSON, digere os eventos em estado compacto de tamanho constante, e
entrega no stdin do Claude as mensagens que chegam por um canal de comandos em
arquivo. A CLI é um processo efêmero que lê arquivos e sai, então cada chamada do
Codex custa milissegundos e não existe daemon global.

---

## Instalação

Pré-requisitos: Node 18.18 ou mais novo, e o Claude Code instalado e autenticado
na máquina.

```bash
git clone <repo> cc-to-codex
cd cc-to-codex
node bin/ccx.mjs doctor
```

Para ter `ccx` no PATH:

```bash
npm link          # ou: npm install -g .
ccx doctor
```

Não há dependências para instalar. `npm install` não baixa nada.

**Rode `ccx doctor` antes do primeiro despacho.** Ele resolve o caminho absoluto
do binário do Claude, confirma que executa, testa gravação de verdade em cada
candidato de raiz de estado, e diz qual foi escolhido.

---

## Comandos

### Despachar

```bash
ccx dispatch --task "Leia src/auth/session.ts, extraia a rotação de token para
src/auth/rotate.ts e faça os dois chamadores usarem o módulo novo.
Não toque em src/api/ nem nas migrações.
Ao terminar, relate os arquivos alterados e o resultado de npm test -- auth." \
  --label auth-refactor --cwd .
```

Retorna na hora com um identificador curto. Não espera o primeiro turno.

Opções: `--task <texto>` ou `--task-file <caminho>` (obrigatório um dos dois),
`--cwd <dir>`, `--label <nome>`, `--tools <lista>`, `--model <modelo>`,
`--permission-mode <modo>`, `--fence` / `--no-fence`, `--raw`, `--json`.

### Acompanhar

```bash
ccx status auth-refactor
```

```
sessao    a3f1   rotulo: auth-refactor
estado    aguardando_resposta
fase      turno 4, ativa ha 2m18s
cwd       C:\Users\dev\Desktop\projetos\api-gateway
claude    sessao 0744770c, processo 18422
turnos    4 concluidos, 1 ambiguo
tools     Read x12, Grep x5, Edit x3, Bash x7
arquivos  src/auth/session.ts, src/auth/token.ts
negacoes  nenhuma
custo     0.42 USD acumulado
ultima    "Terminei de mapear os tres pontos de entrada"
pergunta  "Devo manter compatibilidade com o token v1?"
cursor    312
```

Sem referência, lista todas as sessões. Com `--wait --timeout-ms <n>`, bloqueia
até o turno fechar e sai com código 6 se o tempo esgotar.

### Conversar

```bash
ccx say auth-refactor "prioridade mudou, foque só no caminho de login"
ccx answer auth-refactor "mantenha a compatibilidade com o token v1"
```

`answer` recusa com código 3 quando não há pergunta pendente. A recusa é
deliberada: sem ela, `answer` viraria um `say` disfarçado e o orquestrador
perderia o sinal de que estava respondendo a coisa nenhuma.

### Colher

```bash
ccx result auth-refactor              # texto final completo do último turno
ccx log auth-refactor --since 312     # só o que é novo, com o cursor novo
```

`result` é o único comando que gasta contexto de propósito.

### Administrar

```bash
ccx ls --all
ccx stop auth-refactor      # idempotente, preserva os arquivos
ccx rm auth-refactor        # recusa se a sessão estiver viva; --force insiste
ccx doctor
```

Todo comando aceita `--json` para saída de máquina em uma linha. Progresso e
diagnóstico vão para o fluxo de erro, nunca para a saída padrão, de modo que a
saída padrão possa ser consumida sem filtragem.

### Códigos de saída

| Código | Significado |
|---|---|
| 0 | Sucesso |
| 1 | Erro de uso, argumento inválido ou faltando |
| 2 | Sessão não encontrada |
| 3 | Estado incompatível com a operação pedida |
| 4 | Nenhuma raiz de estado gravável |
| 5 | Pré-requisito ausente, como binário do Claude não encontrado |
| 6 | Tempo esgotado em espera explícita |

---

## O contrato de sentinela

O despacho anexa ao prompt de sistema um contrato que obriga o subagente a fechar
todo turno com um de três marcadores:

| Marcador | Significado | Estado resultante |
|---|---|---|
| `@@DONE: <resumo>` | Trabalho concluído | `done` |
| `@@ASK: <pergunta>` | Precisa de uma decisão do orquestrador | `asking` |
| `@@BLOCKED: <motivo>` | Impossível prosseguir | `blocked` |
| nenhum | Turno fechou sem marcador | **`ambiguous`** |

**Por que marcador e não heurística de texto.** Em modo headless não existe
ferramenta de pergunta ao usuário. Foi medido nesta máquina: instruído a usar
essa ferramenta, o Claude a procurou, não encontrou, e formulou a pergunta em
prosa dentro do resultado final, com motivo de parada normal de fim de turno. Do
ponto de vista do fluxo de eventos, **um turno que faz uma pergunta é
indistinguível de um turno que concluiu a tarefa**. Detectar a diferença por
heurística erraria nos dois sentidos: um resumo que menciona uma dúvida seria
lido como pergunta, e uma pergunta sem interrogação passaria batida.

**Turno sem marcador nunca é conclusão.** Vira `ambiguous`, que é um estado
visível e acionável. Tratar ausência de marcador como conclusão transformaria
silenciosamente uma pergunta real em tarefa entregue, que é o pior modo de falha
possível deste sistema: o orquestrador segue adiante acreditando que o trabalho
acabou, quando o subagente na verdade parou esperando resposta.

---

## Instalar a skill no Codex

A skill é o que ensina o Codex a usar a ferramenta sozinho.

```bash
ccx install-skill                      # escopo de projeto: .agents/skills/claude-dispatch/
ccx install-skill --scope user         # escopo de usuário: $CODEX_HOME/skills/claude-dispatch/
ccx install-skill --dry-run            # mostra o que faria
```

**Confira depois de instalar**, com o comando de listagem de skills do Codex. A
conferência não é zelo excessivo: as fontes do Codex divergem sobre onde uma
skill de usuário deve ficar. A documentação aponta um caminho sob o diretório do
usuário, enquanto a skill embutida de instalação do próprio Codex declara
`$CODEX_HOME/skills/<nome>`, com padrão em `~/.codex/skills`. A divergência foi
resolvida em favor do diretório de configuração, porque é a ferramenta oficial
que executa a instalação e portanto descreve o comportamento real. Nenhuma skill
de usuário existia nesta máquina no momento do levantamento, então o carregamento
a partir desse caminho não chegou a ser observado em execução.

**O escopo de projeto é o caminho firme**, confirmado em execução, e é o padrão.

---

## Fatos verificados sobre o ambiente

Tudo abaixo foi verificado por execução direta nesta máquina em 2026-09-11, não
lido em documentação.

| Fato | Como foi verificado |
|---|---|
| Claude Code 2.1.268 | `claude --version` |
| Codex CLI 0.154.0, autenticação ChatGPT, sem chave de API | `codex --version`, `codex doctor` |
| `-p` com entrada e saída em fluxo JSON mantém o processo vivo por vários turnos | Duas mensagens pelo stdin, dois resultados no mesmo processo |
| O identificador de sessão permanece estável entre turnos | Os dois eventos de inicialização trouxeram o mesmo identificador |
| Um novo evento de inicialização chega a cada turno | Observado no segundo turno, com o mesmo identificador |
| `-p` e `--bg` são mutuamente exclusivos | Execução conjunta recusada |
| Sessões em modo de impressão não aparecem em `claude agents --json` | Listagem só trouxe sessões interativas |
| `--settings` aceita caminho de arquivo ou JSON embutido | Ajuda local do binário |
| Sem quem responda permissão, a chamada de ferramenta é negada e registrada | Resultado de ferramenta com erro e lista de negações preenchida |
| A ferramenta de pergunta ao usuário não existe em modo headless | O Claude a procurou, não encontrou, e perguntou em prosa |
| O binário resolvido nesta máquina | `C:\Users\dev\.local\bin\claude.exe` |
| O sandbox do Codex não herda o PATH do usuário | Chamada por nome falhou com erro 2 do Windows. Por caminho absoluto, funcionou |
| Uma sessão headless completa roda dentro do sandbox do Codex, autenticada por OAuth | Execução sob `codex sandbox` retornou o texto pedido |
| No Windows, `spawn` de um `.cmd` exige `shell`, e de um `.mjs` não funciona | `EINVAL` e `EFTYPE` respectivamente, com Node 24.19.0 |

**Flags que não existem nesta versão** e que relatórios de pesquisa citaram por
engano: `--allow-tools` (o nome correto é `--tools`), `--max-turns` e
`--max-cost-usd`. A fonte de verdade é a ajuda local do binário instalado, não a
documentação publicada. O `doctor` confere as flags usadas contra a ajuda local
para detectar mudança de versão cedo.

---

## Limites de segurança

**A cerca de diretório é defesa em profundidade, não fronteira.** O despacho
registra um hook de pré-uso de ferramenta que nega gravação quando o caminho
resolvido cai fora do `--cwd` declarado. A negação aparece na lista de negações
do resultado e portanto no estado compacto, de modo que o orquestrador vê que
houve tentativa de sair do escopo.

**A cerca não impede a ferramenta de shell de sair do diretório.** Um comando
pode mudar de diretório, usar caminho absoluto, ou invocar outro programa que
escreva onde quiser. Analisar linha de comando de shell para decidir isso é um
problema de segurança mal posto, e tentar resolver por lista de padrões daria
falsa confiança. Quem quiser fronteira real deve isolar por cópia de trabalho
separada.

**O subagente roda em modo autônomo.** Ele escreve no disco sem pedir permissão,
e o Codex responde as dúvidas de escopo sozinho. São dois agentes com poder de
escrita e nenhum humano no circuito de decisão. Isso foi uma escolha consciente
de projeto. Despache sobre trabalho versionado, para que o diff seja revisável.

---

## Solução de problemas

### Comece sempre pelo diagnóstico

```bash
ccx doctor
```

Ele responde, em um comando, as quatro perguntas que cobrem quase toda falha:
onde está o Claude e se ele executa, quais flags a ajuda local ainda reconhece,
qual raiz de estado é gravável, e se há algo faltando no pacote.

### Nenhuma raiz de estado gravável (código 4)

É o primeiro problema que vai morder alguém, e vem do sandbox do Codex. Numa
sondagem sob token restrito, **nenhum** diretório aceitou escrita: nem o de
trabalho, nem o temporário, nem o de aplicação local, nem o do usuário.

O `dispatch` testa gravação de verdade em cada candidato, nesta ordem:

1. `CCX_STATE_DIR`, se definida.
2. Uma pasta reservada dentro do diretório de trabalho declarado.
3. O diretório temporário do sistema.
4. O diretório de estado de aplicação do usuário.

Se nenhum servir, ele recusa com código 4 e lista o erro de cada candidato, em
vez de criar uma sessão que perde o próprio estado. As três saídas:

```bash
# 1. apontar para um caminho que você sabe que é gravável
export CCX_STATE_DIR=/caminho/gravavel/ccx      # Windows: set CCX_STATE_DIR=...

# 2. ampliar as raízes graváveis na configuração do Codex

# 3. rodar o Codex em modo de acesso mais amplo
```

### "Aponte CCX_CLAUDE_BIN para o claude.exe" (Windows)

O `ccx` recusa um binário terminado em `.cmd` ou `.bat`, que é como o npm
instala no Windows. A recusa é deliberada e a razão é medida: **um argumento com
quebra de linha não sobrevive ao interpretador de comandos**. Nesta máquina, um
`--append-system-prompt` de três linhas chegou do outro lado com uma linha só.
Como o contrato de sentinela tem várias linhas, passar por um envelope de lote
faria todo turno voltar sem marcador, ou seja `ambiguous`, sem causa visível em
lugar nenhum. Falhar alto custa uma mensagem de erro; deixar passar custaria a
confiança no sistema inteiro.

Saídas, na ordem de preferência:

```bash
# 1. apontar para o binário de verdade, se a instalação tiver um
set CCX_CLAUDE_BIN=C:\Users\<voce>\.local\bin\claude.exe

# 2. instalar o Claude Code pelo instalador nativo, que entrega um .exe
```

Se houver um `claude.exe` ao lado do `claude.cmd`, o `ccx` troca sozinho e segue
sem incomodar.

### Binário do Claude não encontrado (código 5)

O sandbox do Codex não herda o PATH do usuário, então chamar `claude` pelo nome
falha. O `ccx` resolve o caminho absoluto sozinho, mas se a instalação estiver
fora dos lugares conhecidos, aponte explicitamente:

```bash
export CCX_CLAUDE_BIN=/caminho/para/claude      # Windows: C:\Users\<voce>\.local\bin\claude.exe
```

### A sessão foi para `failed` logo depois do despacho

O supervisor grava o stderr do Claude no log da própria sessão:

```bash
cat "$(ccx status <ref> --json | node -e "...")"/supervisor.log
# ou, direto: <raiz>/sessions/<id>/supervisor.log
```

`ccx doctor` mostra a raiz escolhida. As causas comuns são binário que não
executa, flag que sumiu na versão nova, e diretório de trabalho inexistente.

### A sessão ficou `ambiguous`

Não é erro: o turno fechou sem marcador. Leia o texto final no `status` e peça o
marcador correto com `ccx say`. Nunca presuma conclusão.

### `answer` recusado com código 3

Não existe pergunta pendente. Confira com `ccx status <ref>`. Para falar com a
sessão fora de uma pergunta, use `ccx say`.

### Referência de sessão ambígua (código 1)

O prefixo que você digitou casa com mais de uma sessão, ou o rótulo está
duplicado. `ccx ls` mostra os identificadores completos.

---

## Desenvolvimento

```bash
npm test              # node --test "tests/*.test.mjs"
```

Nenhum teste consome cota paga. A peça central é `tests/fake-claude.mjs`, um
executável que fala o mesmo fluxo de eventos do Claude Code, com comportamentos
selecionáveis por `CCX_FAKE_BEHAVIOR` ou por `--fake-behavior=<nome>`:
`done`, `ask-then-done`, `blocked`, `no-marker`, `denials`, `crash`, `slow`,
`multi-turn`, `bad-json`, `unknown-event`, `many-files` e `error-result`.

Ele também serve como biblioteca pura: `sessionScript({ behavior, prompts })`
devolve os eventos como objetos, sem tocar em disco, para alimentar o digest
evento por evento.

O cabeçalho de `tests/fake-claude.mjs` fixa a forma exata de cada evento medida
na versão 2.1.268. Quem consome o fluxo programa contra ela; se a forma mudar,
muda ali primeiro.

Alvo de plataforma: **Windows validado primeiro**, com caminhos abstraídos desde
o início. Linux e macOS entram como fase seguinte, não como promessa não testada.

## Licença

MIT
