# Development files

Nothing in this folder is installed with the mod.

## Unit cases

From the top of the repository, run these one after the other:

    python3 dev/test/extract.py
    node dev/test/guards.test.mjs

The first pulls the guards' logic out of `plugin/hooks/register.ts`, so the cases
exercise the shipped text and not a copy of it. The second runs the cases.

## Transcript replays

`dev/test/g4_validity.mjs` and `dev/test/g35_validity.mjs` replay the guards over
a Claude Code session transcript (a `.jsonl` file) given as the first argument,
and print every flag for adjudication. The transcripts used for the published
figures are private and are not in this repository.

## With/without evals

`dev/evals/` holds four cases in the layout the plugin eval command reads. That
command looks for an `evals` folder inside the plugin, so copy the cases in
first and remove the copy afterwards:

    cp -R dev/evals plugin/evals
    claude plugin eval ./plugin --scaffold --allow-tools Bash Write Edit
    rm -r plugin/evals

`DESCRIPTION.md` is the plain-English description on its own.
