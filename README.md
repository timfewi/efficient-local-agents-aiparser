# hacklab-vm

Our agent for the **Efficient Local Agents Hackathon**, Saturday 14 November
2026 at IBM Vienna.

The challenge is "The MuggingFace Incident": a hijacked agent swarm attacks a
model hub, and our agent is the night shift. It has to investigate the
incident and contain it, on a small model that every team gets. The score is
half accuracy and half cost.

Our approach: code does everything code can do (read logs, decode payloads,
follow who infected whom, check every action). The small model makes one small
decision at a time.

## New here? Read in this order

| | Read | Time |
| --- | --- | --- |
| 1 | This page | 3 min |
| 2 | [Rules and open questions](docs/hackathon.md) | 5 min |
| 3 | [Plan for Saturday](docs/playbook.md) | 5 min |

Look up the rest when you need it:
[how the agent works](docs/architecture.md),
[how to measure a change](docs/benchmarks.md),
[development feedback loop and dashboard](docs/feedback-loop.md),
[VM and Nix setup](docs/vm.md),
[what was actually tested](VERIFICATION.md).

## Set up

One command on any laptop. It checks what is installed, says how to get what
is missing, installs the dependencies and solves the rehearsal incident
offline. No GPU, no key, no model request.

```sh
git clone https://github.com/timfewi/hacklab-vm.git && cd hacklab-vm
bash scripts/setup             # add --check for format, lint and all tests
bash scripts/container-test    # builds the image, runs it without network
```

`setup` must end with `Ready.` and the container test with
`Container test passed.`

| Your laptop | You need | Container engine |
| --- | --- | --- |
| Ubuntu, Debian, Fedora | Git, [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh \| sh`) | `docker.io` or Podman |
| macOS, Intel or Apple Silicon | Git, uv (`brew install uv`) | Docker Desktop or Colima |
| Windows | Git for Windows, uv; run the commands in **Git Bash** or in WSL 2 | Docker Desktop |
| NixOS, or any Linux with Nix | `nix develop`, or the ready-made VM in [docs/vm.md](docs/vm.md) | Podman inside the VM |

uv fetches Python by itself. In PowerShell without Git Bash, the same steps
are `uv sync --locked`, `uv run hacklab doctor` and
`uv run python -m pytest -q`. One laptop per team needs a container engine;
the others can develop without. On an ARM laptop, build the image for the
evaluation machine with `HACKLAB_PLATFORM=linux/amd64 bash scripts/container-test`.

Shortcuts with [just](https://just.systems): `just laptop`, `just check`,
`just practice`, `just container-test`.

## Talk to a model

```sh
cp .env.example .env && chmod 600 .env     # then enter URL, model name and key
uv run hacklab probe --config configs/live.toml
```

`probe` sends one small request to each model and shows whether URL, key and
reply format fit. Keys live only in `.env`, which Git ignores.

To rehearse before the event, put an OpenRouter key into `.env` as
`SMALL_MODEL_API_KEY` and run `just practice-live 7 configs/openrouter.toml`.

## What is where

| You want to | Look at |
| --- | --- |
| Solve a task type in code, without the model | `src/hacklab/event/playbooks.py`, worked example `examples/event_playbooks.py` |
| Give the model a recipe for one task type | `src/hacklab/event/skills/` |
| Plug in the organizers' starter kit | `src/hacklab/event/adapter.py` |
| Change prompt, loop or final checks | `src/hacklab/agent.py` |
| Change a model or agent setting | `configs/live.toml`, the profile that is submitted |
| See why a run lost points | `hacklab failures REPORT`, then the trace of the task |
| Decode a payload or list indicators by hand | `hacklab decode FILE`, `hacklab iocs FILE` |
| Build the submission image | `Dockerfile`, `scripts/container-test` |

`src/hacklab/event/` is the one package made for the day: it is inside the
image without another line in the Dockerfile. All commands:
`uv run hacklab --help`.

## Three rules

1. **Only the organizers' models decide at run time.** No own LLM, embedder,
   reranker or classifier in the agent. Coding assistants help us build.
2. **Keys stay in `.env`.** Never in code, configs, chat or the image.
3. **No change without a number.** Measure before and after on the same
   cases ([how](docs/benchmarks.md)).

Everything here is preparation. The rehearsal data was written for this
repository; nothing was measured on the event's model or data.
