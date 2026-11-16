# measure-first

*By Martin Cohen, Australia. Free to use (MIT licence).*

## What it does

measure-first makes sure Claude has actually run a check before it tells you the
result.

It watches for five things:

1. **A test result that gets lost.** A command like `make test | tail` can report
   success while the tests are failing. The mod stops the command and gives
   Claude the corrected one.
2. **`git add -A`.** This stages files nobody has looked at. The mod stops it and
   asks for the files by name.
3. **"Nothing uses this"** when Claude never searched.
4. **A number in the answer** that never appeared in any command's output.
5. **"All tests pass"** when no tests ran in that reply.

For 1 and 2 it stops the command. For 3, 4 and 5 it leaves you a short note and
never interrupts the work.

## Why

Claude sometimes writes the conclusion before doing the check. The answer sounds
finished, so nobody checks it again. Those are the mistakes that cost the most
time, because they are found late.

## The benefit

- When Claude says "tests pass" or "nothing uses this", there is a real run or a
  real search behind it.
- A wrong result is caught when it is said, not days later.
- It stays quiet. On 175 real answers it flagged about 1 in 10 for an untraced
  number, and 1 in 25 for each of the other two notes. In a test, a made-up
  number was added to all 175 answers and it caught every one.

## Limits

- It only sees command output and what you type. A real number from a pasted
  document can still be flagged.
- A flag means "check this". It is not proof of a mistake.
- It does not read or judge your code.

## What it runs, reads and stores

- **Runs:** one hooks module, `hooks/register.ts`, inside Claude Code. It starts no
  processes, opens no files and makes no network requests. Nothing leaves your
  machine.
- **Reads:** the text of each Bash command before it runs, the output of tool
  calls, your prompts, and Claude's final answer. It holds these in memory for the
  session (at most the last 400,000 characters of tool output and 200,000 of
  prompts) so it can trace a number back to where it came from.
- **Stores:** a list of at most 400 findings in the session's plugin state. Each
  finding is a rule id, a short excerpt of up to 160 characters, a turn id and a
  time. Nothing is written anywhere else.
- **Hooks:** it listens to tool calls and to the start and end of each turn, and
  it adds one command, `/measure-first`, which prints the findings so far.
- **Changes:** it can refuse a Bash command (guards 1 and 2). It never edits a
  command, a file or a permission setting.

The `test/` and `evals/` folders are for development. Nothing in them runs when the
mod is installed.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install measure-first --marketplace MC-Hub111/measure-first
```

Answer `y` to add the marketplace, then choose a scope. From a shell instead:

```bash
claude plugin install measure-first --marketplace MC-Hub111/measure-first
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace
with `MC-Hub111/measure-first`, then Add plugin.

Written and tested on Claude Code 2.1.325.

---

## Technical detail

Everything below is the engineering record: how each guard is defined, how it
was measured, and what was found and fixed along the way.

Five guards against one failure: **the sentence gets written before the check is run,
and then defended.**

Every rule below is a defect that actually happened in a real repository, not a rule
somebody thought sounded prudent. Each is mechanical, so it fires whether or not anyone
is paying attention — which is the point, because the failure mode is inattention.

| id | fires on | the defect it came from |
|----|----------|--------------------------|
| G1 | a gate piped into `tee`/`tail`/`head`/`wc`… with no `pipefail`, or `$?` read after an intervening command | `make check \| tail` returned 0 while the suite was failing; a red `make validate-docs` was relayed as passing because `; echo $?` read the wrong command's status |
| G2 | `git add -A`, `git add .`, `git add --all` | a locked pre-registration was overwritten by a sweeping `git add` in a tree with concurrent sessions |
| G3 | an absence claim ("not used anywhere", "no callers") with no search run that turn | "word X is not used anywhere" was false in 6 of ~14 files it was claimed about |
| G4 | numbers in the answer that appear in no tool result and no prompt anywhere in the session | most published figures in one audit traced to nothing on disk |
| G5 | "tests pass" / "the gate is green" with no test or gate run that turn | a failing gate reported as passing |

G1 and G2 deny, with the corrected command in the refusal. G3, G4 and G5 are advisory:
they write a dim transcript line and a toast, and never fail a turn.

**Why G1 denies instead of rewriting.** It first prepended `set -o pipefail` to the
command. That works, but a hook that mutates Bash input makes auto mode's classifier
give no verdict — *"a hook changed this call's input after auto mode reviewed it"* —
so every rewritten command cost a round trip anyway. Denying costs the same round trip,
keeps the classifier reviewing what will actually run, and still stops the bad run
before it spends sixteen minutes reporting the wrong status.

Append `# measure-first: allow` to a command to bypass G1 or G2. A guard with no escape
hatch gets switched off wholesale, which protects nothing.

## Current measured state

Replayed over one real session of 175 answers with the shipped functions
(`test/g4_validity.mjs`, `test/g35_validity.mjs`). The sections below this one
are the history of how each figure got here, and quote the corpus size at the
time (165 to 167 answers); these are the figures for the code as it stands.

| guard | answers flagged | what the flags are |
|---|---|---|
| G4 | 18 of 175 (10.3%) | a planted fabricated number was caught in 175 of 175 answers; about a third of the real flags are figures from pasted or memory content the hook cannot see |
| G3 | 7 of 175 (4.0%) | every one is an absence claim in a turn with no search, one of them with no tool calls at all |
| G5 | 7 of 175 (4.0%) | 1 claimed passing tests with no run anywhere; 6 quoted the log of an earlier or background run rather than a run in that turn |

G5 is the weakest of the five. Six of its seven flags are "you read a log, you did
not run it this turn", which is weaker evidence than a run but not a wrong claim.

Two further fixes since the sections below were written, both found by replay:

- **A gate must be run, not named.** G1 scanned for a gate's name anywhere in a
  command. That produced four false positives in a row: a `VAR=/path/to/tsc`
  assignment, a `make` inside a heredoc body, `pgrep -fl "pytest" | head`, and
  then `grep -rc pytest . | head`, `which make | cat`, `git log -- make | head`
  and `echo go | cat`. Each earlier fix removed one way of naming a gate. The
  matcher now asks whether a gate is in command position: the first word, or
  what a wrapper (`sudo`, `time`), an interpreter (`python -m`, `node`) or a
  package runner is handed. G5's "did a gate run" probe uses the same test.
  Known limit: a custom runner such as `node test/run.mjs` is not recognised.
- **A quoted phrase is not a claim.** Three of G5's ten flags were the phrase
  inside quotation marks or a code span while describing a guard. Code spans and
  short quotations are removed before G3 and G5 read the answer.

## With/without evals

`evals/` holds four cases in the layout `claude plugin eval` reads; each runs
with the mod and without it. G3, G4 and G5 only write a note for the person at
the keyboard and feed nothing back to the model, so they cannot change an eval
outcome by construction. The cases therefore cover G1, G2 and "stays out of the
way":

| case | what it tests |
|---|---|
| `masked-failure-noisy-teardown` | one test fails, the last 5 lines of output are teardown noise, and `pytest \| tail -5` hands back status 0 |
| `passing-suite-noisy-teardown` | the same suite passing: the guard must not change the answer |
| `commit-only-the-fix` | a commit in a tree holding someone else's untracked files |
| `gate-name-as-search-term` | counting mentions of `pytest` is not running pytest: nothing should be refused |

```bash
claude plugin eval . --scaffold --allow-tools Bash Write Edit
```

## G4 validity, measured

Replayed over a real 165-answer session transcript (`test/g4_validity.mjs`), using the
shipped functions and the haystack the hook actually keeps.

| | per-turn haystack (as first built) | session-wide haystack (shipped) |
|---|---|---|
| answers flagged | **55.2%** (91/165) | **10.9%** (18/165) |
| numbers flagged | 352 | 22 |

**The first design was wrong, and the measurement is what showed it.** 95.7% of the
original 352 flags were numbers that *did* appear in tool output — one or more turns
earlier. A figure measured three turns ago and quoted now is not a claim written before
its check, so it is not G4's business. The haystack is now the whole session.

**Recall: 165/165.** A fabricated number planted in every real answer was caught every
time, so cutting the flag rate five-fold cost no detection.

**What the 22 survivors are.** 7 of 20 sampled are sourced in *attachment* content —
memory, CLAUDE.md, pasted documents — which the hook cannot see at all; it receives tool
results and prompt text only. That is a permanent blind spot, not a bug. The rest are
derived arithmetic (`10,626` from 23x22x21, `0.8790` from a stated sum) and a handful
genuinely worth a second look.

**Known parser limit:** a brace set like `{63,126,252}` reads as one comma-grouped
number. One occurrence in 165 answers.

## G3 / G5 validity, measured

Same replay, same transcript (167 answers), `test/g35_validity.mjs`. G3 and G5
cannot be measured by planting — the rule *is* "phrase present and no search /
gate ran", so a planted phrase is caught by construction. What was measured
instead: the fire rate with every hit printed for adjudication, the phrases a
wider net catches that the shipped regex misses, and whether the turn's tool
record can even see the search or the gate.

**It could not.** `toolNames` keeps the first 40 characters of each command, and
`cd /home/dev/projects/storefront && make validate` puts the gate word past
character 40:

| | turns where it ran | invisible after truncation |
|---|---|---|
| a gate | 88 | **74** |
| a search | 108 | **80** |

So the shipped G3 fired on 5 answers of which **5 of 5 were false**, and G5 on 14
of which **9 of 14 were false** — the guard was reporting "you never ran it"
about commands it simply could not read. Probing `GATE`/`SEARCH` against the
whole command at `tool.call` time instead:

| | before (40-char) | after (full command) |
|---|---|---|
| G3 fires | 5 (all false) | **7 (4.2%)** |
| G5 fires | 14 (9 false) | **5 (3.0%)** |

Stripping quotes and paths before the probe was measured too and is worse: it
loses `.venv/bin/pytest`.

Phrase recall, against a deliberately over-wide net with every extra hit
adjudicated by hand: G5 missed 5 real claims (`all green`, `all passing`,
`pass cleanly`, `all six generators clean`) — now **15/15**. G3 missed
`no producer anywhere`, `nothing live imports`, bare `doesn't exist`,
`zero such rows`; those are now covered, and the remaining wide-net hits are the
net's own noise (`not a judgement call`, `no further work`).

Adjudication of the survivors: all 7 G3 fires are an absence claim in a turn
with no search — one of them with **no tool calls at all**. Of the 5 G5 fires, 1
claimed passing tests with no run anywhere; the other 4 quoted a background
sweep's log instead of a run in that turn. That last group is the honest cost of
G3/G5 being deliberately **per-turn** while G4 is session-wide: a carried-forward
result re-fires. It is kept per-turn because an absence claim is exactly the
class that has gone wrong here before — a self-audit found "X is not used
anywhere" false in 6 of ~14 files.

## A per-turn haystack shipped while a session-wide one was measured

Worth recording, because it is the mod's own failure class. G4's validity numbers
(55.2% → 10.9%) were produced by a replay harness that kept the haystack for the
whole session. The module did not: `turn.start` reset `promptText` and `toolText`
every turn. Every number reported for G4 therefore described the harness, not the
shipped guard, until the module was changed to match.

`test/extract.py` pulls only the pure functions out of `hooks/register.ts`, so
nothing in the unit suite could see the lifecycle. There are now assertions that
read the shipped source directly for both this and the truncation defect; they go
red on the exact code that shipped (13 of 66 cases fail against it).

## Two false positives G1 produced in use

Both found by the live guard firing on its author, both now test cases:

- `TSC=/…/typescript/bin/tsc` — a *variable assignment* whose value ends in a gate name
  was counted as a gate invocation. The gate is now looked for in command position,
  after `VAR=value` prefixes are stripped (`commandOf`).
- heredoc bodies were split into "commands", so a `make` inside an inline Python script
  counted, and put a correct `$?` read two commands from its gate. `segments()` now skips
  a heredoc body whole.

## False positives, stated up front

G4 fires on arithmetic you did yourself and on anything quoted from memory or a pasted
document. Measured rate: 10.9% of answers. It no longer fires on figures carried from an
earlier turn — that was the bug the measurement found.

G5 fires on a statement of intent ("I need to check whether tests pass") as readily as on
a claim. Also deliberate, and also cheap to ignore.

## `/measure-first`

Prints the session's ledger: a tally by rule and the last 15 findings. The findings are
appended, never rewritten, and survive a reload.

## Testing it

```bash
python3 test/extract.py && node test/guards.test.mjs
```

`extract.py` pulls the guards' source out of `hooks/register.ts` so the test exercises the
**shipped text**, not a copy of it. 105 cases: each rule's real defect as a positive, and
the near-misses that must not fire as negatives (`git add a.txt`, "there are no obvious
problems", "the function passes a buffer", a bare `echo $?`).

A separate whole-module syntax check (`as const` and the type annotations stripped, then
parsed) covers the `register` body the extracted span does not reach; it is itself
mutation-tested with a planted unbalanced paren.

Mutation-tested 2026-11-16: neutering `needsPipefail`, flattening `staleStatusRead` to 0,
widening `ABSENCE` to `/\bno \b/`, and removing the ISO-date strip each turn the suite red.
A suite that cannot go red is not evidence.

## Build note

Written against the Claude Code **2.1.325** plugin engine (`hooks.json` → `{ "modules": [...] }`,
`plugin.json` → `"types"`). `claude plugin validate` from an older CLI (2.1.138, for
example) reads the classic plugin schema and rejects both keys. That is a stale
validator, not a broken manifest.
