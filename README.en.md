<div align="right">

[Português](README.md) · **English**

</div>

<div align="center">

# ccx

**Let [Codex CLI](https://github.com/openai/codex) dispatch and track [Claude Code](https://claude.com/claude-code) sessions as subagents — without blocking, without flooding its context, and with a two-way message channel.**

[![CI](https://github.com/PPiai/cc-to-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/PPiai/cc-to-codex/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18.18](https://img.shields.io/badge/node-%3E%3D%2018.18-5a5a5a.svg)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-2ea44f.svg)](package.json)

</div>

---

```bash
npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

One command. `postinstall` runs the diagnostics and installs the Codex skill on its own.
Since `npm` hides the output of install scripts, run `ccx setup` whenever you want
to see what's ready — it's idempotent.

---

## The full loop

Dispatch, track, answer, collect — four commands, start to finish.

```bash
# 1. dispatch and get control back immediately, without waiting for the first turn
ccx dispatch --label auth-token --cwd . --task "Extract the token rotation from
src/auth/session.ts into src/auth/rotate.ts and switch both callers over to the
new module. Don't touch src/api/ or the migrations."
```

```
sessao    a3f1c8d2  rotulo auth-token
estado    iniciando
supervisor  18422
cwd       C:\Users\<you>\projects\api-gateway
proximo   ccx status auth-token    (bloqueando: ccx status auth-token --wait)
```

The CLI prints its labels in Portuguese, and every output block in this README
shows them exactly as `ccx` emits them.

```bash
# 2. track it. fits in 15 lines for any task, no matter how long it runs
ccx status auth-token
```

```
sessao    a3f1c8d2  rotulo auth-token
estado    aguardando_resposta
fase      editing, turno 4, ativa ha 2m18s
cwd       C:\Users\<you>\projects\api-gateway
claude    sessao 0744770c, processo 18430, vivo
turnos    4 fechados: concluido x3, aguardando_resposta x1
tools     27 chamadas: Read x12, Bash x7, Grep x5, Edit x3
arquivos  3: src/auth/session.ts, src/auth/token.ts, src/auth/rotate.ts
negacoes  nenhuma
custo     0.42 USD acumulado
ultima    "Finished mapping the three entry points for token rotation in...
pergunta  "Should I keep backward compatibility with the v1 token, or can I
          remove the old code path?"
cursor    312
```

```bash
# 3. answer the question the subagent raised, and it picks the work back up
ccx answer auth-token "keep backward compatibility with the v1 token"

# 4. collect the final text, only once the work wraps up
ccx result auth-token
```

That status block is the whole product in miniature: **constant size**.
A two-minute task and a two-hour task take up the same fifteen lines,
because tool calls collapse into counts, touched files into a short list with
the overflow tallied, and the assistant's last sentence gets truncated.

<details>
<summary><b>Contents</b></summary>

- [Installation](#installation)
- [First dispatch](#first-dispatch)
- [Why it exists](#why-it-exists)
- [How it works](#how-it-works)
- [Command reference](#command-reference)
  - [Exit codes](#exit-codes)
  - [Environment variables](#environment-variables)
- [The sentinel contract](#the-sentinel-contract)
- [Safety limits](#safety-limits)
- [The Codex skill](#the-codex-skill)
- [Verified facts about the environment](#verified-facts-about-the-environment)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Platforms](#platforms)
- [Contributing](#contributing)
- [License](#license)

</details>

---

## Installation

```bash
npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

There's nothing to download: the package is plain Node, ESM, and the
`node_modules` tree stays empty.

> **Why the tarball URL instead of `github:PPiai/cc-to-codex`?** On a global
> install of a package with an install script, npm 10 and 11 turn the `github:`
> form into a link to a temporary clone that npm itself deletes afterwards, so the
> package arrives empty. The tarball URL installs a real copy. If you prefer the
> short form, add `--install-links`.

**Prerequisites**

| Requirement | Why |
|---|---|
| Node 18.18 or newer | The floor declared in `package.json`; `doctor` complains below it |
| Claude Code, installed and authenticated | It's the process `ccx` supervises |
| Codex CLI | Optional. `ccx` works without it; without Codex, there's no way to verify the skill |

### What postinstall does

On a global install, `postinstall` runs on its own and does two things:

1. **Diagnostics.** The same as `ccx doctor`: where the Claude binary lives and whether
   it runs, which flags the local help still recognizes, which state root actually
   accepts writes, and whether any module is missing from the package.
2. **Installs the Codex skill at user scope**, so Codex already knows how to use
   the tool with zero manual setup.

**The postinstall step never fails the install.** If Claude isn't installed, if no
directory accepts writes, if Codex isn't on the machine — it keeps going instead of
aborting. Installing a CLI and watching `npm` abort over a third-party prerequisite
is exactly the kind of friction that makes people give up before they ever reach
their first dispatch; `ccx setup` redoes everything once the environment is ready.

**`npm` hides the postinstall output.** Install scripts run silently by default, so
the install finishes without showing the diagnostics or the path the skill was
written to. To see them, run `ccx setup` afterwards, or install with script output
visible:

```bash
npm install -g https://github.com/PPiai/cc-to-codex/tarball/main --foreground-scripts
```

The same `ccx setup` covers an `npm` configured not to run install scripts:
without postinstall, the skill never gets written, and setup writes it.

To skip the step — in a CI image, a build container, or an automated
install:

```bash
# bash / zsh
CCX_SKIP_POSTINSTALL=1 npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

```powershell
# PowerShell
$env:CCX_SKIP_POSTINSTALL = "1"; npm install -g https://github.com/PPiai/cc-to-codex/tarball/main
```

### `ccx setup`

Redoes the diagnostics and the skill install explicitly and **idempotently** —
running it twice gives the same result as running it once. It's the command for when
the install step was skipped, when the environment changed, or when you just want
to confirm everything is up and running.

```bash
ccx setup                      # user scope (default)
ccx setup --scope project      # writes the skill inside the current project
ccx setup --json               # one line of JSON, for automation
```

| Flag | Default | Effect |
|---|---|---|
| `--scope user\|project` | `user` | Where the Codex skill is written |
| `--json` | — | One line of JSON on stdout, and nothing else |

**One deliberate difference from postinstall:** here, a missing prerequisite exits
with **code 5**, never 0. Whoever types `ccx setup` is asking "is it ready?", and
answering 0 with Claude Code missing would be lying to a script that chains
commands. The postinstall step always exits 0 because failing there would abort the
install of the entire package.

---

## First dispatch

Once it's installed, check the environment and fire away:

```bash
ccx doctor
ccx dispatch --task "Read src/server.ts and list the endpoints with no tests." --cwd .
ccx status
```

**Run `ccx doctor` before your first dispatch.** In a single command, it answers the
four questions that cover nearly every failure: where Claude is and whether it
runs, which flags the local help still recognizes, which state root is
writable, and whether anything is missing from the package.

Write the task the way you'd write it for a colleague who hasn't seen your conversation.
The prompt has to stand on its own: **what to read first**, with exact paths,
**the scope**, stated as the expected outcome, **which files it owns and which it
must not touch**, and **the return format**. A vague prompt turns into an entire
turn spent asking for clarification.

For long tasks, `--task-file <path>` spares you a fight with shell quoting.

---

## Why it exists

Codex can already run shell commands, so technically it can already call
`claude -p "do X"`. The problem is that this gives you a single blind shot, with
three flaws that make real orchestration a non-starter.

> **It blocks.** `claude -p` only returns when the task is over. A twenty-minute
> task holds Codex's turn hostage for twenty minutes, with zero visibility.

> **It dumps everything at once.** The entire output lands in Codex's context. On a
> long task, that's tens of thousands of tokens of tool logs the orchestrator
> doesn't need to see. Codex ends up burning its own context reading someone
> else's work.

> **It's mute in both directions.** There's no way to send a course correction after
> dispatch, and no way to answer a question Claude raises halfway through.
> If Claude needs a decision, it guesses or it stops.

`ccx` closes all three gaps. Dispatch returns immediately, tracking fits in about
fifteen lines for any task, and the message channel works both ways for as long
as the session is alive.

---

## How it works

A **supervisor per session** keeps `claude` alive with streaming JSON input and
output, digests the events into compact, constant-size state, and feeds Claude's
stdin the messages that arrive through a file-based command channel.

The **CLI is a short-lived process** that reads files and exits. Each call from
Codex costs milliseconds, and **there is no global daemon**.

```
┌─────────┐   dispatch/say/answer    ┌──────────────┐   stdin (stream-json)   ┌────────┐
│  Codex  │ ───────────────────────► │   commands   │ ──────────────────────► │        │
│   CLI   │                          │    .jsonl    │                         │ claude │
│         │                          └──────────────┘                         │  -p    │
│ (or     │                          ┌──────────────┐   stdout (stream-json)  │        │
│  you)   │ ◄─────────────────────── │  state.json  │ ◄────────────────────── │        │
└─────────┘   status/log/result      │ events.jsonl │        digest           └────────┘
                                     └──────────────┘
                                      supervisor (1 process per session)
```

Each session lives in `<root>/sessions/<id>/`, with `meta.json`, `state.json`,
`events.jsonl`, `commands.jsonl`, `settings.json`, `supervisor.log` and — only with
`--raw` — `raw.jsonl`.

The internal signatures of every module are in [`docs/CONTRACT.md`](docs/CONTRACT.md).

---

## Command reference

Refer to a session by its **label**, its **short id**, or a **unique prefix**
of the id, the same way `git` handles hashes.

Every command accepts `--json` for machine output on **a single line**. Progress and
diagnostics go to stderr, never to stdout, so stdout can be consumed without any
filtering. On error, stdout stays empty.

### `ccx dispatch`

Creates the session and returns immediately. It doesn't wait for the first turn.

```bash
ccx dispatch --task "..." --label auth-token --cwd . --raw
ccx dispatch --task-file ./task.md --cwd ../other-project
```

| Flag | Effect |
|---|---|
| `--task <text>` | The task, as a string. Mutually exclusive with `--task-file` |
| `--task-file <path>` | The task, read from a file. Mutually exclusive with `--task` |
| `--cwd <path>` | The subagent's working directory (default: the current one) |
| `--label <name>` | A label, so you can refer to the session by name |
| `--tools <list>` | Restricts Claude's built-in tools. An empty string disables them all; cuts cache cost |
| `--model <model>` | Model for this session |
| `--permission-mode <mode>` | `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` (default: `auto`) |
| `--fence` / `--no-fence` | Fence against writes outside `--cwd` (default: on). Also accepts `--fence=off` |
| `--raw` | Also keeps the raw stream in `raw.jsonl`. Costs disk space, and it's what lets `ccx result` return the final text untruncated |
| `--json` | One line of JSON on stdout |

`dispatch` **takes no positional arguments**. The refusal is deliberate: without it,
a `--fence off` typed with a space would turn into a discarded positional, and the
fence would stay on — silently — against an explicit request to turn it off.

### `ccx status`

With no reference, it lists every known session. With a reference, it prints the
compact state.

```bash
ccx status                                        # one line per session
ccx status auth-token                             # the 15-line block
ccx status auth-token --wait --timeout-ms 60000   # blocks
```

| Flag | Effect |
|---|---|
| `--wait` | Blocks while the session is `starting` or `working`. Requires a reference |
| `--timeout-ms <n>` | Upper bound on the wait (default: `120000`). On timeout, prints the state and exits with **6** |
| `--json` | One line of JSON on stdout |

A timeout isn't an error; it's a completed observation — "still working".
That's why the state is printed **before** exit code 6: exiting with an empty stdout
would leave the orchestrator blind.

### `ccx say` and `ccx answer`

```bash
ccx say auth-token "priorities changed, focus only on the login path"
ccx answer auth-token "keep backward compatibility with the v1 token"
```

`say` injects a message into a live session, and it works whether or not a question
is pending. A message that starts with a dash goes after `--`:

```bash
ccx say auth-token -- "--force is not what I wanted"
```

`answer` **refuses with code 3 when there's no pending question**. The refusal is
deliberate: without it, `answer` would become a `say` in disguise, and the orchestrator
would lose the signal that it was answering nothing at all.

### `ccx result` and `ccx log`

```bash
ccx result auth-token             # full final text of the last closed turn
ccx result auth-token --turn 2    # a specific turn
ccx log auth-token --since 312    # only what's new, plus the new cursor
```

| Command | Flag | Effect |
|---|---|---|
| `result` | `--turn <n>` | A specific turn, counting from 1 (default: the last closed one) |
| `log` | `--since <cursor>` | Last `n` already seen (default: `0`, from the beginning) |
| `log` | `--limit <n>` | Maximum number of entries (default: `50`) |

**`result` is the only command that spends context on purpose.** Ask for it once the
work is done, not while it's in progress. Rereading the log from scratch on every
check throws away exactly the context `ccx` exists to save: use `--since <cursor>`.

The full text is only guaranteed when the dispatch used `--raw`. Without it,
`result` falls back through progressively more degraded sources and **warns on
stderr** when the text may be truncated — instead of handing you cut-off text as if
it were complete.

### `ccx stop`, `ccx rm`, and `ccx ls`

```bash
ccx stop auth-token        # idempotent; keeps the session's files
ccx rm auth-token          # refuses if a supervisor is alive
ccx rm auth-token --force  # does it anyway
ccx ls --all               # includes ended sessions
```

```
a3f1c8d2  aguardando_resposta  t4   2m18s   0.42USD   auth-token  ...\projects\api-gateway
b7e2f0a4  concluido            t2   2m18s   0.18USD   docs-api    ...\projects\api-gateway
```

By default, `ls` only shows sessions with a live supervisor. A `done` session whose
supervisor is still up stays on the list on purpose: you can still talk to it.

### `ccx doctor`

```bash
ccx doctor
ccx doctor --json
```

It never throws over a missing prerequisite: it reports everything first, and only
then exits with code 5 if something essential is missing. It reports Claude's version
and absolute path, the check of the flags in use against the local help, the write
test on every state root candidate, Codex's version if present, and the skills
directories.

**A warning is not a problem.** A warning doesn't stop you from dispatching, so it
doesn't change the exit code. Conflating the two would make `doctor` lie in both
directions: it would either exit 5 over a missing skill, or say "all set" with a real
outstanding issue right there on screen.

### Exit codes

| Code | Meaning |
|:---:|---|
| `0` | Success |
| `1` | Usage error: invalid or missing argument |
| `2` | Session not found |
| `3` | State incompatible with the requested operation |
| `4` | No writable state root |
| `5` | Missing prerequisite, such as the Claude binary not being found |
| `6` | Timed out during an explicit wait |

### Environment variables

| Variable | Purpose |
|---|---|
| `CCX_STATE_DIR` | Forces the state root. First candidate in the precedence order |
| `CCX_CLAUDE_BIN` | **Absolute** path to the Claude executable. When set, it's the only source tried |
| `CCX_SKIP_POSTINSTALL` | Skips the postinstall step during installation |
| `CCX_DEBUG` | Prints the stack trace of unexpected errors to stderr |
| `CODEX_HOME` | Codex's config directory (default: `~/.codex`). Determines where the user-scope skill is written |

```bash
# bash / zsh
export CCX_STATE_DIR=/writable/path/ccx
export CCX_CLAUDE_BIN=/path/to/claude
```

```powershell
# PowerShell
$env:CCX_STATE_DIR = "C:\writable\path\ccx"
$env:CCX_CLAUDE_BIN = "C:\Users\<you>\.local\bin\claude.exe"
```

---

## The sentinel contract

Dispatch appends a contract to the system prompt that requires the subagent to end
every turn with one of three markers:

| Marker | Meaning | Resulting state |
|---|---|---|
| `@@DONE: <summary>` | Work complete | `done` |
| `@@ASK: <question>` | Needs a decision from the orchestrator | `asking` |
| `@@BLOCKED: <reason>` | Can't proceed | `blocked` |
| _none_ | Turn closed without a marker | **`ambiguous`** |

**Why a marker instead of a text heuristic.** In headless mode, there is no
ask-the-user tool. This was measured in a real run: told to use that tool, Claude
looked for it, didn't find it, and wrote the question out in prose inside the final
result, with a normal end-of-turn stop reason. As far as the event stream is
concerned, **a turn that asks a question is indistinguishable from a turn that
finished the task**. A heuristic would get it wrong in both directions: a summary
that mentions an open question would be read as a question, and a question without
a question mark would slip right through.

**A turn without a marker is never a completion.** It becomes `ambiguous`, a visible,
actionable state. Treating a missing marker as completion would silently turn a real
question into a delivered task, which is the worst possible failure mode for this
system: the orchestrator moves on believing the work is finished, when the subagent
actually stopped to wait for an answer.

---

## Safety limits

> [!IMPORTANT]
> **The directory fence is defense in depth, not a boundary.**

Dispatch registers a pre-tool-use hook that denies writes when the resolved path
falls outside the declared `--cwd`. The denial shows up in the result's list of
denials, and therefore in the compact state, so the orchestrator can see that
something tried to step out of scope. The hook fires before the mode check, so the
fence holds **even under `bypassPermissions`**.

**The fence doesn't stop the shell tool from leaving the directory.** A command can
change directories, use an absolute path, or invoke some other program that writes
wherever it likes. Parsing a shell command line to decide this is an ill-posed
security problem, and trying to solve it with a list of patterns would give false
confidence. If you want a real boundary, isolate the work in a separate working copy.

**The subagent runs with no human in the decision loop.** It writes to disk without
asking, and Codex answers scope questions on its own. That's two agents with write
access and nobody in between. This was a conscious design choice. Dispatch against
version-controlled work, so the diff can be reviewed.

The factory default permission mode is `auto`, not full bypass. The reason is that
the default applies to everyone who installs the tool, not just the person who wrote
it: shipping full permission bypass out of the box would make the most consequential
decision of the dispatch on someone else's behalf, in a repository the tool knows
nothing about. If you want unrestricted autonomy, ask for it explicitly:

```bash
ccx dispatch --permission-mode bypassPermissions --task "..." --cwd .
```

---

## The Codex skill

The `claude-dispatch` skill is what teaches Codex to use the tool on its own:
when a dispatch is worth it, how to write the task, how to track progress without
burning context, and what to do when a turn comes back ambiguous. The content lives
in [`skill/SKILL.md`](skill/SKILL.md) and is copied as-is — nothing is generated on
the fly.

`postinstall` and `ccx setup` already install the skill at user scope. The command
below is there for fine-grained control:

```bash
ccx install-skill                       # project scope: .agents/skills/<name>
ccx install-skill --scope user          # user scope: <CODEX_HOME>/skills/<name>
ccx install-skill --dir ../other-repo   # changes the destination root
ccx install-skill --dry-run             # shows exactly what it would do
```

| Flag | Default | Effect |
|---|---|---|
| `--scope <project\|user>` | `project` | `project` writes to `.agents/skills/<name>`; `user` writes to `<CODEX_HOME>/skills/<name>` |
| `--dir <path>` | — | Changes the destination **root**. The scope suffix is still applied |
| `--dry-run` | — | Simulates, without writing anything |
| `--json` | — | One line of JSON on stdout |

> The defaults differ on purpose: `ccx setup` is the install path and uses
> `user`; `ccx install-skill` is the manual command and uses `project`.

**Verify after installing.** This isn't excess caution: Codex's own sources disagree
about where a user skill should live. The documentation points to a path under the
user's home directory, while Codex's own built-in install skill declares
`$CODEX_HOME/skills/<name>`, defaulting to `~/.codex/skills`. The conflict was
settled in favor of the config directory, because the official tool is the one that
actually performs the install, and therefore describes the real behavior.

There is no skill-listing subcommand in Codex 0.154.0 — checked with `codex --help`
and with `codex skills --help`, which falls back to the general help. What does exist
is the prompt dump, and that's what the verification instructions point to:

```bash
codex debug prompt-input   # then look for the skill name in the skills section
```

**Project scope is the solid path**, confirmed in a real run.

---

## Verified facts about the environment

Everything below was verified by **running it directly** on a Windows development
machine, between 2026-09-11 and 2026-09-14 — not read from documentation.

| Fact | How it was verified |
|---|---|
| Claude Code 2.1.268 | `claude --version` |
| Codex CLI 0.154.0, ChatGPT authentication, no API key | `codex --version`, `codex doctor` |
| `-p` with streaming JSON input and output keeps the process alive across multiple turns | Two messages over stdin, two results from the same process |
| The session identifier stays stable across turns | Both init events carried the same identifier |
| A new init event arrives on every turn | Observed on the second turn, with the same identifier |
| `-p` and `--bg` are mutually exclusive | Running them together was rejected |
| Print-mode sessions don't show up in `claude agents --json` | The listing only returned interactive sessions |
| `--settings` accepts a file path or inline JSON | The binary's local help |
| With nobody to answer the permission prompt, the tool call is denied and recorded | A tool result with an error, and the denials list populated |
| The ask-the-user tool doesn't exist in headless mode | Claude looked for it, didn't find it, and asked in prose |
| The Codex sandbox doesn't inherit the user's PATH | Calling by name failed with Windows error 2. By absolute path, it worked |
| A full headless session runs inside the Codex sandbox, authenticated via OAuth | A run under `codex sandbox` returned the requested text |
| On Windows, `spawn` on a `.cmd` requires `shell`, and on a `.mjs` it doesn't work | `EINVAL` and `EFTYPE`, respectively, with Node 24.19.0 |
| Writability can't be taken for granted: under a restricted token, **no** root candidate accepted writes | `EPERM` in the working, temp, and application directories |
| On a global install, `npm install -g github:<owner>/<repo>` of a package with an install script arrives empty | npm 10.9.9 and 11.17.0: `node_modules/<package>` became a link to `_cacache/tmp/git-clone*`, deleted at the end; the tarball URL and `--install-links` installed a real copy |

**Flags that don't exist in this version**, even though research reports cited them
by mistake: `--allow-tools` (the correct name is `--tools`), `--max-turns`, and
`--max-cost-usd`. The source of truth is the local help of the installed binary, not
the published documentation. `doctor` checks the flags in use against the local help
to catch version changes early.

---

## Troubleshooting

### Always start with the diagnostics

```bash
ccx doctor
```

### No writable state root (code 4)

This is the first problem that's going to bite someone, and it comes from the Codex
sandbox. In a probe under a restricted token, **no** directory accepted writes: not
the working directory, not temp, not local application data, not the user's home.

`dispatch` tests writes for real — create, write, read back, remove — on each
candidate, in this order:

1. `CCX_STATE_DIR`, if set.
2. A reserved folder inside the declared working directory.
3. The system temp directory.
4. The user's application state directory.

If none of them works, it refuses with code 4 and lists each candidate's error,
instead of creating a session that loses its own state. Three ways out:

```bash
# 1. point it at a path you know is writable
export CCX_STATE_DIR=/writable/path/ccx           # bash / zsh
```

```powershell
$env:CCX_STATE_DIR = "C:\writable\path\ccx"       # PowerShell
```

```
# 2. widen the writable roots in the Codex config
# 3. run Codex in a broader access mode
```

### `ccx` wants `CCX_CLAUDE_BIN` pointed at `claude.exe` (Windows)

`ccx` refuses a binary ending in `.cmd` or `.bat`, which is how npm installs it on
Windows. The refusal is deliberate, and the reason was measured: **an argument
containing a line break doesn't survive the command interpreter**. A three-line
`--append-system-prompt` came out the other side as a single line. Since the
sentinel contract spans several lines, going through a batch wrapper would make
every turn come back without a marker — in other words, `ambiguous` — with no
visible cause anywhere. Failing loudly costs one error message; letting it slide
would cost trust in the entire system.

Ways out, in order of preference:

```powershell
# 1. point it at the real binary, if your install has one
$env:CCX_CLAUDE_BIN = "C:\Users\<you>\.local\bin\claude.exe"

# 2. install Claude Code with the native installer, which ships a .exe
```

If there's a `claude.exe` sitting next to `claude.cmd`, `ccx` switches to it on its
own and carries on without bothering you.

### Claude binary not found (code 5)

The Codex sandbox doesn't inherit the user's PATH, so calling `claude` by name
fails. `ccx` resolves the absolute path on its own, but if the install lives outside
the known locations, point to it explicitly with `CCX_CLAUDE_BIN` — always with an
**absolute** path. When the variable is set, it's the only source tried: a wrong
value fails loudly instead of silently falling back to PATH.

### The session went to `failed` right after dispatch

The supervisor writes Claude's stderr to the session's own log:

```bash
ccx ls --all --json     # the "root" field holds the state root in use
# then: <root>/sessions/<id>/supervisor.log
```

`ccx doctor` also shows the chosen root. The usual suspects are a binary that won't
run, a flag that disappeared in a new version, and a working directory that doesn't
exist.

### The session ended up `ambiguous`

It's not an error: the turn closed without a marker. Read the final text in `status`
and ask for the correct marker with `ccx say`. **Never assume completion.**

```bash
ccx say auth-token "Close the turn with the correct marker: @@DONE: if you're done,
@@ASK: if you need a decision from me, @@BLOCKED: if you're blocked."
```

### `answer` refused with code 3

There's no pending question. Check with `ccx status <ref>`. To talk to the session
outside of a question, use `ccx say`.

### Ambiguous session reference (code 1)

The prefix you typed matches more than one session, or the label is a duplicate.
`ccx ls` shows the full identifiers.

### `ccx ls` reports no sessions, but you know there are some

Read commands don't blindly replay the `dispatch` precedence order: the first
candidate that **already has a session** wins. If the list still comes back empty,
the session may not have written its state yet — `ls` warns on stderr how many
sessions are in that window.

---

## Development

```bash
git clone https://github.com/PPiai/cc-to-codex
cd cc-to-codex
npm test              # node --test "tests/*.test.mjs"
```

`npm install` downloads nothing: there are no dependencies, neither production nor
development.

**No test burns paid quota.** The centerpiece is `tests/fake-claude.mjs`, an
executable that speaks the same event stream as Claude Code, with behaviors you can
select via `CCX_FAKE_BEHAVIOR` or `--fake-behavior=<name>`: `done`,
`ask-then-done`, `blocked`, `no-marker`, `denials`, `crash`, `slow`, `multi-turn`,
`bad-json`, `unknown-event`, `many-files`, and `error-result`.

It also doubles as a pure library: `sessionScript({ behavior, prompts })`
returns the events as objects, without touching disk, so you can feed the digest
one event at a time.

The header of `tests/fake-claude.mjs` pins down the exact shape of every event, as
measured on version 2.1.268. Anything that consumes the stream is written against it;
if the shape changes, it changes there first.

Three design rules apply to all of the code:

1. **Machine output and human output are kept separate.** With `--json`, one line of
   JSON on stdout and nothing else. Progress and diagnostics always go to stderr.
2. **No `process.exit` in the middle of the logic.** Modules throw errors with a
   `code`; only `bin/ccx.mjs` terminates the process.
3. **Every documented flag is implemented, and every implemented flag is
   documented.** A flag that's declared but never read is worse than a missing one:
   the caller trusts it, and it does nothing.

---

## Platforms

**Windows is the first validated target**, with paths abstracted from day one —
no literal backslashes in the code, everything goes through `path.join`. **Linux and
macOS come next as a planned phase, not as an untested promise.**

This is a statement of where things stand, not a design limitation: the code has no
known platform dependency, but only what has actually been run is verified, and this
README doesn't claim anything that hasn't been measured.

---

## Contributing

Contributions are welcome. Before opening a PR:

1. `npm test` passes.
2. Every new flag is documented here **and** in the help text in `bin/ccx.mjs` —
   rule 3 above applies to PRs too.
3. A new environment fact only goes into the verified facts table with its method of
   verification alongside it. No copied documentation.
4. Issues and PRs are welcome in English or Portuguese. The commit history is in
   Portuguese; identifiers and code follow the repository's conventions.

Found a mismatch between what this README claims and what the code does?
That's a bug, and reporting it is just as useful as fixing it.

---

## License

[MIT](LICENSE) © PPiai
