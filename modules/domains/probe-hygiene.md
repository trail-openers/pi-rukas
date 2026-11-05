# Probe Hygiene

A probe that needs hostile, alternate or empty config — an unreadable
`~/.gitconfig`, a foreign `GH_CONFIG_DIR`, a git identity that must not be the
operator's — runs in a scratch directory you made: point `HOME`,
`GIT_CONFIG_GLOBAL` and `XDG_CONFIG_HOME` at one `mktemp -d` and pass that env
to the command.

A reviewer MUST NEVER WRITE under $HOME and never write outside its review tree:
the operator's home holds their git identity and their gh credentials, and the
guard that reports a leftover cannot undo the write.
