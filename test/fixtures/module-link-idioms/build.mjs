// Rebuilds this directory's fixture builds from `app/` with the validation corpus's pinned bundlers, configured as the
// corpus builds them (the corpus's `scripts/build.mjs`), minus source maps:
//
//   node test/fixtures/module-link-idioms/build.mjs
//
// It needs the corpus's `npm ci`. The outputs are committed, so tests never run a bundler.

import { createRequire } from 'node:module'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const corpus = join(here, '../../../corpus')
const load = async (name) => import(createRequire(join(corpus, 'package.json')).resolve(name))
const app = join(here, 'app')
const html = (script) => `<!doctype html><html><body>${script}</body></html>\n`

const bundlers = {
  async esbuild(out) {
    const esbuild = await load('esbuild')
    const result = await esbuild.build({
      absWorkingDir: app,
      entryPoints: { main: 'index.js' },
      bundle: true, minify: true, format: 'iife', metafile: true,
      entryNames: '[name]', outdir: out, logLevel: 'error', legalComments: 'none', tsconfigRaw: {},
    })
    const js = Object.keys(result.metafile.outputs).find((file) => file.endsWith('.js'))
    await writeFile(join(out, 'index.html'), html(`<script src="./${relative(out, join(app, js))}"></script>`))
  },
  async rollup(out) {
    const { rollup } = await load('rollup')
    const plugin = async (name) => (await load(name)).default
    const bundle = await rollup({
      input: { main: join(app, 'index.js') },
      plugins: [(await plugin('@rollup/plugin-node-resolve'))({ browser: true }), (await plugin('@rollup/plugin-commonjs'))(), (await plugin('@rollup/plugin-terser'))()],
      onwarn: () => {},
    })
    const { output } = await bundle.write({ dir: out, format: 'es', entryFileNames: '[name].js', chunkFileNames: '[name].js' })
    await bundle.close()
    const entry = output.find((each) => each.type === 'chunk' && each.isEntry)
    await writeFile(join(out, 'index.html'), html(`<script type="module" src="./${entry.fileName}"></script>`))
  },
  async vite(out) {
    const { build } = await load('vite')
    const index = join(app, 'index.html')
    await writeFile(index, html('<script type="module" src="./index.js"></script>'))
    try {
      await build({
        root: app, configFile: false, logLevel: 'error', base: './',
        build: { outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name].js' } } },
      })
    } finally {
      await rm(index)
    }
  },
}

for (const [name, run] of Object.entries(bundlers)) {
  const out = join(here, name)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  await run(out)
  console.log(name, (await readdir(out, { recursive: true })).sort().join(' '))
}
