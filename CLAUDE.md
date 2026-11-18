# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Git remote and PRs

The remote is `origin` on GitHub. It is created by the owner (bead `[human] Create GitHub remote`). Until it exists, nothing starts. Bead work goes through a pull request on a branch named after the bead (`svl-<id>`). Do not push bead work straight to `main`. Commits that change only bead state (`.beads/`) may go straight to `main`.

## Multi-agent workflow

One coordinator session runs several implementer and reviewer subagents. The coordinator keeps the overall picture, and it is the only one that merges and changes bead state.

**Roles**

- **Coordinator** (main session):
  - picks beads with `bd ready`, claims them and starts implementers;
  - starts a reviewer for each PR;
  - decides on findings, then merges and closes.
  - Do not read whole diffs into the coordinator's context. Use `gh pr diff --stat` and the reviewer's findings. Read the full diff only for high-risk beads (label `risk:high`) or when a change touches `CONTRACTS.md`.
- **Implementer** (Sonnet subagent, own git worktree, one bead):
  - builds the bead as "Working a bead" below describes, and opens the PR;
  - never runs `bd`. Notes, follow-ups and contract changes go in the PR body.
- **Reviewer** (Sonnet subagent, one PR):
  - reviews independently and does not see the implementer's report;
  - never merges or edits the branch.

**Implementer, before opening the PR**

1. Merge `origin/main` into the branch.
2. Regenerate the lockfiles (`pnpm install`, `uv lock`) and resolve conflicts. If the bead touches the recorder or the graph builder, run `pnpm fixtures` and review the diff of `fixtures/`.
3. Run `pnpm test && pnpm typecheck && pnpm lint`. Also run `pnpm build` for web beads, and `pnpm test:pyodide` for recorder beads once it exists.
4. Push the branch and open the PR with `gh pr create`.
5. Include in the PR body:
   - each acceptance point and how it was verified;
   - contract changes or deviations;
   - why any generated fixture changed;
   - anything noticed but not done.
6. UI beads (label `ui`) must check the result in a browser at desktop width, in light and dark, and attach at most four screenshots. Tablets are best-effort (SPEC "Supported browsers"), so a check at 768px is enough there. If no browser is available, say so in the PR. Do not claim the check was done.
   - When no browser extension is connected, use headless Chrome. Install `playwright-core` into a temp dir outside the repo (or use the repo's dev dependency) and launch with `executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`, a `viewport` and `colorScheme`. Then look at the screenshots.

**Reviewer brief.** The coordinator gives the reviewer:
- the PR number and bead id;
- the relevant `CONTRACTS.md` sections;
- known risks for the bead;
- what the beads it blocks expect from it (from `bd show` on those beads).

That last item is how problems that span beads get caught.

**Reviewer steps**

1. Check out the branch and run the tests.
2. Try to break the change. Back a suspected bug with a failing test where practical. For recorder beads, aim at transparency (does instrumented code behave exactly like plain Python?) and at false wires (SPEC goal: a missing wire is acceptable; a false one is not).
3. Post the findings as one PR review comment.
4. Return the same findings to the coordinator. Each finding gives:
   - severity;
   - `file:line`;
   - the failure scenario;
   - whether a test confirms it or it is only likely.

Keep the reviewer brief self-contained, so the reviewer doesn't need to read all of `SPEC.md`.

**Review depth by risk**

- Low (label `risk:low`: placeholders, styling, config, fixture content): the coordinator reads the `--stat` and the PR body. No reviewer.
- Normal: one reviewer.
- High (label `risk:high`: transformer, recorder hooks, value identity, worker and stop/restart, assembler, graph builder): one reviewer, and the coordinator also reads the diff.

**After review** the coordinator chooses one of four actions for each finding:
- send it to the *same* implementer via SendMessage, so it keeps its context;
- fix a trivial issue directly;
- file a follow-up bead;
- dismiss it.

Then the coordinator merges with `gh pr merge --merge`, closes the bead with a reason, and starts agents for any newly ready beads.

**Scheduling.** Start a bead only after its dependencies are merged. Do not build stand-ins for unmerged work. Start new beads as earlier ones merge, rather than in fixed waves. Beads labelled `human` are for the owner. Never start an agent on them.

**Worktrees.**
- Keep an implementer's and a reviewer's worktree until their PR merges. A subagent whose worktree was removed cannot be resumed with SendMessage.
- After a merge, remove the worktrees and delete the local branches.
- Pyodide's npm package and the uv environment are large. Each worktree needs its own `pnpm install` and `uv sync`, and the pnpm store and uv cache are shared, so that is fast. Do not symlink `node_modules` or `.venv` between worktrees.

**Bead state.** Do not silence `bd` output, or a failed `bd close` goes unnoticed.

**Keeping the coordinator lean.**
- Fix environment problems once, before starting agents, and pass known pitfalls in each brief.
- Trim command output (`tail`, `grep`).
- Start a fresh coordinator session every few rounds. Beads holds the state.

## Working a bead

Implementer subagents skip the `bd` steps (2, 7 and the note on blocked beads): the coordinator claims and closes. Blockers and follow-ups go in the PR body or the final report.

1. `bd show <id>` and read all of it: description, design and acceptance. Then read the sections of `SPEC.md` and `CONTRACTS.md` it names.
2. `bd update <id> --claim`.
3. Build only what the bead describes. Its design notes list the files it owns. Avoid editing files owned by other beads. If you must, keep the change minimal and mention it in the PR.
4. `CONTRACTS.md` fixes the names, shapes and file paths shared between beads. Follow it exactly. If it is wrong or incomplete, fix it in the same commit and say so. Do not silently diverge.
5. Before closing: `pnpm test && pnpm typecheck && pnpm lint` must pass, and every acceptance point must be checked. For UI beads, run `pnpm dev` and look at the result in a browser.
6. Commit with the bead id in the message, e.g. `svl-abc.2: value table and fingerprints`. Commit only your own files.
7. `bd close <id> --reason "<what was done, anything the next bead should know>"`. File a new bead for anything you found but did not do.

If a bead cannot be finished (missing input, unclear contract, blocked by something not listed as a dependency), do not guess. Leave a note with `bd update <id> --append-notes "..."` and stop.

## Build & Test

```bash
pnpm install && uv sync
pnpm test          # vitest (all packages) + pytest
pnpm test:py       # pytest only (skips tests marked slow)
pnpm test:slow     # slow tests only: fixture programs in subprocesses, dense-graph layout
pnpm test:pyodide  # recorder tests inside Pyodide on Node
pnpm typecheck
pnpm lint          # eslint, prettier, ruff
pnpm build
pnpm dev           # Vite on :5173
pnpm fixtures      # regenerate fixtures/logs, streams, graphs
pnpm e2e           # Playwright against the built site
pnpm measure       # load/restart/overhead measurements
```

These exist once the scaffold bead closes (CONTRACTS.md section 9).

## Architecture Overview

Read `SPEC.md` (what the product does) and `CONTRACTS.md` (exact interfaces). In short: the student's Python runs in Pyodide in a Web Worker. Before it runs, `python/machines` rewrites the source with AST hooks that record each library call the student wrote as an event, with value tokens, and streams the events to the main thread. The main thread assembles them into an event log (`@machines/log`) and builds a graph model from it. `@machines/render` lays the graph out with ELK and draws it as SVG. The React app (`@machines/web`) holds the editor, the timeline, previews and output.

- `python/machines` — recorder. Plain Python, no browser dependency, tested on CPython and inside Pyodide.
- `packages/log` — event log types, worker messages, assembler, graph builder, timeline state. Pure TS.
- `packages/render` — ELK layout and SVG renderer, framework-free (the Jupyter frontend reuses it in M5).
- `packages/web` — the page, the Pyodide worker and the service worker.

## Conventions & Patterns

- TypeScript strict. No `any` without a comment saying why. Python: type hints throughout, `ruff` clean.
- **Transparency first.** Instrumented code must behave exactly like plain Python: same output, same exceptions, same final values. Any recorder change needs a test showing that the program's behaviour is unchanged.
- **No false wires.** If the recorder can't be sure two uses are the same value, it gives them different tokens.
- The log is deterministic. Never put `id()`, wall-clock times or memory addresses in it.
- Pure logic (transformer, values, assembler, graph builder, timeline state, layout input) lives in plain functions with unit tests, separate from React components and the DOM.
- Tests never touch the network. The Pyodide tests use the npm package's local files.
- Student code and uploaded data never leave the browser. The page makes no requests except to its own origin.
- Every UI feature works on desktop Chrome, Firefox and Safari, in light and dark themes, with a keyboard path, and without relying on colour alone (SPEC "Accessibility").
- Colours come from CSS variables in `@machines/render/theme.css` and the web app's theme.
