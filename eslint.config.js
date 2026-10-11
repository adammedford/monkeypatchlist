import { builtinModules } from 'node:module'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// The runtime reads the committed catalog as data. It never reaches the generator's upstream inputs or the generator
// itself (§19).
const runtimeImports = {
  paths: [
    { name: '@webref/idl', message: 'Only the catalog generator reads @webref/idl.' },
    { name: 'webidl2', message: 'Only the catalog generator parses Web IDL.' },
    { name: '@tc39/ecma262-biblio', message: 'Only the catalog generator reads ECMA-262.' },
    { name: '@tc39/ecma402-biblio', message: 'Only the catalog generator reads ECMA-402.' },
    { name: 'ses', message: 'Only the catalog cross-check reads SES permits.' },
    { name: '@mdn/browser-compat-data', message: 'Only the catalog cross-check reads BCD.' },
  ],
  patterns: [{ group: ['**/tools/**'], message: 'The runtime never imports build-time tools.' }],
}

// §19 Invariants: every module after the source store is a pure function of its inputs. None reads the clock, the
// environment, the filesystem or the network; wall-clock data reaches only the report's `run` block, from the source
// store and the CLI. test/purity.test.ts shows the rules below cover each of these modules.
const pureModules = [
  'discovery',
  'analysis',
  'attribution',
  'confidence',
  'findings',
  'compare',
  'policy',
  'completeness',
  'baseline',
  'report',
]
const purity = 'Modules after the source store are pure (§19 Invariants): pass the data in instead.'

// The Node built-ins a pure module may import: path arithmetic, text, buffers and assertions. `node:crypto` is allowed
// for `createHash` alone (below). Every other built-in, including ones Node adds later, can reach the clock, the
// environment, the filesystem, the network or the module loader (`node:module`'s `createRequire`).
const pureBuiltins = ['path', 'path/posix', 'util', 'util/types', 'buffer', 'string_decoder', 'assert', 'assert/strict']
const allowedBuiltins = ['crypto', ...pureBuiltins]
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const unprefixedImpureBuiltins = builtinModules.filter(
  (name) => !name.startsWith('node:') && !allowedBuiltins.includes(name),
)

const pureRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        ...runtimeImports.paths,
        // Hashing is pure; random bytes and UUIDs are not.
        { name: 'node:crypto', allowImportNames: ['createHash'], message: purity },
        { name: 'crypto', allowImportNames: ['createHash'], message: purity },
      ],
      patterns: [
        ...runtimeImports.patterns,
        { regex: `^node:(?!(${allowedBuiltins.map(escapeRegex).join('|')})$)`, message: purity },
        { regex: `^(${unprefixedImpureBuiltins.map(escapeRegex).join('|')})$`, message: purity },
        // The repository's own readers: the catalog and config loaders read the filesystem, and the source store
        // reads bytes. Their types and pure values (`realms`, `surfaces`, `UsageError`) stay importable.
        { regex: '\\.ts$', importNames: ['loadCatalog', 'loadConfig', 'createSourceStore'], message: purity },
      ],
    },
  ],
  'no-restricted-globals': [
    'error',
    ...['process', 'Date', 'performance', 'fetch', 'crypto', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map(
      (name) => ({ name, message: purity }),
    ),
    ...['setTimeout', 'setInterval', 'setImmediate'].map((name) => ({ name, message: purity })),
    // The host's locale and hardware are environment.
    ...['Intl', 'navigator'].map((name) => ({ name, message: purity })),
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: purity },
    ...['process', 'Date', 'performance', 'fetch', 'crypto', 'Intl', 'navigator'].map((property) => ({
      object: 'globalThis',
      property,
      message: purity,
    })),
  ],
  'no-restricted-syntax': [
    'error',
    { selector: 'ImportExpression', message: purity },
    // `import.meta` names where the module sits on disk.
    { selector: "MetaProperty[meta.name='import']", message: purity },
    // Locale-sensitive comparison and formatting depend on the host's locale.
    {
      selector: 'CallExpression > MemberExpression.callee[property.name=/^(localeCompare|toLocale[A-Za-z]*)$/]',
      message: purity,
    },
  ],
}

export default tseslint.config(
  // Fixture builds are bundler output, and their apps' sources are browser and CommonJS code, not the repository's;
  // so is the validation corpus that `npm run corpus:fetch` checks out in `corpus/`.
  { ignores: ['dist/', '.scratch/', 'corpus/', 'docs/examples/', 'test/fixtures/*/app/', 'test/fixtures/*/{esbuild,rollup,vite,webpack}/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['src/**'],
    rules: { 'no-restricted-imports': ['error', runtimeImports] },
  },
  {
    files: pureModules.map((name) => `src/packages/${name}/**`),
    ignores: pureModules.map((name) => `src/packages/${name}/tests/**`),
    rules: pureRules,
  },
)
