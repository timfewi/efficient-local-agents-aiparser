# Development feedback workspace

The workspace measures one configuration change at a time and keeps the measured
champion. Its Analyst uses the configured model to propose a typed edit from
aggregate failures and cost statistics. Code validates the edit, runs the real
benchmark and decides whether to accept it. It tunes the harness, not model weights.
The dashboard and development Analyst are outside the submission agent.

## Start a bounded experiment

Use a committed checkout and the existing `.env` model configuration. Development
cases and the final hold-out must remain separate. These generated rehearsal
cases are synthetic; replace the development set with the day's authorized cases.
The optimizer requires Linux, macOS, WSL or the Lab VM for bounded process-group
cleanup; it refuses native Windows before starting work. The dashboard itself runs
with Bun. Benchmarks repeat twice by default (`--repeat 1..10`).

```sh
uv run --locked hacklab practice --seed 41 --out data/feedback/dev
uv run --locked hacklab practice --seed 104729 --out data/feedback/holdout > /dev/null
uv run --locked python -m hacklab.optimize \
  --config configs/openrouter.toml \
  --dataset data/feedback/dev/cases.jsonl --root data/feedback/dev/docs \
  --iterations 3 --max-usd 0.05 --max-seconds 600
```

The command runs committed source in a disposable detached worktree and removes
it afterwards. Uncommitted work in another agent's checkout is not a candidate.
Credentials use the existing environment or `.env` channel; they are never copied
into the worktree, database or dashboard. The state and tracking database stay in
the original checkout's ignored `.state/` directory.

Another invocation with the same source, development data and fixed settings
reuses the champion configuration, measures a fresh baseline, and gives the
Analyst previous trial outcomes. Previously tested candidates are not measured
again just because the campaign restarted.

The dollar limit is a development spending cutoff based on reported usage and
configured prices. It is not a provider invoice guarantee: one in-flight request
can exceed a soft cutoff, and missing usage means unknown cost. The loop stops
new live attempts when cost becomes unknown, including HTTP retries. Existing
lower team limits still apply. Do not start simultaneous campaigns against one
shared allowance. Costs incurred on other laptops cannot be measured here.
Starting another invocation is a separate operator decision; it does not resolve
unpriced requests retained from an earlier campaign.

The Analyst may change only one of these controls per trial:

| Control | Purpose |
| --- | --- |
| `agent.workflow` | Compare the ordinary loop with the experimental role pipeline. |
| `agent.preload_results` | Trade retrieval calls against initial context size. |
| `agent.inventory` | Test whether schema discovery helps a task set. |
| `agent.preload_documents_under` | Preload short policies and documents. |
| `agent.list_preview` | Reduce repeated list text while retaining result IDs. |
| `limits.max_observation_chars` | Bound repeated tool-result context. |

It cannot change the model, provider, prices, guards, actions, budgets or arbitrary
source. It sees aggregate scores, failed-check counts and previous trial results;
it never sees task bodies, reference answers, private documents or raw model replies.
Code generation and playbook changes remain reviewed work for the team's coding
assistants, followed by a new committed experiment.

A candidate is promoted only when measured accuracy does not decrease, estimated
cost does not increase, at least one improves, and usage is complete. Rejected,
failed and timed-out trials remain visible. This conservative rule does not invent
the organizers' unknown combined score. A development improvement can still be
noise or overfit; the held-out measurement is a separate final check.

## Freeze and evaluate

After choosing a champion, stop tuning and use a separate finalization invocation:

```sh
uv run --locked python -m hacklab.optimize \
  --config configs/openrouter.toml \
  --dataset data/feedback/dev/cases.jsonl --root data/feedback/dev/docs \
  --holdout-dataset data/feedback/holdout/cases.jsonl \
  --holdout-root data/feedback/holdout/docs \
  --finalize --max-usd 0.02 --max-seconds 600
```

Hold-out results never enter the proposal loop. An attempted final evaluation
freezes its experiment even if it fails, and its dataset digest cannot be reused
as a fresh hold-out or as development data under another source revision. Use a genuinely new validation
set when developing another experiment.
The champion is a development configuration, not an automatically deployed or
submitted agent. Review its measurements and adapt the actual starter-kit schema
before choosing the submission.

## Open the dashboard

Requires Bun 1.4.4. The repository's Nix workbench supplies Bun; the dashboard
locks React and TypeScript 7.0.2 in `dashboard/bun.lock`.
The TypeScript command runs through Bun; Node.js and npm are not required.

```sh
cd dashboard
bun install --frozen-lockfile --ignore-scripts
bun run start
```

Open **http://127.0.0.1:3000**. The service listens only on loopback and has no API
that launches tools, changes configurations or starts paid calls. For a different
database or port, set `HACKLAB_DB` to an absolute path and
`HACKLAB_DASHBOARD_PORT` before starting it.

| View | Shows |
| --- | --- |
| Overview | Requests, known and unknown costs, reported tokens, budget, trends and the latest campaign. |
| Runs | Paginated task receipts, scores, role calls and cache usage. |
| Feedback | Proposed edits, measured candidates, acceptance decisions and failures. |
| Knowledge | Source hierarchy and flow maps with repeated blocks grouped, while keeping full text and source positions available. |

Receipt costs include the original usage of cache replays, representing estimated
uncached operation. Campaign spending counts live requests. Daily accuracy can
combine different local suites and is not a competition score. Unknown values
remain unknown, including gaps in graphs, rather than becoming zero.

The Knowledge view reads bounded text files from `.state/optimization` and
`docs/research`. `HACKLAB_STATE_ROOT` and `HACKLAB_DOCS_ROOT` select other explicit
roots. It does not scan the home directory or follow symlinks. Plain text,
Markdown, logs and structured text become nodes and source-order or hierarchy
edges. Repeated messages retain their occurrence counts and timestamps. Different
values and negations remain distinct; this is source-backed grouping, not an
unverified semantic rewrite. Details show the original block with source positions.
Credential redaction and explicit truncation limits are shown when applicable.

## Checks

```sh
bash scripts/check
bash scripts/dashboard-check
```

The dashboard gate installs the locked local dependencies, runs TypeScript 7,
tests real SQLite projections and visual-data contracts, then builds the browser
bundle. `dashboard/bench.ts` separately measures API performance on synthetic
data; those timings do not measure model accuracy or predict API-provider latency.

See [the research and measured results](research/small-model-collaboration.md)
for the source analysis and the limits of the runtime collaboration experiment.
