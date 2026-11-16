import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Finding } from '../types'

/**
 * measure-first — five guards, each one a defect that actually happened.
 *
 * The failure this exists for: the sentence gets written before the check is
 * run, and then defended. Every rule below is mechanical, so it fires whether
 * or not anyone is paying attention.
 */

const findings = atom({ plugin: 'measure-first', key: 'findings' } as const, [], {
  shape: 'findings-1',
})

/** Commands whose exit code is the thing being reported. */
const GATE =
  /\b(make|pytest|py\.test|tox|nox|npm|yarn|pnpm|cargo|go|mvn|gradle|gradlew|ctest|jest|vitest|rspec|phpunit|dotnet|ruff|mypy|eslint|tsc)\b/

/** Readers that discard the exit status of everything upstream of them. */
const SWALLOW = /\|\s*(tee|tail|head|less|more|wc|sort|uniq|column|cat)\b/

/** Searches. An absence claim needs one of these to have run. */
const SEARCH = /\b(grep|rg|ripgrep|ag|ack|find|fd|locate|git\s+grep)\b/

const ABSENCE =
  /\b(not (?:used|called|referenced|imported|defined|mentioned|present) anywhere|no (?:references?|callers?|usages?|occurrences?|matches)\b|nowhere in the (?:codebase|repo|repository|tree|project)|does(?:n't| not) (?:exist|appear)(?: anywhere)?|nothing (?:\w+ ){0,2}(?:matches|references|calls|called|imports|uses)|zero (?:callers?|references?|usages?)|zero such \w+|no \w+(?: \w+)? anywhere|no \w+ (?:exists|is computed))/i

const GREEN =
  /\b(all (?:the )?(?:tests?|checks?|gates?|suites?) pass|tests? (?:all )?pass(?:ed|ing)?\b|(?:is|are|now|came back) green\b|all (?:\w+ ){0,3}(?:passing|green|clean)\b|passe?s? cleanly|passed cleanly|no failures|zero failures|fully verified|everything passes)/i

const ESCAPE = /#\s*measure-first:\s*allow/

/**
 * Session scratch. `promptText`/`toolText` accumulate across turns — the
 * haystack G4 traces a number to is everything this session has seen, not this
 * turn alone. `toolNames` is the per-turn exception, for G3 and G5. A reload
 * starts all of them empty.
 */
let turnId = ''
let promptText = ''
let toolText = ''
let toolNames: string[] = []
/**
 * Did a search / a gate run THIS turn? Booleans, not a scan of `toolNames`.
 * MEASURED on a real 167-answer transcript: `toolNames` keeps only the first 40
 * chars of each command, and `cd /home/dev/projects/storefront && make ...`
 * puts the gate word past char 40. 74 of 88 gate turns and 80 of 108 search
 * turns were invisible that way, so G3 fired on 5 answers of which 5 were
 * false, and G5 on 14 of which 9 were false. Tested against the whole command,
 * G3 falls to 0 fires and G5 to 5. Stripping quotes and paths first was also
 * measured and is worse: it loses `.venv/bin/pytest`.
 */
let searchedTurn = false
let gateTurn = false

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * Split a shell command into sequential segments. Only `;` and newlines break
 * a segment, because `&&` and `||` already consume the exit status they follow.
 *
 * Heredoc bodies are skipped whole. Measured: splitting them turned every line
 * of an inline Python script into a "command", which is how a `$?` read came to
 * look two commands away from its gate.
 */
function segments(command: string): string[] {
  const out: string[] = []
  const lines = command.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    for (const part of line.split(';')) if (part.trim()) out.push(part.trim())
    const here = line.match(/<<-?\s*'?"?([A-Za-z_]\w*)'?"?/)
    i++
    if (here) {
      const term = here[1]
      while (i < lines.length && (lines[i] ?? '').trim() !== term) i++
      i++
    }
  }
  return out
}

/**
 * A segment with its leading `VAR=value` assignments stripped, so the gate is
 * looked for in command position. Returns '' for a segment that is only
 * assignments. Measured: `TSC=/usr/local/lib/node_modules/.../bin/tsc` matched
 * the gate pattern on its PATH and was counted as a gate invocation.
 */
function commandOf(segment: string): string {
  let s = segment.trim()
  for (;;) {
    const m = s.match(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*/)
    // Quoted text is an ARGUMENT, not a command. Third false positive this
    // guard produced on its own author: `pgrep -fl "pytest" | head -3` was read
    // as piping pytest into head. Known cost of stripping: a gate genuinely
    // invoked inside quotes, as in `bash -c "make test" | tail`, is missed.
    // That is rarer than naming a tool as an argument to grep/pgrep/ps.
    if (!m) return s.replace(/'[^']*'|"[^"]*"/g, ' ')
    s = s.slice(m[0].length)
  }
}

/**
 * G1a: `$?` read after an intervening command, so it reports the wrong status.
 * Returns the gap in commands, or 0 when the read is correctly placed.
 */
/** A gate named as a whole WORD. Derived from GATE so the two cannot drift. */
const GATE_WORD = new RegExp('^' + GATE.source.replace(/\\b/g, '') + '$')
/** Prefixes that run the command that follows them. */
const WRAPPER = /^(?:sudo|time|env|nice|nohup|command|exec|caffeinate|then|do|else)$/
/** Interpreters: the gate is the script, or the `-m` module, they are handed. */
const INTERP = /^(?:node|bash|sh|zsh|python[\d.]*|ruby|deno|bun)$/
/** Runners: `uv run pytest`, `npx jest`, `bundle exec rspec`. */
const RUNNER = /^(?:uv|uvx|poetry|pipenv|pdm|hatch|rye|npx|bunx|bundle|pipx)$/

const unquote = (s: string) => s.replace(/'[^']*'|"[^"]*"/g, ' ')
const baseName = (t: string) => t.slice(t.lastIndexOf('/') + 1)

/**
 * Is this simple command a gate being RUN? The gate must be in command
 * position: the first word, or what a wrapper / interpreter / runner is handed.
 *
 * This replaces a scan for the gate's name anywhere in the text, which produced
 * four false positives in a row, every one a gate NAMED rather than run:
 * a `VAR=/path/to/tsc` assignment, a `make` inside a heredoc body, a quoted
 * `pgrep -fl "pytest"`, and then, measured before any of it shipped,
 * `grep -rc pytest .`, `which make`, `git log -- make` and `echo go`. Each
 * earlier fix removed one way of naming a gate. This asks the real question.
 */
function isGateCommand(simple: string): boolean {
  const toks = commandOf(simple).trim().split(/\s+/).filter(Boolean)
  let i = 0
  for (let hops = 0; hops < 6 && i < toks.length; hops++) {
    const t = baseName(toks[i] ?? '')
    if (GATE_WORD.test(t)) return true
    if (WRAPPER.test(t)) {
      i++
      while (i < toks.length && /^-|=/.test(toks[i] ?? '')) i++
      continue
    }
    if (INTERP.test(t)) {
      if ((toks[i + 1] ?? '') === '-m') return GATE_WORD.test(toks[i + 2] ?? '')
      i++
      while (i < toks.length && /^-/.test(toks[i] ?? '')) i++
      return GATE_WORD.test(baseName(toks[i] ?? ''))
    }
    if (RUNNER.test(t)) {
      i++
      while (i < toks.length && /^-|^(?:run|exec|x)$/.test(toks[i] ?? '')) i++
      continue
    }
    return false
  }
  return false
}

/** Does any simple command in this stretch of shell run a gate? */
function hasGate(part: string): boolean {
  return unquote(part)
    .split(/&&|\|\||[|&(){}`]|\$\(/)
    .some(c => isGateCommand(c))
}

/**
 * Is a sweeping `git add` being RUN? Same question as `hasGate`, for G2: the
 * old test scanned the whole command text, so writing a document that merely
 * mentions the words inside a heredoc was refused. Found when the guard blocked
 * its author from saving this mod's own description.
 */
function sweepingAdd(command: string): boolean {
  return segments(command).some(seg =>
    unquote(seg)
      .split(/&&|\|\||[|&(){}`]|\$\(/)
      .some(c => {
        const s = commandOf(c).trim()
        return /^git\s/.test(s) && /\sadd\s+(?:.*\s)?(?:-A|--all|\.)(?:\s|$)/.test(s)
      }),
  )
}

function staleStatusRead(command: string): number {
  const segs = segments(command)
  const reader = segs.findIndex(s => /\$\?/.test(s))
  if (reader < 1) return 0
  let gate = -1
  for (let i = 0; i < reader; i++) if (hasGate(segs[i] ?? '')) gate = i
  return gate === -1 ? 0 : reader - gate - 1
}

/** G1b: a gate piped into a reader, with no pipefail to carry the failure out. */
function needsPipefail(command: string): boolean {
  if (/pipefail/.test(command)) return false
  if (!SWALLOW.test(command)) return false
  return segments(command).some(s => {
    // Everything upstream of the reader loses its status, not just the first
    // stage, and a `|` inside quotes is not a pipe.
    const u = unquote(s)
    const at = u.search(SWALLOW)
    return at > 0 && hasGate(u.slice(0, at))
  })
}

/** Numbers worth tracing: three or more digits, or any decimal. Years are not. */
/**
 * The part of an answer that can make a claim: code spans and short quotations
 * removed. Measured on a real transcript: 3 of G5's 10 fires were the phrase
 * being QUOTED while describing a guard (`all green`, "all tests pass"), not
 * asserted. `make validate` is green still reads as a claim, because only the
 * command is inside the code span.
 */
function claimText(answer: string): string {
  return answer
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]{0,80}"/g, ' ')
    .replace(/\u201c[^\u201d\n]{0,80}\u201d/g, ' ')
}

function distinctiveNumbers(text: string): string[] {
  const stripped = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    // Dates and clock times are not measurements. Stripping them beats a blanket
    // 19xx/20xx rule, which also swallowed `1963 passed` — a test count, not a year.
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    // `file.md:235-237` is a location, not a measurement. Measured on a real
    // transcript: line ranges were 3 of the 15 numbers that matched nothing,
    // because `235-237` made `-237` look like a negative number.
    .replace(/:\d+(?:[-:]\d+)*/g, ' ')
  const out: string[] = []
  // No leading sign: provenance does not turn on it, and `-?` matched ranges.
  for (const m of stripped.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) {
    const tok = m[0].replace(/,+$/, '')
    const digits = tok.replace(/[^0-9]/g, '')
    if (digits.length < 3 && !tok.includes('.')) continue
    if (!tok.includes('.') && /^(?:19|20)\d\d$/.test(digits)) {
      // Only a year when prose says so. A bare 4-digit number is a count.
      const before = stripped.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0)
      if (/\b(?:in|since|by|from|until|during|of|\u00a9)\s+$/i.test(before)) continue
    }
    if (!out.includes(tok)) out.push(tok)
  }
  return out
}

function isSourced(tok: string, hay: string): boolean {
  if (hay.includes(tok)) return true
  const bare = tok.replace(/[,%]/g, '')
  if (hay.includes(bare)) return true
  const n = Number(bare)
  return Number.isFinite(n) && hay.includes(n.toLocaleString('en-US'))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'measure-first',
      description: 'Report what measure-first has flagged in this session',
    })
    return next(e)
  })

  // ---- G2: staging everything. A pre-registration was overwritten this way. ----
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const command = String(e.command ?? '')
    const sweeping = sweepingAdd(command)
    if (sweeping && !ESCAPE.test(command)) {
      return {
        deny:
          `${$.plugin.name} G2: \`git add -A\`/\`git add .\` stages files you have not ` +
          `read, including other sessions' work. Stage explicit paths instead. ` +
          `Append \`# measure-first: allow\` to override.`,
      }
    }
    return next(e)
  }).catch(($, e, next) => {
    // Fail open. A guard that blocks work when its own check breaks gets removed.
    $.ui.log(`measure-first: G2 guard failed; allowing the call`)
    return next(e)
  })

  // ---- G1: exit codes that do not mean what they appear to mean ----
  //
  // This DENIES with the corrected command rather than rewriting the call. A hook
  // that mutates Bash input makes auto mode's classifier give no verdict ("a hook
  // changed this call's input after auto mode reviewed it"), so every rewritten
  // command cost a round trip anyway. Denying costs the same round trip, keeps the
  // classifier reviewing what will actually run, and still stops the bad run before
  // it burns sixteen minutes reporting the wrong status.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')

    if (!ESCAPE.test(command)) {
      let refusal: string | undefined
      try {
        if (needsPipefail(command)) {
          refusal =
            `${$.plugin.name} G1: this pipes a gate into a reader, so the exit code ` +
            `you get back is the reader's, not the gate's — a failing suite reports 0. ` +
            `Re-issue as:\n\n    set -o pipefail; ${command}\n\n` +
            `Or append \`# measure-first: allow\` if the status genuinely does not matter.`
        } else {
          const gap = staleStatusRead(command)
          if (gap > 0) {
            refusal =
              `${$.plugin.name} G1: \`$?\` is read ${gap} command(s) after the gate, so it ` +
              `reports that later command's status, not the gate's. Capture it on the ` +
              `line after the gate — \`<gate> > log 2>&1; RC=$?\` — then inspect the log.`
          }
        }
      } catch {
        refusal = undefined // a guard must never stop the command it is guarding
      }

      if (refusal) {
        void update($, findings, list =>
          [...list, { rule: 'G1', detail: clip(refusal!, 120), turnId, at: Date.now() }].slice(-400),
        )
        return { deny: refusal }
      }
    }

    const ran = await next(e)
    try {
      toolNames.push('Bash:' + command.slice(0, 40))
      if (segments(command).some(seg => hasGate(seg))) gateTurn = true
      if (SEARCH.test(command)) searchedTurn = true
      if (typeof ran.text === 'string') toolText = (toolText + '\n' + ran.text).slice(-400000)
    } catch {
      /* ignore */
    }
    return ran
  }).catch(($, e, next) => {
    $.ui.log(`measure-first: G1 guard failed; allowing the call`)
    return next(e)
  })

  // ---- collect every other tool's output, so numbers can be traced to one ----
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (e.tool !== 'Bash') {
        toolNames.push(String(e.tool))
        if (/^(?:Grep|Glob)$/.test(String(e.tool))) searchedTurn = true
        if (typeof ran.text === 'string') toolText = (toolText + '\n' + ran.text).slice(-400000)
      }
    } catch {
      /* ignore */
    }
    return ran
  })

  on('turn.start', ($, e, next) => {
    if (!e.agentId) {
      turnId = e.turnId
      // THE HAYSTACK IS THE WHOLE SESSION, NOT THIS TURN. Measured on a real
      // 166-answer transcript: with a per-turn haystack G4 flagged 55% of the
      // answers, and 95.7% of those flags were numbers that DID appear in tool
      // output one or more turns earlier. A figure measured three turns ago and
      // quoted now is not a claim written before its check. Only `toolNames`
      // resets below: G3 and G5 ask whether a search or a gate ran THIS turn,
      // which is a per-turn question. Capped so a long session cannot grow it
      // without bound.
      promptText = (promptText + '\n' + (e.text ?? '')).slice(-200000)
      toolNames = []
      searchedTurn = false
      gateTurn = false
    }
    return next(e)
  })

  // ---- G3, G4, G5: what the answer claims against what the turn actually did ----
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId || e.isAborted) return done

    const hits: Finding[] = []
    try {
      const answer = e.answer ?? ''
      const searched = searchedTurn
      const ran = gateTurn
      const claims = claimText(answer)

      if (ABSENCE.test(claims) && !searched) {
        const m = claims.match(ABSENCE)
        hits.push({
          rule: 'G3',
          detail: `absence claimed ("${clip(m?.[0] ?? '', 48)}") with no search run this turn`,
          turnId,
          at: Date.now(),
        })
      }

      if (GREEN.test(claims) && !ran) {
        const m = claims.match(GREEN)
        hits.push({
          rule: 'G5',
          detail: `green claimed ("${clip(m?.[0] ?? '', 48)}") with no test or gate run this turn`,
          turnId,
          at: Date.now(),
        })
      }

      const hay = toolText + '\n' + promptText
      const loose = distinctiveNumbers(answer).filter(tok => !isSourced(tok, hay))
      if (loose.length) {
        hits.push({
          rule: 'G4',
          detail: `${loose.length} number(s) in no tool result this turn: ${clip(loose.slice(0, 6).join(', '), 90)}`,
          turnId,
          at: Date.now(),
        })
      }
    } catch {
      /* advisory only: never fail a turn over a guard */
    }

    if (hits.length) {
      for (const h of hits) $.ui.log(`measure-first ${h.rule}: ${h.detail}`)
      $.ui.toast(
        `measure-first: ${hits.map(h => h.rule).join(', ')} — check before this is relied on`,
      )
      await update($, findings, list => [...list, ...hits].slice(-400))
    }

    const all = await read($, findings)
    $.ui.status(all.length ? `measure-first: ${all.length} to verify` : undefined)
    return done
  })

  on('command.run', { command: 'measure-first' }, async $ => {
    const all = await read($, findings)
    if (!all.length) {
      return { text: 'measure-first: nothing flagged in this session.' }
    }
    const byRule = new Map<string, number>()
    for (const f of all) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)
    const tally = [...byRule.entries()].sort().map(([r, n]) => `${r} x${n}`).join('  ')
    const lines = all.slice(-15).map(f => `  ${f.rule}  ${f.detail}`)
    return {
      text:
        `measure-first — ${all.length} flagged (${tally})\n\n` +
        `last ${Math.min(15, all.length)}:\n${lines.join('\n')}\n\n` +
        `These are prompts to verify, not verdicts. G4 fires on arithmetic you did ` +
        `yourself as well as on numbers with no source.`,
    }
  })
}
