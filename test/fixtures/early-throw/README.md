Builds of one module, made with the validation corpus's pinned bundlers (`corpus/node_modules`): esbuild (`bundle`, `minify`, `format: esm`), Rollup (`format: es`), webpack (`mode: production`) and Vite (`vite build`), to check that a module's top-level early `throw` under `typeof global` guards its write in each bundler's output (`test/reachability-guards.test.ts`).

```js
if (typeof global === "undefined") throw new Error("needs global");
global.fetch = function w() { return 1 };
export {};
```
