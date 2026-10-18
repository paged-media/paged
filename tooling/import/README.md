# tooling/import

How this repository was assembled from the former per-component repositories.

- `manifest.yaml` lists every imported repository, its target directory and
  the path rules applied to its history.
- `assemble.py WORK_DIR` mirrors each repository, rewrites it with
  `git filter-repo` (path rules, history-only blob strips, `mailmap`, `#N` →
  `paged-media/<repo>#N` in commit messages, directory prefix) and merges the
  results under one root commit.
- `verify.py WORK_DIR` checks the result: identical component trees, tag trees,
  author identities, forbidden files, a gitleaks scan and history presence.
- `import-lock.json` records the exact source SHA and rewritten tip of every
  import. `commit-maps/<repo>.tsv` maps each original commit SHA to its
  rewritten SHA, for following old links and pins.
- `root/` holds the files of the root commit.

Requirements: git, git-filter-repo, Python 3 with PyYAML, gitleaks.
