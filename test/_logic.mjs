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
let toolNames = []
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

const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * Split a shell command into sequential segments. Only `;` and newlines break
 * a segment, because `&&` and `||` already consume the exit status they follow.
 *
 * Heredoc bodies are skipped whole. Measured: splitting them turned every line
 * of an inline Python script into a "command", which is how a `$?` read came to
 * look two commands away from its gate.
 */
function segments(command) {
  const out = []
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
function commandOf(segment) {
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

const unquote = (s) => s.replace(/'[^']*'|"[^"]*"/g, ' ')
const baseName = (t) => t.slice(t.lastIndexOf('/') + 1)

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
function isGateCommand(simple) {
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
function hasGate(part) {
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
function sweepingAdd(command) {
  return segments(command).some(seg =>
    unquote(seg)
      .split(/&&|\|\||[|&(){}`]|\$\(/)
      .some(c => {
        const s = commandOf(c).trim()
        return /^git\s/.test(s) && /\sadd\s+(?:.*\s)?(?:-A|--all|\.)(?:\s|$)/.test(s)
      }),
  )
}

function staleStatusRead(command) {
  const segs = segments(command)
  const reader = segs.findIndex(s => /\$\?/.test(s))
  if (reader < 1) return 0
  let gate = -1
  for (let i = 0; i < reader; i++) if (hasGate(segs[i] ?? '')) gate = i
  return gate === -1 ? 0 : reader - gate - 1
}

/** G1b: a gate piped into a reader, with no pipefail to carry the failure out. */
function needsPipefail(command) {
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
function claimText(answer) {
  return answer
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]{0,80}"/g, ' ')
    .replace(/\u201c[^\u201d\n]{0,80}\u201d/g, ' ')
}

function distinctiveNumbers(text) {
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
  const out = []
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

function isSourced(tok, hay) {
  if (hay.includes(tok)) return true
  const bare = tok.replace(/[,%]/g, '')
  if (hay.includes(bare)) return true
  const n = Number(bare)
  return Number.isFinite(n) && hay.includes(n.toLocaleString('en-US'))
}


export {GATE, SWALLOW, SEARCH, ABSENCE, GREEN, ESCAPE, segments, staleStatusRead, needsPipefail, distinctiveNumbers, isSourced, commandOf, hasGate, isGateCommand, GATE_WORD, claimText, sweepingAdd}
