<div align="right">

**Português** · [English](README.en.md)

</div>

<div align="center">

# ccx

**Deixa o [Codex CLI](https://github.com/openai/codex) despachar e acompanhar sessões do [Claude Code](https://claude.com/claude-code) como subagentes — sem bloquear, sem inundar o contexto e com canal de mensagens nas duas direções.**

[![CI](https://github.com/PPiai/cc-to-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/PPiai/cc-to-codex/actions/workflows/ci.yml)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)
[![Node >= 18.18](https://img.shields.io/badge/node-%3E%3D%2018.18-5a5a5a.svg)](https://nodejs.org)
[![Zero dependências](https://img.shields.io/badge/depend%C3%AAncias-0-2ea44f.svg)](package.json)

</div>

---

```bash
npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

Um comando. O `postinstall` roda o diagnóstico e instala a skill do Codex sozinho.
Como o `npm` não mostra a saída de scripts de instalação, rode `ccx setup` quando
quiser ver o que ficou pronto — é idempotente.

---

## O ciclo completo

Despachar, acompanhar, responder, colher — quatro comandos, do começo ao fim.

```bash
# 1. despacha e volta na hora, sem esperar o primeiro turno
ccx dispatch --label auth-token --cwd . --task "Extraia a rotação de token de
src/auth/session.ts para src/auth/rotate.ts e faça os dois chamadores usarem o
módulo novo. Não toque em src/api/ nem nas migrações."
```

```
sessao    a3f1c8d2  rotulo auth-token
estado    iniciando
supervisor  18422
cwd       C:\Users\<voce>\projetos\api-gateway
proximo   ccx status auth-token    (bloqueando: ccx status auth-token --wait)
```

```bash
# 2. acompanha. cabe em 15 linhas, para qualquer tarefa, por longa que seja
ccx status auth-token
```

```
sessao    a3f1c8d2  rotulo auth-token
estado    aguardando_resposta
fase      editing, turno 4, ativa ha 2m18s
cwd       C:\Users\<voce>\projetos\api-gateway
claude    sessao 0744770c, processo 18430, vivo
turnos    4 fechados: concluido x3, aguardando_resposta x1
tools     27 chamadas: Read x12, Bash x7, Grep x5, Edit x3
arquivos  3: src/auth/session.ts, src/auth/token.ts, src/auth/rotate.ts
negacoes  nenhuma
custo     0.42 USD acumulado
ultima    "Terminei de mapear os tres pontos de entrada da rotacao de...
pergunta  "Devo manter compatibilidade com o token v1 ou posso remover o
          caminho antigo?"
cursor    312
```

```bash
# 3. responde a pergunta que o subagente levantou, e ele retoma
ccx answer auth-token "mantenha a compatibilidade com o token v1"

# 4. colhe o texto final, só quando o trabalho fecha
ccx result auth-token
```

Aquele bloco de estado é o produto inteiro em miniatura: **tamanho constante**.
Uma tarefa de dois minutos e uma de duas horas ocupam as mesmas quinze linhas,
porque chamadas de ferramenta viram contagem, arquivos tocados viram lista curta
com excedente somado, e a última frase do assistente vem truncada.

<details>
<summary><b>Índice</b></summary>

- [Instalação](#instalação)
- [Primeiro despacho](#primeiro-despacho)
- [Por que existe](#por-que-existe)
- [Como funciona](#como-funciona)
- [Referência de comandos](#referência-de-comandos)
  - [Códigos de saída](#códigos-de-saída)
  - [Variáveis de ambiente](#variáveis-de-ambiente)
- [O contrato de sentinela](#o-contrato-de-sentinela)
- [Limites de segurança](#limites-de-segurança)
- [A skill do Codex](#a-skill-do-codex)
- [Fatos verificados sobre o ambiente](#fatos-verificados-sobre-o-ambiente)
- [Solução de problemas](#solução-de-problemas)
- [Desenvolvimento](#desenvolvimento)
- [Plataformas](#plataformas)
- [Como contribuir](#como-contribuir)
- [Licença](#licença)

</details>

---

## Instalação

```bash
npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

Não há dependências para baixar: o pacote é Node puro, ESM, e a árvore de
`node_modules` fica vazia.

> **Por que a URL do tarball, e não `github:PPiai/cc-to-codex`?** Em instalação
> global de um pacote com script de instalação, o npm 10 e o 11 transformam a
> forma `github:` num link para um clone temporário que eles mesmos apagam no
> fim, e o pacote chega vazio. A URL do tarball instala uma cópia de verdade. Se
> preferir a forma curta, acrescente `--install-links`.

**Pré-requisitos**

| Requisito | Por quê |
|---|---|
| Node 18.18 ou mais novo | Piso declarado em `package.json`; o `doctor` reclama abaixo disso |
| Claude Code instalado e autenticado | É o processo que o `ccx` supervisiona |
| Codex CLI | Opcional. O `ccx` funciona sem ele; sem o Codex, a skill não tem como ser conferida |

### O que o postinstall faz

Na instalação global, o `postinstall` roda sozinho e faz duas coisas:

1. **Diagnóstico.** O mesmo que `ccx doctor`: onde está o binário do Claude e se
   ele executa, quais flags a ajuda local ainda reconhece, qual raiz de estado
   aceita escrita de verdade, e se falta algum módulo no pacote.
2. **Instala a skill do Codex no escopo de usuário**, para que o Codex já saiba
   usar a ferramenta sem configuração manual.

**O postinstall nunca falha a instalação.** Se o Claude não estiver instalado,
se nenhum diretório aceitar escrita, se o Codex não existir na máquina — ele
segue sem abortar. Instalar uma CLI e ver o `npm` abortar por causa de um
pré-requisito de terceiro é o tipo de atrito que faz alguém desistir antes de
chegar ao primeiro despacho; `ccx setup` refaz tudo quando o ambiente estiver
pronto.

**O `npm` esconde a saída do postinstall.** Scripts de instalação rodam em
silêncio por padrão, então a instalação termina sem mostrar o diagnóstico nem o
caminho onde a skill foi gravada. Para ver, rode `ccx setup` em seguida, ou
instale com a saída dos scripts visível:

```bash
npm install -g https://github.com/PPiai/cc-to-codex/tarball/main --foreground-scripts
```

O mesmo `ccx setup` cobre o caso de um `npm` configurado para não rodar scripts
de instalação: sem o postinstall, a skill não é gravada, e o setup grava.

Para pular o passo — em imagem de CI, container de build, ou instalação
automatizada:

```bash
# bash / zsh
CCX_SKIP_POSTINSTALL=1 npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

```powershell
# PowerShell
$env:CCX_SKIP_POSTINSTALL = "1"; npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

### `ccx setup`

Refaz diagnóstico e instalação da skill de forma explícita e **idempotente** —
rodar duas vezes dá o mesmo resultado que rodar uma. É o comando para quando a
instalação foi pulada, quando o ambiente mudou, ou quando você quer simplesmente
conferir que está tudo de pé.

```bash
ccx setup                      # escopo de usuário (padrão)
ccx setup --scope project      # grava a skill dentro do projeto atual
ccx setup --json               # uma linha de JSON, para automação
```

| Flag | Padrão | Efeito |
|---|---|---|
| `--scope user\|project` | `user` | Onde a skill do Codex é gravada |
| `--json` | — | Uma linha de JSON no stdout, e nada mais |

**Uma diferença deliberada em relação ao postinstall:** aqui pré-requisito
ausente sai com **código 5**, nunca 0. Quem digita `ccx setup` está perguntando
"está pronto?", e responder 0 com o Claude Code ausente seria mentir para um
script que encadeia comandos. O postinstall sai 0 sempre porque falhar lá
abortaria a instalação do pacote inteiro.

---

## Primeiro despacho

Depois de instalar, confirme o ambiente e dispare:

```bash
ccx doctor
ccx dispatch --task "Leia src/server.ts e liste os endpoints sem teste." --cwd .
ccx status
```

**Rode `ccx doctor` antes do primeiro despacho.** Ele responde, em um comando, as
quatro perguntas que cobrem quase toda falha: onde está o Claude e se ele
executa, quais flags a ajuda local ainda reconhece, qual raiz de estado é
gravável, e se há algo faltando no pacote.

Escreva a tarefa como você escreveria para um colega que não viu a sua conversa.
O prompt precisa ser autossuficiente: **o que ler primeiro** com caminhos exatos,
**o escopo** dito pelo resultado esperado, **quais arquivos ele possui e quais
não deve tocar**, e **o formato de retorno**. Um prompt vago vira um turno
inteiro gasto pedindo esclarecimento.

Para tarefas longas, `--task-file <caminho>` evita brigar com as aspas do shell.

---

## Por que existe

O Codex já consegue rodar um comando de shell, então tecnicamente já pode chamar
`claude -p "faça X"`. O problema é que isso entrega um único disparo cego, com
três defeitos que inviabilizam orquestração de verdade.

> **Bloqueia.** `claude -p` só retorna quando a tarefa acaba. Uma tarefa de vinte
> minutos prende o turno do Codex por vinte minutos, sem visibilidade nenhuma.

> **Devolve tudo de uma vez.** A saída inteira cai no contexto do Codex. Numa
> tarefa longa, isso é dezenas de milhares de tokens de log de ferramenta que o
> orquestrador não precisa ver. O Codex passa a gastar o próprio contexto lendo o
> trabalho alheio.

> **É mudo nas duas direções.** Não há como mandar uma correção de rumo depois do
> disparo, nem como responder uma dúvida que o Claude levante no meio do caminho.
> Se o Claude precisa de uma decisão, ele adivinha ou para.

O `ccx` fecha as três lacunas. O despacho retorna na hora, o acompanhamento cabe
em cerca de quinze linhas para qualquer tarefa, e o canal de mensagens funciona
nas duas direções enquanto a sessão está viva.

---

## Como funciona

Um **supervisor por sessão** segura o `claude` vivo com entrada e saída em fluxo
JSON, digere os eventos em estado compacto de tamanho constante, e entrega no
stdin do Claude as mensagens que chegam por um canal de comandos em arquivo.

A **CLI é um processo efêmero** que lê arquivos e sai. Cada chamada do Codex
custa milissegundos e **não existe daemon global**.

```
┌─────────┐   dispatch/say/answer    ┌──────────────┐   stdin (stream-json)   ┌────────┐
│  Codex  │ ───────────────────────► │   commands   │ ──────────────────────► │        │
│   CLI   │                          │    .jsonl    │                         │ claude │
│         │                          └──────────────┘                         │  -p    │
│ (ou     │                          ┌──────────────┐   stdout (stream-json)  │        │
│  você)  │ ◄─────────────────────── │  state.json  │ ◄────────────────────── │        │
└─────────┘   status/log/result      │ events.jsonl │        digest           └────────┘
                                     └──────────────┘
                                      supervisor (1 processo por sessão)
```

Cada sessão vive em `<raiz>/sessions/<id>/`, com `meta.json`, `state.json`,
`events.jsonl`, `commands.jsonl`, `settings.json`, `supervisor.log` e — só com
`--raw` — `raw.jsonl`.

As assinaturas internas de cada módulo estão em [`docs/CONTRACT.md`](docs/CONTRACT.md).

---

## Referência de comandos

Referencie a sessão pelo **rótulo**, pelo **id curto**, ou por um **prefixo
único** do id, como o `git` faz com hash.

Todo comando aceita `--json` para saída de máquina em **uma linha**. Progresso e
diagnóstico vão para o fluxo de erro, nunca para a saída padrão, de modo que a
saída padrão possa ser consumida sem filtragem. Em erro, o stdout fica vazio.

### `ccx dispatch`

Cria a sessão e retorna na hora. Não espera o primeiro turno.

```bash
ccx dispatch --task "..." --label auth-token --cwd . --raw
ccx dispatch --task-file ./tarefa.md --cwd ../outro-projeto
```

| Flag | Efeito |
|---|---|
| `--task <texto>` | A tarefa, em uma string. Exclui `--task-file` |
| `--task-file <caminho>` | A tarefa lida de arquivo. Exclui `--task` |
| `--cwd <caminho>` | Diretório de trabalho do subagente (padrão: o atual) |
| `--label <nome>` | Rótulo para referir a sessão por nome próprio |
| `--tools <lista>` | Restringe as ferramentas nativas do Claude. String vazia desliga todas; reduz custo de cache |
| `--model <modelo>` | Modelo desta sessão |
| `--permission-mode <modo>` | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` (padrão: `auto`) |
| `--fence` / `--no-fence` | Cerca de escrita fora do `--cwd` (padrão: ligada). Também aceita `--fence=off` |
| `--raw` | Guarda também o fluxo cru em `raw.jsonl`. Custa disco e é o que permite `ccx result` trazer o texto final sem truncar |
| `--json` | Uma linha de JSON no stdout |

`dispatch` **não aceita argumento posicional**. A recusa é deliberada: sem ela,
um `--fence off` escrito com espaço viraria um positional descartado e a cerca
ficaria ligada contra o pedido explícito de desligar, em silêncio.

### `ccx status`

Sem referência, lista todas as sessões conhecidas. Com referência, imprime o
estado compacto.

```bash
ccx status                                        # uma linha por sessão
ccx status auth-token                             # o bloco de 15 linhas
ccx status auth-token --wait --timeout-ms 60000   # bloqueia
```

| Flag | Efeito |
|---|---|
| `--wait` | Bloqueia enquanto a sessão estiver em `starting` ou `working`. Exige referência |
| `--timeout-ms <n>` | Teto da espera (padrão: `120000`). No estouro imprime o estado e sai com **6** |
| `--json` | Uma linha de JSON no stdout |

O estouro de espera não é erro, é uma observação concluída — "ainda trabalhando".
Por isso o estado sai **antes** do código 6: sair com stdout vazio deixaria o
orquestrador cego.

### `ccx say` e `ccx answer`

```bash
ccx say auth-token "prioridade mudou, foque só no caminho de login"
ccx answer auth-token "mantenha a compatibilidade com o token v1"
```

`say` injeta mensagem numa sessão viva e funciona haja ou não pergunta pendente.
Mensagem que começa com traço vai depois de `--`:

```bash
ccx say auth-token -- "--force não era o que eu queria"
```

`answer` **recusa com código 3 quando não há pergunta pendente**. A recusa é
deliberada: sem ela, `answer` viraria um `say` disfarçado e o orquestrador
perderia o sinal de que estava respondendo a coisa nenhuma.

### `ccx result` e `ccx log`

```bash
ccx result auth-token             # texto final completo do último turno fechado
ccx result auth-token --turn 2    # um turno específico
ccx log auth-token --since 312    # só o que é novo, com o cursor novo
```

| Comando | Flag | Efeito |
|---|---|---|
| `result` | `--turn <n>` | Turno específico, contando de 1 (padrão: o último fechado) |
| `log` | `--since <cursor>` | Último `n` já visto (padrão: `0`, do início) |
| `log` | `--limit <n>` | Teto de entradas (padrão: `50`) |

**`result` é o único comando que gasta contexto de propósito.** Peça quando o
trabalho fechar, não durante. Reler o log do zero a cada consulta joga fora
exatamente o contexto que o `ccx` existe para poupar: use `--since <cursor>`.

O texto integral só está garantido quando o despacho usou `--raw`. Sem ele,
`result` cai em cadeia para fontes cada vez mais degradadas e **avisa no stderr**
quando o texto pode estar truncado — em vez de entregar texto cortado como se
fosse íntegro.

### `ccx stop`, `ccx rm` e `ccx ls`

```bash
ccx stop auth-token        # idempotente; preserva os arquivos da sessão
ccx rm auth-token          # recusa se houver supervisor vivo
ccx rm auth-token --force  # insiste
ccx ls --all               # inclui as sessões encerradas
```

```
a3f1c8d2  aguardando_resposta  t4   2m18s   0.42USD   auth-token  ...\projetos\api-gateway
b7e2f0a4  concluido            t2   2m18s   0.18USD   docs-api    ...\projetos\api-gateway
```

Por padrão `ls` mostra só sessão com supervisor vivo. Uma sessão `done` com
supervisor de pé continua na lista de propósito: ela ainda aceita diálogo.

### `ccx doctor`

```bash
ccx doctor
ccx doctor --json
```

Nunca lança por pré-requisito ausente: relata tudo e só depois sai com código 5
se algo essencial faltar. Reporta versão e caminho absoluto do Claude, a
conferência das flags usadas contra a ajuda local, o teste de escrita em cada
candidato de raiz de estado, a versão do Codex se presente, e os diretórios de
skills.

**Aviso é diferente de problema.** Aviso não impede despachar e por isso não muda
o código de saída. Misturar os dois faria o `doctor` mentir nas duas direções: ou
sairia 5 por skill ausente, ou diria "tudo pronto" com uma pendência real na tela.

### Códigos de saída

| Código | Significado |
|:---:|---|
| `0` | Sucesso |
| `1` | Erro de uso, argumento inválido ou faltando |
| `2` | Sessão não encontrada |
| `3` | Estado incompatível com a operação pedida |
| `4` | Nenhuma raiz de estado gravável |
| `5` | Pré-requisito ausente, como binário do Claude não encontrado |
| `6` | Tempo esgotado em espera explícita |

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `CCX_STATE_DIR` | Força a raiz de estado. Primeiro candidato da ordem de precedência |
| `CCX_CLAUDE_BIN` | Caminho **absoluto** do executável do Claude. Quando definida, é a única origem tentada |
| `CCX_SKIP_POSTINSTALL` | Pula o passo de postinstall na instalação |
| `CCX_DEBUG` | Imprime o rastro de pilha de erro inesperado, no stderr |
| `CODEX_HOME` | Diretório de configuração do Codex (padrão: `~/.codex`). Define onde a skill de usuário é gravada |

```bash
# bash / zsh
export CCX_STATE_DIR=/caminho/gravavel/ccx
export CCX_CLAUDE_BIN=/caminho/para/claude
```

```powershell
# PowerShell
$env:CCX_STATE_DIR = "C:\caminho\gravavel\ccx"
$env:CCX_CLAUDE_BIN = "C:\Users\<voce>\.local\bin\claude.exe"
```

---

## O contrato de sentinela

O despacho anexa ao prompt de sistema um contrato que obriga o subagente a fechar
todo turno com um de três marcadores:

| Marcador | Significado | Estado resultante |
|---|---|---|
| `@@DONE: <resumo>` | Trabalho concluído | `done` |
| `@@ASK: <pergunta>` | Precisa de uma decisão do orquestrador | `asking` |
| `@@BLOCKED: <motivo>` | Impossível prosseguir | `blocked` |
| _nenhum_ | Turno fechou sem marcador | **`ambiguous`** |

**Por que marcador e não heurística de texto.** Em modo headless não existe
ferramenta de pergunta ao usuário. Foi medido em execução: instruído a usar essa
ferramenta, o Claude a procurou, não encontrou, e formulou a pergunta em prosa
dentro do resultado final, com motivo de parada normal de fim de turno. Do ponto
de vista do fluxo de eventos, **um turno que faz uma pergunta é indistinguível de
um turno que concluiu a tarefa**. Detectar a diferença por heurística erraria nos
dois sentidos: um resumo que menciona uma dúvida seria lido como pergunta, e uma
pergunta sem interrogação passaria batida.

**Turno sem marcador nunca é conclusão.** Vira `ambiguous`, que é um estado
visível e acionável. Tratar ausência de marcador como conclusão transformaria
silenciosamente uma pergunta real em tarefa entregue, que é o pior modo de falha
possível deste sistema: o orquestrador segue adiante acreditando que o trabalho
acabou, quando o subagente na verdade parou esperando resposta.

---

## Limites de segurança

> [!IMPORTANT]
> **A cerca de diretório é defesa em profundidade, não fronteira.**

O despacho registra um hook de pré-uso de ferramenta que nega gravação quando o
caminho resolvido cai fora do `--cwd` declarado. A negação aparece na lista de
negações do resultado e portanto no estado compacto, de modo que o orquestrador
vê que houve tentativa de sair do escopo. O hook dispara antes da checagem de
modo, então a cerca vale **inclusive sob `bypassPermissions`**.

**A cerca não impede a ferramenta de shell de sair do diretório.** Um comando
pode mudar de diretório, usar caminho absoluto, ou invocar outro programa que
escreva onde quiser. Analisar linha de comando de shell para decidir isso é um
problema de segurança mal posto, e tentar resolver por lista de padrões daria
falsa confiança. Quem quiser fronteira real deve isolar por cópia de trabalho
separada.

**O subagente roda sem humano no circuito de decisão.** Ele escreve no disco sem
perguntar, e o Codex responde as dúvidas de escopo sozinho. São dois agentes com
poder de escrita e nenhuma pessoa entre eles. Isso foi uma escolha consciente de
projeto. Despache sobre trabalho versionado, para que o diff seja revisável.

O padrão de fábrica do modo de permissão é `auto`, e não o contorno total. A
razão é que o padrão vale para quem instala a ferramenta, não apenas para quem a
escreveu: entregar contorno completo de permissão por omissão seria decidir pelo
outro a escolha de maior consequência do despacho, num repositório que a
ferramenta desconhece. Quem quer autonomia irrestrita pede explicitamente:

```bash
ccx dispatch --permission-mode bypassPermissions --task "..." --cwd .
```

---

## A skill do Codex

A skill `claude-dispatch` é o que ensina o Codex a usar a ferramenta sozinho:
quando vale despachar, como escrever a tarefa, como acompanhar sem torrar
contexto, e o que fazer diante de um turno ambíguo. O conteúdo está em
[`skill/SKILL.md`](skill/SKILL.md) e é copiado como está — nada é gerado na hora.

O `postinstall` e o `ccx setup` já instalam a skill no escopo de usuário. O
comando abaixo existe para controle fino:

```bash
ccx install-skill                       # escopo de projeto: .agents/skills/<nome>
ccx install-skill --scope user          # escopo de usuário: <CODEX_HOME>/skills/<nome>
ccx install-skill --dir ../outro-repo   # troca a raiz de destino
ccx install-skill --dry-run             # mostra exatamente o que faria
```

| Flag | Padrão | Efeito |
|---|---|---|
| `--scope <project\|user>` | `project` | `project` grava em `.agents/skills/<nome>`; `user` grava em `<CODEX_HOME>/skills/<nome>` |
| `--dir <caminho>` | — | Troca a **raiz** de destino. O sufixo do escopo continua sendo aplicado |
| `--dry-run` | — | Simula, sem escrever nada |
| `--json` | — | Uma linha de JSON no stdout |

> Os padrões diferem de propósito: `ccx setup` é o caminho de instalação e usa
> `user`; `ccx install-skill` é o comando manual e usa `project`.

**Confira depois de instalar.** A conferência não é zelo excessivo: as fontes do
Codex divergem sobre onde uma skill de usuário deve ficar. A documentação aponta
um caminho sob o diretório do usuário, enquanto a skill embutida de instalação do
próprio Codex declara `$CODEX_HOME/skills/<nome>`, com padrão em `~/.codex/skills`.
A divergência foi resolvida em favor do diretório de configuração, porque é a
ferramenta oficial que executa a instalação e portanto descreve o comportamento
real.

Não existe subcomando de listagem de skills no Codex 0.154.0 — conferido por
`codex --help` e por `codex skills --help`, que cai na ajuda geral. O que existe é
o dump de prompt, e é para ele que a instrução de conferência aponta:

```bash
codex debug prompt-input   # e procure o nome da skill na seção de skills
```

**O escopo de projeto é o caminho firme**, confirmado em execução.

---

## Fatos verificados sobre o ambiente

Tudo abaixo foi verificado por **execução direta** numa máquina de
desenvolvimento Windows, entre 2026-09-11 e 2026-09-14 — não foi lido em documentação.

| Fato | Como foi verificado |
|---|---|
| Claude Code 2.1.268 | `claude --version` |
| Codex CLI 0.154.0, autenticação ChatGPT, sem chave de API | `codex --version`, `codex doctor` |
| `-p` com entrada e saída em fluxo JSON mantém o processo vivo por vários turnos | Duas mensagens pelo stdin, dois resultados no mesmo processo |
| O identificador de sessão permanece estável entre turnos | Os dois eventos de inicialização trouxeram o mesmo identificador |
| Um novo evento de inicialização chega a cada turno | Observado no segundo turno, com o mesmo identificador |
| `-p` e `--bg` são mutuamente exclusivos | Execução conjunta recusada |
| Sessões em modo de impressão não aparecem em `claude agents --json` | A listagem só trouxe sessões interativas |
| `--settings` aceita caminho de arquivo ou JSON embutido | Ajuda local do binário |
| Sem quem responda permissão, a chamada de ferramenta é negada e registrada | Resultado de ferramenta com erro e lista de negações preenchida |
| A ferramenta de pergunta ao usuário não existe em modo headless | O Claude a procurou, não encontrou, e perguntou em prosa |
| O sandbox do Codex não herda o PATH do usuário | Chamada por nome falhou com erro 2 do Windows. Por caminho absoluto, funcionou |
| Uma sessão headless completa roda dentro do sandbox do Codex, autenticada por OAuth | Execução sob `codex sandbox` retornou o texto pedido |
| No Windows, `spawn` de um `.cmd` exige `shell`, e de um `.mjs` não funciona | `EINVAL` e `EFTYPE`, respectivamente, com Node 24.19.0 |
| Gravabilidade não se presume: sob token restrito, **nenhum** candidato de raiz aceitou escrita | `EPERM` no diretório de trabalho, no temporário e no de aplicação |
| Em instalação global, `npm install -g github:<dono>/<repo>` de um pacote com script de instalação chega vazio | npm 10.9.9 e 11.17.0: `node_modules/<pacote>` virou link para `_cacache/tmp/git-clone*`, apagado no fim; a URL de tarball e `--install-links` instalaram cópia real |

**Flags que não existem nesta versão** e que relatórios de pesquisa citaram por
engano: `--allow-tools` (o nome correto é `--tools`), `--max-turns` e
`--max-cost-usd`. A fonte de verdade é a ajuda local do binário instalado, não a
documentação publicada. O `doctor` confere as flags usadas contra a ajuda local
para detectar mudança de versão cedo.

---

## Solução de problemas

### Comece sempre pelo diagnóstico

```bash
ccx doctor
```

### Nenhuma raiz de estado gravável (código 4)

É o primeiro problema que vai morder alguém, e vem do sandbox do Codex. Numa
sondagem sob token restrito, **nenhum** diretório aceitou escrita: nem o de
trabalho, nem o temporário, nem o de aplicação local, nem o do usuário.

O `dispatch` testa gravação de verdade — cria, escreve, lê de volta, remove — em
cada candidato, nesta ordem:

1. `CCX_STATE_DIR`, se definida.
2. Uma pasta reservada dentro do diretório de trabalho declarado.
3. O diretório temporário do sistema.
4. O diretório de estado de aplicação do usuário.

Se nenhum servir, ele recusa com código 4 e lista o erro de cada candidato, em
vez de criar uma sessão que perde o próprio estado. As três saídas:

```bash
# 1. apontar para um caminho que você sabe que é gravável
export CCX_STATE_DIR=/caminho/gravavel/ccx        # bash / zsh
```

```powershell
$env:CCX_STATE_DIR = "C:\caminho\gravavel\ccx"    # PowerShell
```

```
# 2. ampliar as raízes graváveis na configuração do Codex
# 3. rodar o Codex em modo de acesso mais amplo
```

### "Aponte `CCX_CLAUDE_BIN` para o `claude.exe`" (Windows)

O `ccx` recusa um binário terminado em `.cmd` ou `.bat`, que é como o npm instala
no Windows. A recusa é deliberada e a razão é medida: **um argumento com quebra
de linha não sobrevive ao interpretador de comandos**. Um
`--append-system-prompt` de três linhas chegou do outro lado com uma linha só.
Como o contrato de sentinela tem várias linhas, passar por um envelope de lote
faria todo turno voltar sem marcador — ou seja, `ambiguous` — sem causa visível
em lugar nenhum. Falhar alto custa uma mensagem de erro; deixar passar custaria a
confiança no sistema inteiro.

Saídas, na ordem de preferência:

```powershell
# 1. apontar para o binário de verdade, se a instalação tiver um
$env:CCX_CLAUDE_BIN = "C:\Users\<voce>\.local\bin\claude.exe"

# 2. instalar o Claude Code pelo instalador nativo, que entrega um .exe
```

Se houver um `claude.exe` ao lado do `claude.cmd`, o `ccx` troca sozinho e segue
sem incomodar.

### Binário do Claude não encontrado (código 5)

O sandbox do Codex não herda o PATH do usuário, então chamar `claude` pelo nome
falha. O `ccx` resolve o caminho absoluto sozinho, mas se a instalação estiver
fora dos lugares conhecidos, aponte explicitamente com `CCX_CLAUDE_BIN` — sempre
com caminho **absoluto**. Quando a variável está definida, ela é a única origem
tentada: um valor errado falha alto em vez de cair no PATH em silêncio.

### A sessão foi para `failed` logo depois do despacho

O supervisor grava o stderr do Claude no log da própria sessão:

```bash
ccx ls --all --json     # o campo "root" traz a raiz de estado em uso
# depois: <raiz>/sessions/<id>/supervisor.log
```

`ccx doctor` também mostra a raiz escolhida. As causas comuns são binário que não
executa, flag que sumiu na versão nova, e diretório de trabalho inexistente.

### A sessão ficou `ambiguous`

Não é erro: o turno fechou sem marcador. Leia o texto final no `status` e peça o
marcador correto com `ccx say`. **Nunca presuma conclusão.**

```bash
ccx say auth-token "Feche o turno com o marcador correto: @@DONE: se terminou,
@@ASK: se precisa de decisão minha, @@BLOCKED: se está impedido."
```

### `answer` recusado com código 3

Não existe pergunta pendente. Confira com `ccx status <ref>`. Para falar com a
sessão fora de uma pergunta, use `ccx say`.

### Referência de sessão ambígua (código 1)

O prefixo que você digitou casa com mais de uma sessão, ou o rótulo está
duplicado. `ccx ls` mostra os identificadores completos.

### `ccx ls` diz "nenhuma sessão" e você sabe que há

Os comandos de leitura não repetem cegamente a ordem de precedência do
`dispatch`: o primeiro candidato que **já tem sessão** vence. Se ainda assim a
lista vier vazia, a sessão pode não ter gravado estado ainda — `ls` avisa no
stderr quantas sessões estão nessa janela.

---

## Desenvolvimento

```bash
git clone https://github.com/PPiai/cc-to-codex
cd cc-to-codex
npm test              # node --test "tests/*.test.mjs"
```

`npm install` não baixa nada: não há dependências, nem de produção nem de
desenvolvimento.

**Nenhum teste consome cota paga.** A peça central é `tests/fake-claude.mjs`, um
executável que fala o mesmo fluxo de eventos do Claude Code, com comportamentos
selecionáveis por `CCX_FAKE_BEHAVIOR` ou por `--fake-behavior=<nome>`: `done`,
`ask-then-done`, `blocked`, `no-marker`, `denials`, `crash`, `slow`, `multi-turn`,
`bad-json`, `unknown-event`, `many-files` e `error-result`.

Ele também serve como biblioteca pura: `sessionScript({ behavior, prompts })`
devolve os eventos como objetos, sem tocar em disco, para alimentar o digest
evento por evento.

O cabeçalho de `tests/fake-claude.mjs` fixa a forma exata de cada evento medida
na versão 2.1.268. Quem consome o fluxo programa contra ela; se a forma mudar,
muda ali primeiro.

Três regras de desenho valem para todo o código:

1. **Saída de máquina e de humano são separadas.** Com `--json`, uma linha de
   JSON no stdout e nada mais. Progresso e diagnóstico sempre no stderr.
2. **Nenhum `process.exit` no meio da lógica.** Módulos lançam erro com `code`;
   só `bin/ccx.mjs` encerra o processo.
3. **Toda flag documentada é implementada, e toda flag implementada é
   documentada.** Uma flag declarada e não lida é pior que uma flag ausente: o
   chamador confia e não tem efeito.

---

## Plataformas

**Windows é o alvo validado primeiro**, com caminhos abstraídos desde o início —
nada de barra invertida literal no código, tudo por `path.join`. **Linux e macOS
entram como fase seguinte, não como promessa não testada.**

Esta é uma declaração de estado, não uma limitação de projeto: o código não tem
dependência de plataforma conhecida, mas só o que foi executado é que está
verificado, e este README não afirma o que não foi medido.

---

## Como contribuir

Contribuições são bem-vindas. Antes de abrir um PR:

1. `npm test` passando.
2. Toda flag nova documentada aqui **e** no texto de ajuda de `bin/ccx.mjs` — a
   regra 3 acima vale para PR também.
3. Fato novo sobre o ambiente só entra na tabela de fatos verificados com a forma
   de verificação ao lado. Nada de documentação copiada.
4. Issues e PRs podem ser em português ou inglês. O histórico de commits segue
   em português; identificadores e código seguem a convenção do repositório.

Encontrou uma divergência entre o que este README afirma e o que o código faz?
Isso é um bug, e o relato dele é tão útil quanto uma correção.

---

## Licença

[MIT](LICENSE) © PPiai
