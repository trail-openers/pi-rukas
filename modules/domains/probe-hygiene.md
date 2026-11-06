# Probe Hygiene

A probe that needs hostile, alternate or empty config — an unreadable
`~/.gitconfig`, a foreign `GH_CONFIG_DIR`, a git identity that must not be the
operator's — runs in a scratch directory you made: point `HOME`,
`GIT_CONFIG_GLOBAL` and `XDG_CONFIG_HOME` at one `mktemp -d` and pass that env
to the command.

A reviewer MUST NEVER WRITE under $HOME and never write outside its review tree:
the operator's home holds their git identity and their gh credentials, and the
guard that reports a leftover cannot undo the write.

Make one directory for the run and put every probe file in it: one `mktemp -d`,
used for every probe in this review, nothing written anywhere else. Keep the
total under 50 MB — a fixture that needs more than that is measuring the wrong
thing — and delete the directory before you report. The parent measures what a
reviewer child leaves under the temp directory and reports it, but it never
deletes it: a temp directory you filled is a temp directory the next child
dies in.
