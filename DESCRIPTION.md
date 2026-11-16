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
