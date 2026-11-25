# Contributing to Niuma Broker (`dsh-niuma-broker`)

Thanks for contributing! See [`AGENTS.md`](./AGENTS.md) for the architectural invariants and agent/contributor contract.

## Local Setup & Verification

Requires Node.js `>=22`.

```bash
npm ci
npm run build
node --test --test-concurrency=1 test/*.test.mjs
```

Browser-backed tests launch Chromium serially, so use `--test-concurrency=1` locally as in CI.

## Branches, Commits & Pull Requests

1. Branch from `origin/main` (`feat/...`, `fix/...`, `refactor/...`, `ci/...`, `docs/...`, `chore/...`).
2. Keep each PR focused on a single concern. All PRs are squash-merged into `main` with source branches deleted automatically.
3. Title PRs using `feat`, `fix`, `refactor`, `ci`, `docs`, or `chore` with an optional lowercase module scope (`<= 72` chars, no trailing period, no internal tracking IDs or local paths — enforced by `.github/workflows/pr-title.yml`), and fill in `.github/pull_request_template.md` (**What changed and why** + **Verification**). See [`AGENTS.md`](./AGENTS.md) as the single source of truth.
4. Keep `locale/en.json` & `locale/zh.json` and `locale/messages/{en,zh}.json` key-aligned (`test/repo-hygiene.test.mjs` enforces parity).

## Release Process

Releases are decoupled from feature PRs:

1. Merge all target feature/fix PRs into `main` and ensure CI (`verify` + 3-OS `DSH smoke`) is green.
2. Open a dedicated `chore: release X.Y.Z` PR that updates `package.json` / `package-lock.json` and adds `.github/release-notes/vX.Y.Z.md` (see [`.github/release-notes/README.md`](./.github/release-notes/README.md)).
3. After merging to `main`, run the **Publish npm release** workflow (`.github/workflows/release.yml`) from `main` with `version = X.Y.Z`.
