# How to measure a change

## The loop

For a bounded automatic development loop and graphical results, see the
[feedback workspace](feedback-loop.md). It keeps hold-out observations separate
and makes rejected or uncertain trials visible alongside improvements.

```sh
export HACKLAB_CACHE_MODE=readwrite      # replay unchanged requests for free
uv run hacklab benchmark --config configs/baseline.toml \
  --dataset bench/dev.jsonl --root bench/dev --out results/baseline.json
uv run hacklab benchmark --config configs/live.toml \
  --dataset bench/dev.jsonl --root bench/dev --out results/live.json
uv run hacklab compare results/baseline.json results/live.json
uv run hacklab failures results/live.json
uv run hacklab budget --config configs/live.toml
```

- `compare` shows the change in accuracy, cost, calls and tokens.
- `failures` shows which check failed per category, the calls per task and
  `causes`: tasks that the harness itself stopped.
- `budget` shows what was really sent against `[budget]`.
- `benchmark --workers 4` runs four cases side by side: the same requests and
  the same scores in less time. Compare latencies only between runs with the
  same number of workers.

Copy a config and change exactly one setting. One configuration is better
only if accuracy does not fall and cost does not rise. There is no combined
score here, because the organizers' formula is unknown.

## Cases

Three kinds exist. None is the organizers' benchmark.

| Cases | Where | Use |
| --- | --- | --- |
| Eight small document tasks | `bench/smoke.jsonl` | Plumbing |
| Rehearsal incident, nine tasks per seed | `hacklab practice --seed N --out DIR` | Rehearsal; an unseen seed is a hold-out set |
| Your cases from the organizers' tasks | `bench/dev.jsonl`, built on the day | The real tuning |

One line per case: `{task, expected, category}`. Only `task` reaches the
agent. A case scores 1 when every declared check passes:

| `expected` field | Passes when |
| --- | --- |
| `status` | The answer has this status (`ok`, `abstain`, `error`) |
| `exact_answer` | The answer equals it, ignoring case and spacing |
| `answer_set` | The answer lists exactly these items, in any order |
| `contains` / `excludes` | Each text occurs / does not occur |
| `citation_documents` | Each document is cited |
| `actions` | The containment actions are exactly these (type, target) pairs |

Keep three files apart: development cases, a hold-out file, the organizers'
feedback. Tune on the first, run the second once per candidate before the
freeze.

## Reading failures

| Failed check | Usually means |
| --- | --- |
| `required_documents` | Retrieval missed, or a tool is missing |
| Answer wrong, sources right | The model, or a rule that belongs in a playbook |
| `status` | Abstention policy, a guard, or a provider error |
| `actions` with high recall, low precision | Over-containment |

Then read the trace of the failing task: `HACKLAB_TRACE_DIR=.state/trace`
writes every prompt, reply and tool result to a private text file.

Check `causes` before anything else. A cause is a fixed code that says which
bound ended the task; no prompt change helps against it.

| Cause | Setting to look at |
| --- | --- |
| `token_budget_exhausted_before_request` | `max_total_tokens`: it is compared with the request size in bytes |
| `request_budget_exhausted`, `step_limit_reached` | `max_calls`, `max_steps`; or a skill that ends the wandering |
| `task_time_budget_exhausted`, `provider_timeout` | `task_timeout_seconds`, `timeout_seconds`, reasoning effort |
| `run_deadline_reached` | `submit --deadline-seconds`, `--workers` |
| `provider_http_429`, `provider_http_503` and the like, `provider_transport_error` | `http_retries`, fewer workers |
| `model_returned_reasoning_only`, `model_output_truncated` | `extra_body` (thinking), `max_output_tokens` |
| `output_failed_validation` | The reply format: `response_format`, then the trace |
| `configure_small_model_base_url_and_name`, `small_model_key_missing` | `.env` |
| `local_setup_failed` | A document or tool raised: run `solve` on the task with `HACKLAB_DEBUG=1` |

This table exists because of a mistake found on 13 November: the profile to
be submitted had tighter limits than the profile that was measured. Replaying
the recorded runs under those limits turned the `secrets` and `contain` tasks
into abstentions before the model was asked (7 of 9 became 6, 6 became 5).
The two profiles are now equal and a test keeps them so.

## Budget

- With the cache on, only changed prompts cost anything. Changing the system
  prompt, the tool list or a model setting changes every prompt: batch such
  changes.
- `HACKLAB_CACHE_MODE=replay` sends nothing and fails on a miss.
- `hacklab budget` counts this laptop only. Split the team's allowance
  between laptops.
- The submission image runs with the cache off and without `[budget]`.

## Cost numbers

Every request, retry and Jev call gets a receipt in a private SQLite file
(`.state/tracking.sqlite`). It holds tokens, latency and status, never
prompts, answers or keys.

- Cost is an estimate: reported tokens times the prices in the config.
  **Enter the organizers' prices**; list prices can differ.
- Without reported usage or without prices, cost is `null` (unknown), never
  guessed. `known_cost_usd` is the measured part.
- A replayed request counts with the usage it had when live, so a run's cost
  is what it would cost without a cache.

## Results on a real small model

Measured on 13 November 2026 with IBM Granite 4.2 8B through OpenRouter, as a
stand-in for the event's model. The model worked alone with the tools, no
playbooks. One run per row at temperature 0: a difference of one task is
noise.

| Setup | Right, of 9 per seed | Cost per seed |
| --- | --- | --- |
| First harness, reasoning off | 4 | $0.011 |
| Final harness, reasoning off | 6, 5 | $0.008 to $0.010 |
| **Final harness, reasoning low** | **7, 6, 5** | **$0.004** |
| Reasoning high | 6, 5 | $0.018 to $0.022 |
| Reasoning low, schema-enforced JSON | 7, 6 | $0.004 |
| Reasoning off, visible thought | 5, 5 | $0.010 |
| Reasoning low, two example skills | 7, 6, 5 | $0.003 to $0.004 |
| Reasoning low, Jev as judge | 6, 5 | $0.006 |
| Playbooks (code only) | 9 | $0 |

The eight document tasks: 8 of 8 for $0.0007.

What we learned:

- **Low reasoning wins.** Cheaper and at least as accurate as off; high costs
  four to five times as much for no gain.
- **Playbooks beat the model** wherever a rule combines several filtered
  lists. That is the division of labour to expect.
- **Skills help where a general prompt sentence did not.** The containment
  task went from an abstention to about 0.9 precision and 0.85 recall. The
  count of exactly right tasks stayed the same; a skill with the real column
  names should close that.
- **The model takes a search sample for the whole answer.** Tables are now
  described up front instead of searched.
- **It mistypes long lists.** Lists are results with an ID that code writes
  out.
- **It wanders when nothing is found.** A step countdown and the early stop
  cut cost by 10 to 29 %.
- **Jev as judge is mixed.** It turned wrong answers into abstentions, and
  once a right one too. Worth it only if a wrong answer costs more than none.
- **Not worth it:** schema-enforced replies, a visible thought, an embedder
  (also forbidden).

To repeat: `just practice-live 7 configs/openrouter.toml` with an OpenRouter
key in `.env`.

The perfect score of the playbooks shows that the tools work on data built
for them. None of these numbers predicts the event's model or data.
