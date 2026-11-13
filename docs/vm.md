# VM and Nix setup

**You do not need any of this.** Git, uv and Docker or Podman on your own
laptop are enough: `bash scripts/setup` ([README](../README.md#set-up)). This
page is for those who want the pinned Nix environment or the ready-made VM.

| Option | Command | Runs on | Gives you |
| --- | --- | --- | --- |
| Laptop setup | `bash scripts/setup` | Linux, macOS, Windows (Git Bash, WSL 2) | The harness and its checks through uv |
| Nix shell | `nix develop` | x86_64 Linux with Nix | Python 3.15, uv, Ruff, Bun, Just and command-line tools. No container engine |
| QEMU VM | `bash scripts/vm-run` | x86_64 Linux with Nix and KVM | The same tools plus rootless Podman, isolated from your machine |
| NixOS host service | `vm start hacklab-vm` | NixOS | The VM as an on-demand service (see below) |

The VM is a NixOS guest for x86_64 and needs hardware virtualization, so it
does not run on macOS, on Windows outside WSL 2 or on ARM. Nothing in the
project depends on it: all four options run the same code from the same
`uv.lock`, and the submission is the container image either way.

## The VM

Needs Nix and KVM (`/dev/kvm`). On Ubuntu: install Nix from
[nixos.org/download](https://nixos.org/download), then
`sudo usermod -aG kvm $USER` and log in again. The script switches flakes on
for its own call, so a fresh Nix installation needs no configuration.

```console
bash scripts/vm-run                        # 4 vCPUs, 8 GiB RAM, 40 GiB disk
bash scripts/vm-run --memory 6144 --cpus 2 # on a smaller laptop
```

The guest console opens in the same terminal, logged in as `hackathon`. Then:

```console
passwd                # the password starts empty; sudo needs one
cd ~/workspace/hacklab-vm
just ready
just practice
just container-test
```

Good to know:

- **The console is the only way in.** No SSH daemon, no forwarded port,
  nothing mounted from the host. Use `tmux` for several windows and type
  `fit` after resizing the terminal.
- **The guest reaches the internet, nothing reaches the guest.** Move work
  with `git`, `curl` or `wormhole receive`. Enter keys inside the guest.
- **The project is copied in at first boot** as a fresh Git repository without
  history. To join the shared history:
  `git fetch origin && git reset origin/main`.
- **Leave with `sudo poweroff`.** The disk stays at
  `~/.local/state/efficient-local-agents/vm/hackathon.qcow2`. It may hold
  keys and data: never commit or publish it.
- **Python versions:** `python3` is 3.15. `python3.13` is what the submission
  image runs, `python3.11` the oldest supported one. `export UV_PYTHON=3.13`
  and a new sync switch the project.
- **No KVM?** `bash scripts/vm-run --tcg` emulates in software and is slow.
  Prefer `nix develop`.

`bash scripts/vm-smoke` tests the whole VM on a disposable disk: it boots the
guest and runs `scripts/guest-check` there, including the container test. It
takes about ten minutes and needs KVM, PyPI and the image registries.
`PORTABILITY_TEST=1 bash scripts/vm-smoke` also runs the laptop setup inside
stock Ubuntu and Debian containers (`scripts/portability-test`).

## The container

The agent is evaluated in a container, so the image is part of what must
work. `just container-test` builds the [Dockerfile](../Dockerfile) and then
checks, with no network at all:

1. the rehearsal incident is solved by the playbooks;
2. the candidate profile finds its playbooks and skills inside the image
   (`doctor --strict`), and the agent answers nine tasks through a stand-in
   model over a local address, with the baseline and the candidate profile;
3. Jev works over a local address, and the agent still answers when Jev is
   absent;
4. the container cannot reach the internet;
5. the agent runs as an unprivileged user and cannot change its own code.

It uses `docker` when present, else `podman`; `CONTAINER_ENGINE` picks one.
Only the build needs the registries and PyPI. On an ARM laptop,
`HACKLAB_PLATFORM=linux/amd64` builds and tests the image for an x86_64
evaluation machine (slower, through emulation). In Git Bash the script keeps
Windows from rewriting the container paths.

Still to do at the opening: set the Dockerfile's `CMD` to the organizers' run
contract and add the starter kit to the build. Keys never go into the image;
they arrive as environment variables.

## On a NixOS host

Add this repository as a flake input, then:

```nix
{
  imports = [ inputs.hacklab-vm.nixosModules.host ];
  services.hacklab-vm = {
    enable = true;
    operatorName = "alice";   # existing account that owns and runs the VM
    # memoryMiB = 8192; vcpu = 4; bob.enable = false; stateDirectory = null;
  };
}
```

| Command | Effect |
| --- | --- |
| `vm start hacklab-vm` / `stop` / `restart` | Control the VM; it never starts by itself |
| `vm view hacklab-vm` | Attach to the guest console; Ctrl-] detaches |
| `vm status hacklab-vm` / `logs` | Service state and boot console |

No sudo and no network listener are involved. Disk and control sockets live
in `~/.local/state/hacklab-vm`.

A host that makes this input follow its own Nixpkgs gets a different guest
than the one tested here. Boot-test it:

```console
runner=$(nix build --no-link --print-out-paths \
  'git+file:///path/to/host#nixosConfigurations.NAME.config.services.hacklab-vm.runner')
HACKATHON_VM_RUNNER=$runner bash scripts/vm-smoke
```

For an existing NixOS guest, `nixosModules.default` with
`hackathon.enable = true` installs the tool list without creating a VM.

## IBM Bob (optional)

Bob is IBM's coding assistant. It is **off by default** and nothing in this
repository needs it. To get it:

```console
bash scripts/vm-run --bob       # VM with Bob Shell
nix develop .#with-bob          # Nix shell with Bob
```

On a NixOS host set `services.hacklab-vm.bob.enable = true`; in the guest
module `hackathon.bob.enable = true`.

Bob comes from a private packaging repository
(`timfewi/bobshell.nix`); the Bob variants need access to it, the default
ones do not. Once per machine:

1. Accept IBM's terms: `bob --accept-license chat`.
2. Authenticate: create an API key in the Bob web portal and export it as
   `BOB_API_KEY`.
3. Start `bob chat` in the project. Bob reads `AGENTS.md` as its rules.

Bob builds the solution. It is never a run-time model. Do not upload
Bob-containing VM images to a public cache.

## The linked Jev skill

In the Nix shell and in the VM, `just ready` links TypeSafe's own
`typesafe-ai` skill for coding assistants into `.agents/skills` (or `.bob/skills` when Bob is installed). It helps an
assistant write good Jev questions. The agent itself loads no skill from
there. After a pin update: `bash scripts/vm-skills`.

## Reproducibility

`flake.lock` pins Nixpkgs, the Bob packaging and the TypeSafe skill.
`uv.lock` pins the Python dependencies, and the Dockerfile installs from it.
The first build and the first `uv sync` need the internet: do both before you
travel.
