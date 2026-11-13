# How the agent works

A small model is good at one narrow decision at a time. It is poor at copying
long lists, at arithmetic and at resisting instructions hidden in data. So
code does what code can do, and the model picks one typed step at a time over
evidence that code has prepared.

```text
Task
  -> playbooks   code solves a task type it recognises          0 model calls
  -> briefing    what the documents hold, short ones in full,
                 a matching skill
  -> loop        the model picks ONE tool call, or "final"
                 every row it sees gets an evidence ID and passes the guards
  -> final       answer + evidence IDs + containment actions
                 code turns IDs into quotes and checks every action
  -> Jev         optional second opinion on the finished answer
  -> Answer      always, also after an error
```

## Files

| File | Owns |
| --- | --- |
| `agent.py` | Order of work, the loop, repair, final checks |
| `pipeline.py` | Opt-in Analyst / Responder experiment, shared budgets and guarded handoffs |
| `optimize.py` | Development-only configuration proposals, measurements, promotion and hold-out freeze |
| `dashboard/` | Local Bun / React workspace over body-free receipts and bounded visual source maps |
| `event/` | What the team writes on the day: playbooks, skills, the starter-kit adapter |
| `playbooks.py` | Registry of code-only solvers and the workspace they work in |
| `toolkit.py` | Tool list for the prompt, result rendering, the organizers' tools |
| `tools.py` | Document access, search, tables, arithmetic |
| `forensics/` | Decoding, indicators, timestamps, propagation, attack phases |
| `evidence.py` | Every row shown to the model, its ID, citations |
| `guard.py` | Injection scan, placeholders for secrets, action guard |
| `providers.py` | Calls to the models (HTTP, or the kit's own client), retries, budgets, replay cache |
| `tracking.py` | A receipt for every request |
| `benchmark.py` | Scoring, comparison, failure view |
| `practice.py` | Rehearsal incident and its playbooks |
| `cli.py` | Commands and the submission adapter |
| `config.py`, `models.py` | Settings and the data shapes |

## Where tokens go, and what saves them

Cost is half the score. Best lever first:

| Lever | What it does | Setting |
| --- | --- | --- |
| Playbook | Code answers the task; no tokens, immune to injected text | `[agent] playbooks` |
| Skill | A short recipe, added only to tasks whose text matches | `[agent] skills` |
| Briefing | Tables are described and short documents shown up front, so an easy task ends in one call | `preload_documents_under`, `preload_results` |
| List results | A computed list is named `r3`; the answer says `"answer_from":"r3"` and code writes out every value | `list_preview` |
| Observation size | Every tool result is sent again with each later step | `max_observation_chars` |
| Tool list | Each listed tool costs prompt tokens on every call | `[agent] tools` |
| Placeholders | A long token or blob appears as `[[kind:id]]`; code restores it | `[guard] compact_secrets` |
| Citations by ID | The model writes `"evidence":["e7"]`; code supplies the quote | always on |
| Reasoning | Hidden thinking is paid output | `[model] extra_body` |
| Early stop | After two calls that found nothing new, the model is told to finish | always on |

A skill file starts with `match: <regex>` and then holds a few lines with
example tool calls. Code picks it from the task text, never from the evidence.
At most two skills are added per task.

The [development feedback loop](feedback-loop.md) measures one allowed setting
change at a time and keeps a candidate only when accuracy and cost meet its
explicit promotion rule. Its Analyst sees aggregates, not competition tasks or
reference answers. The dashboard is read-only and cannot launch paid calls.
`[agent] workflow = "pipeline"` separately tests batched read-only planning and
a fresh Responder; it is not the submission default. The initial experiment lost
accuracy despite costing less ([results](research/small-model-collaboration.md)).

## Defence layers

The attackers wrote the evidence. Each layer works alone and has its own
switch in `[guard]`.

1. **Roles.** The task is the only instruction; evidence is data.
2. **Injection scan.** Rows with instruction-like text are marked, also
   behind base64 and similar encodings. `injection = "withhold"` hides them.
3. **Secrets stay out of the prompt.** The model sees placeholders, so it
   cannot leak a token.
4. **Evidence IDs.** An answer can only cite rows the harness has shown.
5. **Action guard.** A containment action needs an allowed type, a target
   that is not protected, and a target that appears in the task or in clean
   evidence. A target named only by a hostile message is refused.
6. **No abstention without a look.** An abstention before any tool ran is
   questioned once.

`on_unverified` decides what happens to an answer that still fails the
checks: `abstain`, or `answer` with only the parts that passed.

These layers catch known tricks. They do not prove that an answer is right.

## Jev at run time

Jev is optional in three roles: judge of the finished answer, filter for
preloaded evidence (`[jev] select`), or a `choose` call inside a playbook.

It never blocks an answer. If Jev has no key, cannot be reached or runs out of
allowance, the answer that passed the code's checks stands. After three failed
requests in a row the run stops asking Jev. `TYPESAFE_BASE_URL` points it at a
gateway.

## Tools the model can call

| Tool | Does |
| --- | --- |
| `search`, `read` | Find and read text in the task's documents |
| `table` | Filter, count, group and list distinct values in CSV, JSONL, JSON, XLSX |
| `after` | Rows of each actor from its trigger event on ("what did every compromised agent do afterwards") |
| `graph` | Who contacted whom; reach of an infection; where it began |
| `decode` | Peel base64, hex, gzip, XOR and similar layers; join numbered chunks |
| `iocs` | List tokens, keys, addresses, URLs, digests in a document |
| `phases` | Assign attack phases to commands by rule |
| `calculate` | Arithmetic |

All are deterministic and bounded, and none executes recovered content.
`hacklab decode` and `hacklab iocs` offer two of them on the command line.

## What counts as a table

The data's shape is unknown until the opening, so a document is read by what
it holds, not by its name.

| Document | Read as |
| --- | --- |
| `.jsonl`, `.ndjson`, and a `.log`, `.txt` or suffix-less file of JSON lines | One row per line, nested fields as `a.b` columns |
| A log of `key=value` pairs, with or without a leading timestamp and level | One row per line |
| `.csv`, `.tsv` | Rows; a short row gets empty cells, a long one keeps its surplus in the last column, unnamed or repeated headers get names |
| `.json` with one list of records | Rows |
| `.json` with several lists, or records stored under their IDs | All rows, told apart by a `_table` column; the ID is `_key` |
| Anything else that is text | Lines to read and search |

The time column is found by its usual names, else by its values: the column
whose every value is a timestamp. A damaged line stays readable as text. A
binary file is refused, not guessed at.

## The organizers' tools

Wrap each starter-kit function and pass the list to `run_task`:

```python
from hacklab.toolkit import ToolSpec

tools = [
    ToolSpec.from_function(kit.get_agent_log),
    ToolSpec.from_function(kit.quarantine_agent, mutating=True),
]
```

`mutating=True` sends the call through the action guard first. A failing tool
gives the model an error line, never an exception.

[`hacklab.event.adapter`](../src/hacklab/event/adapter.py) does this wrapping
and the rest of the seam: `solve(question, task_id=..., data_dir=...,
kit_tools=[...])` returns the answer as a plain dict in the organizers'
shape. Three things a kit may bring are covered:

- **Its own model client.** `model=kit.chat` sends every request through
  that function instead of our HTTP client. Budgets, receipts, the replay
  cache and the request timeout apply as before; a call that hangs is given
  up after `timeout_seconds`.
- **Data only through tools.** `snapshot(directory, name, rows)` writes what
  a kit tool returned as a document, so that `table`, `after` and `graph`
  work on it and every row can be cited.
- **Actions from code.** A playbook calls a kit tool with
  `workspace.call("quarantine_agent", agent="a7")`; a mutating tool passes
  the action guard there too.

## Limits and privacy

- Each task has limits for steps, calls, time, context and output tokens
  (`[limits]`). Every HTTP attempt counts, including Jev and retries. The
  defaults in `config.py` equal `configs/live.toml`, which equals the profile
  the benchmark numbers come from; `tests/test_config.py` keeps the three
  together.
- When the harness itself ends a task (a limit, a provider failure, the end
  of the run), the answer carries a fixed `cause` such as
  `token_budget_exhausted_before_request`. `hacklab failures` groups by it.
- A failed request is retried with a growing pause (`http_retries`); a
  malformed reply gets one repair turn (`max_retries`). The first costs time,
  the second tokens.
- Nothing passes from one task to the next: no answers, no summaries.
- The replay cache and the trace (`HACKLAB_TRACE_DIR`) hold model replies and
  task data. Both live in the ignored `.state/` directory and are off in the
  submission image.

## Adapt at the opening

1. Map the organizers' task and answer format in `event/adapter.py`
   (`to_kit`, `MUTATING`) and set the image's `CMD`.
2. Wrap their tools; set `allowed_actions` and `protected_targets`.
3. Confirm URL, key and reply format with `hacklab probe`. Only the
   OpenAI-compatible chat API is implemented.
4. Write a playbook or a skill per task type, with held-out cases.
5. Measure one change at a time ([benchmarks](benchmarks.md)).
