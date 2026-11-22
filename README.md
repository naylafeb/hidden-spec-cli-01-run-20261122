# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naylafeb/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/naylafeb/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — referral code `nxwnbx2d`.

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads them all to one specification
(`SPEC.md`): a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the
lines each edit names at the first of three matching tiers (exact, trailing
whitespace, then indentation too), and writes every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file; when absent or `-`, the patch is read
  from standard input.
- `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`,
  `json`); `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints what changed (`A`/`D`/`M`/`R` lines, then `ok: <n> files`).
Exit 1 lists every edit that failed and ends with `failed: <k> of <n> edits`;
no file is written. Exit 2 is a usage, missing-patch, format or parse error
with exactly one line. See `SPEC.md` for the whole contract.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks
  from the env and runs `main.ts` on each one.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification.
- `LICENSE`: MIT.
