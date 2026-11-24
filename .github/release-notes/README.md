# Release notes

Add `v<version>.md` in the release PR. Use `## 中文` and `## English`, with a short list of changes users can see. Mention any change to installation, upgrade, or compatibility that users need to act on.

Run the **Publish npm release** workflow on `main` with the version in `package.json`. It verifies the release archive in CI, publishes that archive to npm, and uses the checked-in notes for the GitHub Release.
