# Secret scanning (gitleaks)

This repo blocks accidental secret commits in three places:

| Layer | When | Command / mechanism |
|-------|------|---------------------|
| **Pre-commit** | Every `git commit` (after setup) | `.githooks/pre-commit` → `gitleaks protect --staged` |
| **Local full scan** | Before push / release | `npm run scan:secrets` |
| **GitHub Actions** | Every push and PR to `main` | CI job `secrets` (full history + tracked files) |

All layers use [gitleaks](https://github.com/gitleaks/gitleaks) with `.gitleaks.toml` (`.env.example` placeholders are allowlisted).

## One-time setup (contributors)

1. Install gitleaks (pin matches CI — currently **8.24.3**):

   ```bash
   brew install gitleaks   # macOS
   ```

   Other platforms: [gitleaks installing](https://github.com/gitleaks/gitleaks#installing).

2. Enable the pre-commit hook for this clone:

   ```bash
   npm run setup:hooks
   ```

   `npm run init` runs this automatically when gitleaks is available.

3. Verify:

   ```bash
   npm run scan:secrets
   ```

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run scan:secrets` | Full repository scan (history + tracked paths) |
| `npm run scan:secrets:staged` | Staged changes only (same as pre-commit) |
| `npm run setup:hooks` | Set `git config core.hooksPath .githooks` for this clone |

Implementation: `scripts/run-gitleaks.mjs`.

## Pre-commit behavior

On each commit, gitleaks scans **staged** content. If a secret is found, the commit is rejected.

- **False positive:** add a narrow entry under `[allowlist]` in `.gitleaks.toml` and explain in the PR.
- **Skip one commit (emergency):** `SKIP_SECRET_SCAN=1 git commit …` or `git commit --no-verify` — use rarely; CI still scans the branch.

## CI (GitHub)

Workflow [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs a dedicated **`secrets`** job before build/test. It checks out full history (`fetch-depth: 0`) and runs the same config as `npm run scan:secrets`. PRs cannot merge if this job fails (when branch protection requires CI).

## Manual commands

Full repo (same as `npm run scan:secrets`):

```bash
gitleaks detect --redact --config .gitleaks.toml --verbose --exit-code 1
```

Staged only (same as pre-commit):

```bash
gitleaks protect --staged --redact --config .gitleaks.toml --verbose --exit-code 1
```

Unpacked directory (no `.git`):

```bash
gitleaks detect --no-git --source /path/to/tree --redact --config .gitleaks.toml --verbose --exit-code 1
```

## What scanning does not replace

- Never commit `.data/`, `.env`, `.env.local`, `exports/`, `briefings/`, or import data — they stay gitignored.
- Review diffs before push; hooks and CI catch many mistakes but not every leak class.

See also [`clean-machine-first-run.md`](./clean-machine-first-run.md) (`npm run onboard` includes an optional full scan).
