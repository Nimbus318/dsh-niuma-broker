# Engineering Contract for Agents and Contributors

`dsh-niuma-broker` is a DeepSeek Harness (DSH) plugin targeting Node.js `>=22` (pure ESM) with `esbuild` as the sole `devDependency`.

## Architectural Invariants

1. **DSH-native capabilities first**: Use host primitives and services (`@deepseek-ai/dsh-client-ui-primitives`, `ctx.locale`, `agentDefaultModel`, `officeKit`, `llm.prepareCall` / `stream`, `attachments` only with explicit lifecycle) instead of reimplementing host behavior.
2. **Strict per-profile isolation**: Persist all profile state, resumes, grants, and config under `ctx.profileContext.dir`. Never inject `storageDomain` or share data across profiles.
3. **Consent & upload boundaries**: Keep local-first parsing (`src/file-extract.mjs`) as the default. Never silently copy scanned PDFs/images into `ctx.attachments` or send images to a vision model without explicit user action and accurate page-count reporting.
4. **Default model routing fidelity**: Resolve DSH's active default provider/model (`agentDefaultModel`, `isDefault`, `defaultReasoningEffort`) accurately, honor explicit plugin overrides first, spread `prepared.config` on `prepared.stream(...)`, gate 429 retries on explicit SDK `providerRetryAfterMs`, and never silently fall back to another provider when DSH's configured default is unavailable.
5. **Semantic AI over brittle rules**: Prefer structured LLM extraction with verified source quotes over piling up fragile regex special cases.
6. **Lean dependencies**: Keep runtime/build footprint minimal; verify any `package.json` `files`/`exports` or `locale/*.json` changes against `test/repo-hygiene.test.mjs`.

## Git & PR Workflow

- **Never commit or push directly to `main`**. Branch from `origin/main` using focused topic branches (`feat/`, `fix/`, `refactor/`, `ci/`, `docs/`, `chore/`).
- **One PR = one topic**; squash-merge only (`PR_TITLE` + `PR_BODY`), with source branches deleted on merge and no lingering upload/staging branches.
- **Conventional prefixes**: `feat:`, `fix:`, `refactor:`, `ci:`, `docs:`, `chore:`. Explain **Why** and trade-offs concisely in the PR body.
- **Decouple features from releases**: Never bundle feature work into a release commit. Release via a dedicated `chore: release X.Y.Z` PR touching only version metadata and `.github/release-notes/vX.Y.Z.md`, then manually dispatch `.github/workflows/release.yml` on `main`.
- **Never** run `npm publish`, push tags, or dispatch `release.yml` without explicit maintainer confirmation.

## Mandatory Verification

Run after final edits:

```bash
npm run build
node --test --test-concurrency=1 test/*.test.mjs
```

When modifying host integration, upload handling, or packaging, also run `npm pack --dry-run --json` and DSH host smoke checks (`scripts/ci/smoke-dsh.mjs`).
