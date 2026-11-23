# Local Reactive Resume editor

This bundle uses the rich-text preset from [Reactive Resume v6.1.1](https://github.com/AmruthPillai/Reactive-Resume/tree/a2ad05181e133f4981fc1d8a2c46811069af4d25). It runs in the plugin's own editor surface, using a local document supplied by DSH.

- `upstream/` contains the original input extensions, content direction, paste cleanup, and table and whitespace parsing from `apps/web/src/components/input/`. Imports are adapted to local utilities and `@tiptap/core`. The original React integration imported the same Tiptap core APIs through `@tiptap/react`.
- The utility excerpts are from `packages/schema/src/resume/limits.ts` and `packages/utils/src/{color,string}.ts`. Only functions used by the editor are included.
- `editor.js` is the DSH adapter. It uses the pinned Tiptap Markdown codec for the existing draft format and uses the upstream clipboard pipeline. Markdown that requires unsupported content types opens as source so it remains editable.
- `editor.bundle.js` is a browser-only asset. `LICENSE` includes the Reactive Resume MIT terms. `THIRD_PARTY_LICENSES.txt` enumerates the packages present in the bundle and their license texts.

To rebuild this asset from the lockfile, run the following in this directory.

```sh
npm ci
npm run build
```

The main plugin build uses the prebuilt asset, so it requires only the main plugin's build tools.
