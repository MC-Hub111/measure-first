import {readFileSync} from 'node:fs'
import {ABSENCE,GREEN,ESCAPE,staleStatusRead,needsPipefail,distinctiveNumbers,isSourced,commandOf,hasGate,claimText,sweepingAdd}
  from './_logic.mjs'

let pass=0, fail=0
const t=(name,got,want)=>{ const ok=JSON.stringify(got)===JSON.stringify(want)
  ok?pass++:fail++; if(!ok) console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
// The shipped function, not a retyped copy of its pattern.
const gitSweep = c => sweepingAdd(c) && !ESCAPE.test(c)

console.log('G1 pipefail — real defects as positives')
t('make check | tail  (hid a real failure)', needsPipefail('make check | tail'), true)
t('make validate-full | tee .log',            needsPipefail('make validate-full | tee .validate_full.log'), true)
t('pytest -q | head',                         needsPipefail('pytest -q | head -40'), true)
console.log('G1 pipefail — negatives (must NOT fire)')
t('already has pipefail',                     needsPipefail('set -o pipefail; make check | tail'), false)
t('no gate in the pipeline',                  needsPipefail('cat big.log | tail -20'), false)
t('no pipe at all',                           needsPipefail('make validate'), false)
t('pipes to a filter, not a reader',          needsPipefail('make -n validate | xargs -n1 echo'), false)

console.log('\nG1 stale $? — the exact defect from this session')
t('make > log; echo; tail; echo $?',  staleStatusRead('make validate-docs > log 2>&1; echo; tail -5 log; echo $?'), 2)
console.log('G1 stale $? — negatives')
t('the fix I actually used',          staleStatusRead('make validate-docs > log 2>&1; MAKE_EXIT=$?'), 0)
t('bare echo $?',                     staleStatusRead('echo $?'), 0)
t('no gate before the read',          staleStatusRead('ls; echo $?'), 0)
// Both of these were FALSE POSITIVES the live guard produced on 2026-11-16.
t('assignment holding a gate on its PATH is not a gate',
  staleStatusRead('TSC=/x/node_modules/typescript/bin/tsc\nSP=/tmp/s\nnode $TSC -p . --noEmit > $SP/o 2>&1; echo "EXIT=$?"'), 0)
t('a gate word inside a heredoc body is not a command',
  staleStatusRead("python3 - <<'PY'\nmake believe\nPY\nls -la > log 2>&1; RC=$?"), 0)
t('heredoc skip does not hide a real defect',
  staleStatusRead("python3 - <<'PY'\nprint(1)\nPY\nmake validate > log 2>&1; echo; tail -2 log; echo $?"), 2)
t('commandOf strips assignments',    commandOf('TSC=/a/bin/tsc SP=/b node x'), 'node x')
t('commandOf keeps a bare command',  commandOf('make validate'), 'make validate')
t('assignment-only segment',         commandOf('TSC=/a/bin/tsc'), '')

console.log('\nG2 git add — the prereg-overwrite defect')
t('git add -A',        gitSweep('git add -A'), true)
t('git add .',         gitSweep('git add .'), true)
t('git add --all',     gitSweep('git add --all'), true)
console.log('G2 — negatives')
t('explicit path',     gitSweep('git add tools/make_setup_pdf.py'), false)
t('path starting a.b', gitSweep('git add a.txt'), false)
t('documented escape', gitSweep('git add -A  # measure-first: allow'), false)
t('after cd',                 gitSweep('cd repo && git add .'), true)
t('git -C repo add -A',       gitSweep('git -C repo add -A'), true)
t('NEG: words in a heredoc document (the live FP)',
  gitSweep("cat > NOTES.md <<'EOF'\n2. `git add -A` stages files nobody has looked at.\nEOF\nls"), false)
t('NEG: words in a quoted message', gitSweep('git commit -m "stop using git add -A"'), false)
t('NEG: words echoed',              gitSweep("echo 'never run git add .'"), false)
t('NEG: grep for the words',        gitSweep('grep -rn "git add -A" docs/'), false)
t('G2 hook calls the shipped function', /const sweeping = sweepingAdd\(command\)/.test(readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')), true)

console.log('\nG3 absence — the false_absence_selfaudit class')
t('not used anywhere',   ABSENCE.test('the constant is not used anywhere in the tree'), true)
t('no callers',          ABSENCE.test('it has no callers'), true)
t('nowhere in the repo', ABSENCE.test('that string appears nowhere in the repository'), true)
console.log('G3 — negatives')
t('"no obvious problems"',  ABSENCE.test('there are no obvious problems with this'), false)
t('"no need to"',           ABSENCE.test('no need to re-run the gate'), false)

console.log('\nG5 green claim')
t('all tests pass',      GREEN.test('all tests pass'), true)
t('the gate is green',   GREEN.test('the gate is green'), true)
t('no failures',         GREEN.test('no failures in the sweep'), true)
console.log('G5 — negatives')
t('passes a buffer',     GREEN.test('the function passes a buffer to the writer'), false)
t('a passing mention',   GREEN.test('I mentioned it in passing'), false)

console.log('\nG4 numbers')
t('1963 is distinctive',       distinctiveNumbers('1963 passed, 2 skipped'), ['1963'])
t('a date yields nothing',     distinctiveNumbers('on 2026-11-15 at 06:16'), [])
t('short decimal kept',        distinctiveNumbers('an edge of +3.8pp'), ['3.8'])
t('AUC kept',                  distinctiveNumbers('AUC 0.507'), ['0.507'])
t('comma form traced to bare', isSourced('1,963','... 1963 passed ...'), true)
t('bare traced to comma form', isSourced('1963','... 1,963 passed ...'), true)
t('absent number not sourced', isSourced('4096','... 1963 passed ...'), false)
t('prose year dropped',        distinctiveNumbers('measured in 2026 on the panel'), [])
t('count that looks like a year kept', distinctiveNumbers('1923 passed, 40 deselected'), ['1923'])
t('timestamp yields nothing',  distinctiveNumbers('finished at 06:16:57 today'), [])
t('real sentence',             distinctiveNumbers('1963 passed in 1012.36s on 2026-11-15'), ['1963','1012.36'])

// ---- LIFECYCLE. extract.py pulls only the pure functions, so nothing above
// this line can see how the module keeps its state between turns. A per-turn
// haystack shipped once while the validity replay measured a session-wide one,
// and every number reported was therefore about the harness, not the guard.
// These read the shipped source directly.
const SRC = readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')
const turnStart = SRC.slice(SRC.indexOf("on('turn.start'"))
const turnStartBody = turnStart.slice(0, turnStart.indexOf('\n  })'))

console.log('\nlifecycle — the haystack G4 traces a number to')
t('turn.start accumulates promptText (session-wide haystack)',
  /promptText\s*=\s*\(\s*promptText\s*\+/.test(turnStartBody), true)
t('turn.start does NOT clear toolText',
  /toolText\s*=\s*''/.test(turnStartBody), false)
t('turn.start DOES clear toolNames (G3/G5 are per-turn)',
  /toolNames\s*=\s*\[\]/.test(turnStartBody), true)
t('both haystack writes are capped',
  (SRC.match(/toolText = \(toolText \+ '\\n' \+ ran\.text\)\.slice\(-\d+\)/g) ?? []).length, 2)
t('promptText write is capped',
  /promptText = \(promptText \+ '\\n' \+ \(e\.text \?\? ''\)\)\.slice\(-\d+\)/.test(SRC), true)

console.log('\nG1 — a gate name in quotes is an argument, not a command')
t('pgrep -fl "pytest" | head  (the live FP)', needsPipefail('pgrep -fl "pytest" | head -3'), false)
t("grep -l 'make' . | head",                  needsPipefail("grep -l 'make' . | head"), false)
t('ps aux | grep "jest" | wc -l',             needsPipefail('ps aux | grep "jest" | wc -l'), false)
t('unquoted gate still caught',               needsPipefail('.venv/bin/python -m pytest -q | tee log'), true)
t('quoted name does not start a $? count',    staleStatusRead('pgrep -fl "pytest"; ls; echo $?'), 0)
t('real stale read still counted',            staleStatusRead('make validate > log 2>&1; echo; tail -2 log; echo $?'), 2)

console.log('\nG1 — a gate must be RUN, not merely named (command position)')
for (const c of ['grep -rc pytest . | sort -t: -k2 -nr | head -5', 'ls node_modules/.bin | grep jest | wc -l',
                 'cat Makefile | head -20', 'which make | cat', 'git log --oneline -- make | head', 'echo go | cat'])
  t('NEG named, not run: ' + c, needsPipefail(c), false)
for (const c of ['cd proj && make check | tail -3', 'uv run pytest -q | tail', 'npx jest | tee out.log',
                 'node /x/node_modules/typescript/bin/tsc -p . | head', 'sudo make install | tee log',
                 './gradlew test | tail -20', 'PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest -q | tee log',
                 'make check | grep -v ok | tail -5', 'if true; then make check | tail -3; fi'])
  t('run: ' + c, needsPipefail(c), true)
t('a pipe inside quotes is not a pipe',  needsPipefail('make check && echo "see a | tail of it"'), false)
t('hasGate: python -m pytest',           hasGate('python3 -m pytest -q'), true)
t('hasGate: python some_script.py',      hasGate('python3 tools/make_report.py'), false)
t('hasGate: grep for a gate name',       hasGate('grep -n make Makefile'), false)
t('stale $? after a named gate is 0',    staleStatusRead('which pytest; ls; echo $?'), 0)

console.log('\nG3/G5 phrase recall — real misses found by the transcript replay')
t('no producer anywhere',        ABSENCE.test('there is no producer anywhere for it'), true)
t('nothing live imports',        ABSENCE.test('nothing live imports that module'), true)
t("doesn't exist (bare)",        ABSENCE.test("that target doesn't exist"), true)
t('zero such rows',              ABSENCE.test('zero such rows across the tree'), true)
t('NEG: not a judgement call',   ABSENCE.test('this is not a judgement call'), false)
t('NEG: no further work',        ABSENCE.test('no further work is needed'), false)
t('all green',                   GREEN.test('the suites are all green now'), true)
t('all passing',                 GREEN.test('all passing after the fix'), true)
t('pass cleanly (bare)',         GREEN.test('they pass cleanly'), true)
t('all six generators clean',    GREEN.test('all six generators clean'), true)
t('NEG: gate is red',            GREEN.test('the gate is red'), false)
t('NEG: two checks failed',      GREEN.test('two checks failed'), false)

console.log('\nG3/G5 — a quoted phrase is not a claim')
t('code span is not a claim',        GREEN.test(claimText('G5 was missing `all green` and `all passing`')), false)
t('quotation is not a claim',        GREEN.test(claimText('the reply says "all tests pass" but nothing ran')), false)
t('quoted absence is not a claim',   ABSENCE.test(claimText('it flags "nothing calls this" with no search')), false)
t('claim next to a code span stays', GREEN.test(claimText('`make validate` is green')), true)
t('plain claim stays',               GREEN.test(claimText('All tests pass.')), true)
t('G3 and G5 read claimText in the shipped hook',
  /ABSENCE\.test\(claims\)/.test(SRC) && /GREEN\.test\(claims\)/.test(SRC) && /const claims = claimText\(answer\)/.test(SRC), true)

console.log('\nlifecycle — G3/G5 must probe the WHOLE command, not toolNames')
t('gate probe reads the whole `command`, per segment', /if \(segments\(command\)\.some\(seg => hasGate\(seg\)\)\) gateTurn = true/.test(SRC), true)
t('SEARCH is tested against `command`', /if \(SEARCH\.test\(command\)\) searchedTurn = true/.test(SRC), true)
t('turn.complete reads the booleans, not a toolNames scan',
  /const searched = searchedTurn\s*\n\s*const ran = gateTurn/.test(SRC), true)
t('no GATE/SEARCH scan over joined toolNames survives',
  /GATE\.test\(tools\)|SEARCH\.test\(tools\)/.test(SRC), false)
t('both per-turn flags reset in turn.start',
  /searchedTurn = false\s*\n\s*gateTurn = false/.test(turnStartBody), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail?1:0)
