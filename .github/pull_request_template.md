## What changed and why

<!-- Describe the user-visible result or maintenance problem this solves (1–3 sentences). -->

## Verification

- [ ] `npm run build`
- [ ] `node --test --test-concurrency=1 test/*.test.mjs`
- [ ] `npm pack --dry-run` / `node pack-release.mjs` (package contents & hygiene verified)
- [ ] `README.md` / `README.en.md` and `locale/messages/{en,zh}.json` updated if user-facing behavior or copy changed
<!-- Name any additional DSH host / Desktop smoke checks, environments, or known gaps. -->

## Release PRs only (`chore: release X.Y.Z`)

- [ ] Updated `package.json`, `package-lock.json`, and `README.md` / `README.en.md` tarball examples to `X.Y.Z`
- [ ] Added bilingual `.github/release-notes/vX.Y.Z.md` (`## 中文` + `## English`) with no local paths or internal tracking IDs
