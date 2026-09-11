---
name: claude-dispatch
description: Despacha trabalho substantivo para sessões do Claude Code como subagentes e acompanha cada uma por estado compacto, usando a CLI ccx. Use quando a tarefa for implementação de verdade, investigação de bug, refatoração em vários arquivos, ou uma segunda opinião de diagnóstico, e você quiser continuar trabalhando enquanto o subagente roda. Também para responder perguntas que o subagente levantar, mandar correção de rumo no meio do caminho, e colher o resultado final. Não use para o que você mesmo termina em poucos passos.
---

# Despachar Claude Code como subagente

O `ccx` mantém uma sessão do Claude Code viva num processo próprio e te dá quatro
coisas que `claude -p "faça X"` não dá: o despacho não bloqueia, o acompanhamento
custa poucas linhas em vez de milhares de tokens, dá para mandar mensagem nova
para uma sessão em andamento, e dá para responder uma dúvida que ela levante.

## Quando despachar e quando não

Despache trabalho substantivo:

- Implementação de verdade, com vários arquivos e verificação.
- Investigação de bug que exige ler bastante código antes de concluir.
- Refatoração que atravessa módulos.
- Segunda opinião de diagnóstico, quando você quer uma leitura independente.

Não despache o que você termina rápido: ler um arquivo para se orientar,
responder uma pergunta, ajustar uma configuração, rodar um comando pontual,
correção de uma linha. Cada despacho tem custo real por turno, então despache
por necessidade e não por hábito.

## Como escrever a tarefa

O prompt enviado ao Claude precisa ser autossuficiente. O subagente não vê a sua
conversa, não vê o que você já leu, e não pode te perguntar no meio sem gastar um
turno inteiro. Um prompt vago vira um turno gasto pedindo esclarecimento.

Inclua sempre estes quatro itens:

1. **O que ler primeiro**, com caminhos exatos. Isso ancora o subagente no código
   real em vez de deixá-lo procurar.
2. **O escopo exato**, dito pelo resultado esperado e não pelo método.
3. **Os arquivos que ele possui e os que não deve tocar.** É o que evita dois
   subagentes escrevendo no mesmo arquivo, e é o que torna seguro despachar mais
   de um ao mesmo tempo.
4. **O formato de retorno esperado.** O que você quer ler quando ele terminar.

```bash
ccx dispatch --label auth-refactor --cwd . --task "Leia primeiro src/auth/session.ts e src/auth/token.ts.
Extraia a rotação de token para um módulo novo em src/auth/rotate.ts e faça os dois
chamadores existentes usarem o módulo novo.
Você possui: src/auth/rotate.ts, src/auth/session.ts, src/auth/token.ts e os testes deles.
Não toque em: src/api/, nas migrações, nem no package.json.
Ao terminar, relate os arquivos alterados e o resultado de npm test -- auth."
```

Para tarefas longas, `--task-file <caminho>` evita brigar com as aspas do shell.

## O ciclo de acompanhamento

```bash
ccx dispatch --task "..." --label auth-refactor   # retorna na hora, com um id curto
ccx status auth-refactor                          # barato, cerca de 15 linhas
ccx status auth-refactor --wait --timeout-ms 60000 # bloqueia até o turno fechar
ccx result auth-refactor                          # só quando o trabalho fechar
```

`status` é o comando de acompanhamento. Ele cabe em cerca de quinze linhas para
qualquer tarefa, por longa que seja, porque agrega em vez de acumular: chamadas
de ferramenta viram contagem, arquivos tocados viram lista curta com excedente
contado, e a última frase do assistente vem truncada.

**`result` é o único comando que gasta contexto de propósito.** Ele entrega o
texto final completo do turno. Peça só quando o trabalho fechar, não durante.

**Ler o log inteiro é desperdício.** `ccx log <id>` existe para acompanhamento
incremental e devolve um cursor: use `--since <cursor>` para pegar só o que é
novo. Reler do zero a cada consulta joga fora exatamente o contexto que o `ccx`
existe para poupar.

Referencie a sessão pelo rótulo, pelo id curto, ou por um prefixo único do id.

## Como responder uma pergunta

Quando um turno fecha pedindo decisão, o estado vira `asking` e o estado compacto
publica a pergunta pendente.

```bash
ccx status auth-refactor        # estado asking, com a pergunta
ccx answer auth-refactor "mantenha a compatibilidade com o token v1"
```

`answer` só é aceito quando existe pergunta pendente. Se não existir, ele recusa
em vez de virar uma mensagem comum, para que você não responda a coisa nenhuma
sem perceber. Para falar com a sessão fora desse caso, use `say`:

```bash
ccx say auth-refactor "prioridade mudou, foque só no caminho de login"
```

## O estado ambíguo

**Um turno que terminou sem marcador não terminou.**

O subagente é instruído a fechar todo turno com um de três marcadores:
`@@DONE:` para conclusão, `@@ASK:` para pergunta, `@@BLOCKED:` para impedimento.
Quando nenhum aparece, o estado vira `ambiguous`, e nunca `done`.

Isso não é um detalhe de implementação. Em modo headless não existe ferramenta de
pergunta ao usuário: quando o Claude precisa decidir algo, ele pergunta em prosa
dentro do texto final, e o turno fecha com sucesso normal. Do lado de fora, um
turno que faz uma pergunta é indistinguível de um turno que concluiu a tarefa.
Por isso a classificação é pelo marcador e nunca pelo teor.

Diante de `ambiguous`, leia o texto final no estado compacto e **mande uma
mensagem pedindo que o subagente feche com o marcador correto**:

```bash
ccx say auth-refactor "Feche o turno com o marcador correto: @@DONE: se terminou,
@@ASK: se precisa de decisão minha, @@BLOCKED: se está impedido."
```

**Nunca presuma conclusão a partir de um turno ambíguo.** Seguir adiante
acreditando que o trabalho acabou, quando o subagente na verdade parou esperando
resposta, é o pior modo de falha deste sistema.

## A regra de falha

**Se o despacho falhar, ou se o Claude nunca rodar, não faça o trabalho por conta
própria e apresente como se fosse do subagente. Não invente um resultado.
Relate a falha e pare.**

Falha aqui significa: `dispatch` saiu com código diferente de zero, a sessão foi
para `failed`, ou `result` não tem conteúdo. Nesses casos o relato ao usuário diz
o que foi tentado, qual o código de saída, e o que `ccx doctor` respondeu.

A razão é direta: se o orquestrador cobre a falha do subagente escrevendo o
código sozinho, o usuário perde a informação de que o subagente nunca rodou. Ele
passa a confiar num circuito que está quebrado, e a próxima falha vem maior e
mais tarde. Relatar a falha é o comportamento correto, mesmo quando você
conseguiria fazer a tarefa.

Depois de relatar, o usuário pode pedir que você faça diretamente. Aí é trabalho
seu, apresentado como seu.

## Limitações honestas

- **A cerca de diretório é defesa em profundidade, não fronteira.** O `--cwd`
  registra um hook que nega gravação por caminho fora do diretório declarado, e
  as tentativas aparecem como negações no estado compacto. Mas **a ferramenta de
  shell pode contorná-la**: um comando pode mudar de diretório, usar caminho
  absoluto, ou chamar outro programa. Quem precisa de fronteira real deve isolar
  numa cópia de trabalho separada.
- **O subagente roda em modo autônomo e escreve no disco sem pedir permissão.**
  Não há humano no circuito de decisão. Despache sobre trabalho versionado, para
  que o diff seja revisável e reversível.
- **Custo por turno é real.** A medição desta máquina ficou na casa de 0,15 USD
  no primeiro turno de uma sessão, inflada por criação de cache de contexto.
  Turnos seguintes na mesma sessão custam bem menos, então preferir `say` numa
  sessão viva a despachar uma sessão nova é mais barato além de mais rápido.
- **O que você lê é o fluxo de eventos**, não a transcrição interna do Claude
  Code. Ferramenta e custo vêm dos eventos; não conte com detalhe além disso.

## Referência rápida

| Comando | Para quê |
|---|---|
| `ccx dispatch --task "..." [--label nome] [--cwd dir]` | Cria a sessão e retorna na hora |
| `ccx status [ref]` | Estado compacto. Sem referência, lista tudo |
| `ccx status <ref> --wait --timeout-ms <n>` | Bloqueia até o turno fechar |
| `ccx say <ref> "mensagem"` | Correção de rumo numa sessão viva |
| `ccx answer <ref> "resposta"` | Responde pergunta pendente. Recusa se não houver |
| `ccx result <ref>` | Texto final completo. Gasta contexto de propósito |
| `ccx log <ref> --since <cursor>` | Acompanhamento incremental |
| `ccx stop <ref>` | Encerra de forma ordenada. Preserva os arquivos |
| `ccx rm <ref>` | Apaga a sessão. Recusa se estiver viva |
| `ccx ls [--all]` | Lista as sessões conhecidas |
| `ccx doctor` | Diagnóstico. Rode antes do primeiro despacho |

Códigos de saída: `0` sucesso, `1` uso, `2` sessão não encontrada, `3` estado
incompatível, `4` nenhuma raiz de estado gravável, `5` pré-requisito ausente,
`6` tempo esgotado.

Todo comando aceita `--json` para saída de máquina em uma linha.
