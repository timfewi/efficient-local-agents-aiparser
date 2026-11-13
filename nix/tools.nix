{ pkgs }:
let
  python = pkgs.python315;
  # Older interpreters under their versioned names only, so `python3` stays
  # unambiguous. 3.13 is what the submission image runs (see Dockerfile) and
  # 3.11 is the oldest version the starter kit and this project support:
  # `export UV_PYTHON=3.13`, then sync, runs the project as the container does.
  # 3.14 is the escape hatch for a dependency without a CPython 3.15 wheel.
  pythonFallback = pkgs.runCommand "python-fallbacks" { } ''
    mkdir -p "$out/bin"
    ln -s ${pkgs.python314}/bin/python3.14 "$out/bin/python3.14"
    ln -s ${pkgs.python313}/bin/python3.13 "$out/bin/python3.13"
    ln -s ${pkgs.python311}/bin/python3.11 "$out/bin/python3.11"
  '';
in
{
  inherit python;
  # Binary wheels such as numpy, pandas, pymupdf and duckdb load these at import
  # time. The Nix interpreter does not search a global library directory.
  wheelLibraries = [
    pkgs.stdenv.cc.cc.lib
    pkgs.zlib
  ];
  packages = with pkgs; [
    python
    pythonFallback
    uv
    bun
    ruff
    git
    gh
    just
    jq
    yq-go
    ripgrep
    fd
    curl
    openssh
    sqlite
    duckdb
    poppler-utils
    # English, German and orientation data instead of every language model.
    (tesseract.override {
      enableLanguages = [
        "eng"
        "deu"
        "osd"
      ];
    })
    pandoc
    p7zip
    unzip
    file
    tree
    zstd
    tmux
    nano
    vim
    htop
    util-linux
    hyperfine
    time
    shellcheck
    nixfmt
  ];
}
