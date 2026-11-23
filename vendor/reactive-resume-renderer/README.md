# Reactive Resume local renderer

The plugin ships the HTML renderer and 18 templates from Reactive Resume v6.1.1, commit `a2ad05181e133f4981fc1d8a2c46811069af4d25`. The plugin maps its own Markdown documents to the upstream résumé schema. The renderer outputs an HTML sheet under `.rr` using locally available fonts. All code for editing, managing versions and collaborating with the Agent runs inside the DSH plugin. Preview works offline.

The bundled entry point comes from [Reactive Resume's PDF package](https://github.com/reactive-resume/reactive-resume/blob/a2ad05181e133f4981fc1d8a2c46811069af4d25/packages/pdf/src/html/web-page.tsx). It runs on Node 22 and has no additional runtime package requirements. The JavaScript bundle and dependency licenses are checked into `src/vendor/`.

To rebuild from this plugin directory, use Node 24 and pnpm 12.18.0 for the upstream install.

```sh
git clone --branch v6.1.1 --depth 1 https://github.com/reactive-resume/reactive-resume.git ../reactive-resume-v6.1.1
pnpm --dir ../reactive-resume-v6.1.1 install --frozen-lockfile
node vendor/reactive-resume-renderer/build.mjs ../reactive-resume-v6.1.1
```

The template gallery uses screenshots of one fictional résumé rendered locally with each template. To regenerate `client/template-gallery-previews.json`, use a local Playwright installation with Chromium, CJK system fonts, and `cwebp` on the build machine.

```sh
node vendor/reactive-resume-renderer/build-thumbnails.mjs
```

If Playwright is installed in a separate checkout, pass the path to its entry module. Pass a Chromium executable as the second argument to use an existing browser installation.
