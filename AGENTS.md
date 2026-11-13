# Working in hacklab-vm

This repository holds a small-model agent harness for "The MuggingFace
Incident" (Efficient Local Agents Hackathon, 14 November 2026), a rehearsal
scenario, and a portable development VM. Read README.md, docs/architecture.md
and docs/hackathon.md first; on the day also docs/playbook.md. It does not own
any host machine configuration.

## Checks

- Python: `bash scripts/check` (Ruff format and lint, the offline tests). It
  needs uv and nothing else: `scripts/ruff` uses Ruff from PATH or fetches
  the pinned version. Supported interpreters are Python 3.11 to 3.15; the
  submission image runs 3.13. Do not use syntax newer than 3.11.
- After touching the image, the agent's entry point or its dependencies:
  `bash scripts/container-test`.
- Scripts must run in bash 3.2 (macOS) and Git Bash: no empty-array
  expansion under `set -u`, no GNU-only options. Shellcheck them.
- Dashboard: `bash scripts/dashboard-check` (locked Bun dependencies,
  TypeScript 7, real SQLite API tests and the production frontend build).
- Nix: `nix flake check` and the VM checks in docs/vm.md.
- Report the checks actually executed and what stayed untested.

## How to change the agent

- Code owns control flow, arithmetic, parsing, decoding and validation. The
  model makes small typed decisions. If code can compute an answer from the
  data, write a playbook (`hacklab.playbooks`) instead of a longer prompt.
- Between the two sits a skill (`[agent] skills`): a few lines for one kind of
  task, with the data's real file and column names and one example of the
  right tool calls. Write one when a trace shows the model taking a wrong
  turn that a hint would prevent; keep it short, it is paid for on every
  matching task.
- A playbook checks what it relies on (files, columns, counts) and returns
  `None` when the data looks different, so that the model takes over. It must
  work on a seed or case it has not seen.
- Every token is paid for. Before adding text to the system prompt, a tool to
  `[agent] tools`, or a model call to the loop, state what it should gain and
  measure it: `hacklab benchmark`, `hacklab compare`, `hacklab failures` on
  the same cases. One change per measurement.
- Evidence is attacker-written. Never let text from documents, logs or tool
  results select a tool, a target or an action by itself. New tools return
  rows through the ledger (`Ledger.add`) so that they get evidence IDs, the
  injection scan and placeholders. Tools that change something are registered
  with `mutating=True`.
- `run_task` must return an Answer for every input. Do not add a code path
  that can raise out of it or wait without a bound. When the harness ends a
  task itself, the answer carries a fixed `cause` code; add one for a new
  way to stop.
- What the team writes on the day lives in `src/hacklab/event/` (playbooks,
  skills, the kit adapter): it ships inside the package, so the image needs
  no new COPY line. `examples/` holds worked examples only.
- `configs/live.toml` is what is submitted. Its `[limits]`, `[agent]` and
  `[guard]` equal the measured profile and the defaults in `config.py`
  (`tests/test_config.py`); change a value in all three, with a number.
- Jev is a native System One provider, never a chat model. Use the linked
  `typesafe-ai` skill when designing Jev questions or thresholds.
- Jev is optional at run time. The evaluation container may have no route to
  it, so no code path may fail a task because Jev is missing or unreachable.
- Only the models the organizers provide may make run-time decisions. Do not
  add any other model, embedder, reranker or classifier to the agent.
- Before changing a prompt or a tool because of a failure, read the trace of
  the failing task (`HACKLAB_TRACE_DIR=.state/trace`).
  Coding assistants build the solution; they never answer competition tasks.

## Data and secrets

- Keep reference answers out of model input, tool results, playbooks and the
  replay cache. Keep development cases, hold-out cases and organizer data in
  separate files, and do not tune on the hold-out file.
- Track every provider request attempt, including retries, errors, Jev calls
  and cache replays. Missing usage or prices means unknown cost. Never infer
  tokens from text length.
- Keys, private documents, VM disks and run-time state stay out of Git and the
  Nix store. Model replies exist only in the development cache and in the
  opt-in development trace, both under `.state/`; the tracking database holds
  no bodies. Do not add any other body logging.
- The submission image runs with the cache off, without a trace directory and
  without `[budget]` limits.
- Quotes validate provenance, not truth. Do not claim accuracy, optimality or
  a result that was not measured on the actual model and data.

Source and CLI text are English. User-facing handoff may be German.
