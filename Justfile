default:
    @just --list

setup:
    uv sync --locked

# First run on a laptop without Nix: what is missing, dependencies, offline rehearsal.
laptop:
    bash scripts/setup

fmt:
    bash scripts/ruff format src tests examples
    bash scripts/ruff check --fix src tests examples

fmt-check:
    bash scripts/ruff format --check src tests examples

check:
    bash scripts/check

dashboard-check:
    bash scripts/dashboard-check

dashboard:
    cd dashboard && bun run start

test:
    uv run --locked python -m pytest -q

doctor:
    uv run --locked hacklab doctor

# One step after the first boot or clone: dependencies, linked skill, readiness.
ready: setup
    if [ -n "${HACKATHON_SKILLS_DIR:-}" ]; then bash scripts/vm-skills; fi
    uv run --locked hacklab doctor

# Offline plumbing over the eight small document fixtures.
bench:
    uv run --locked hacklab benchmark --config configs/mock.toml --out results/mock.json

benchmark: bench

# Rehearsal incident for one seed, solved by the code-only playbooks: no model call.
practice seed="7":
    rm -rf data/practice-{{seed}}
    uv run --locked hacklab practice --seed {{seed}} --out data/practice-{{seed}}
    uv run --locked hacklab benchmark --config configs/practice.toml \
      --dataset data/practice-{{seed}}/cases.jsonl --root data/practice-{{seed}}/docs \
      --out results/practice-{{seed}}.json

# The same rehearsal against the configured model. Costs requests; replays what it can.
practice-live seed="7" config="configs/live.toml":
    test -d data/practice-{{seed}} || uv run --locked hacklab practice --seed {{seed}} --out data/practice-{{seed}}
    HACKLAB_CACHE_MODE=readwrite uv run --locked hacklab benchmark --config {{config}} \
      --dataset data/practice-{{seed}}/cases.jsonl --root data/practice-{{seed}}/docs \
      --out results/practice-{{seed}}-live.json
    uv run --locked hacklab failures results/practice-{{seed}}-live.json

# What the team's request allowance has paid for so far.
budget config="configs/live.toml":
    uv run --locked hacklab budget --config {{config}}

# Build the submission image and run it without any network.
container-test:
    bash scripts/container-test

# The laptop setup inside stock Ubuntu and Debian containers.
portability-test:
    bash scripts/portability-test

build:
    uv build

vm-build:
    nix build .#vm

vm:
    bash scripts/vm-run
