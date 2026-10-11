// Small webpack 5 outputs for fixture builds (§6 idiom 6): an entry bundle with its runtime and JSONP chunk loader, and
// a chunk that pushes into the loader's registry.

export interface WebpackEntryOptions {
  /** The registry's name. */
  registry?: string
  /** The public path statement, `n.p="/"` by default. Empty for none. */
  publicPath?: string
  /**
   * How the loader loads a chunk's URL `s`: a script element (`element`, by default), `importScripts` (a worker's
   * runtime), `import()`, or a script element that webpack 5's script-loading helper `n.l(url, done, key, chunkId)`
   * creates (`helper`), with the URL and chunk id as its parameters.
   */
  load?: 'element' | 'import-scripts' | 'import' | 'helper'
  /**
   * With `load: 'helper'`, the integrity value the helper sets on each chunk's script element, by chunk id, from a
   * constant table, as New Relic's runtime does (`u[a]&&(o.integrity=u[a])`).
   */
  integrity?: Record<string, string>
}

/**
 * A webpack 5 entry bundle, minified as webpack emits it: its factory table, the require function and its runtime
 * (`n.d`, `n.o`, the chunk loader `n.e` with its URL function `n.u` over the id table `chunks`, and the JSONP chunk
 * registry `self[name]`, whose `push` the runtime overrides), then the entry code.
 */
export function webpackEntry(
  modules: Record<string, string>,
  chunks: Record<string, string>,
  entry: string,
  { registry = 'webpackChunkapp', publicPath = 'n.p="/",', load = 'element', integrity = {} }: WebpackEntryOptions = {},
): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  const names = Object.entries(chunks).map(([id, file]) => `${id}:"${file}"`).join(',')
  const hashes = Object.keys(chunks).map((id) => `${id}:"0123abcd"`).join(',')
  const loading = {
    element: 'var s=n.p+n.u(t),a=document.createElement("script");a.src=s,document.head.appendChild(a)',
    'import-scripts': 'importScripts(n.p+n.u(t))',
    import: 'import(n.p+n.u(t))',
    helper: 'var s=n.p+n.u(t);n.l(s,()=>{},"chunk-"+t,t)',
  }[load]
  const sri = Object.entries(integrity).map(([id, value]) => `${id}:${JSON.stringify(value)}`).join(',')
  const helper =
    load === 'helper'
      ? `n.l=(e,i,s,a)=>{let o;var u={${sri}};o=document.createElement("script"),o.charset="utf-8",o.src=e,` +
        'u[a]&&(o.integrity=u[a]),o.onload=i,document.head.appendChild(o)},'
      : ''
  return (
    `(()=>{"use strict";var t={${table}},r={};` +
    'function n(e){var o=r[e];if(void 0!==o)return o.exports;var i=r[e]={exports:{}};return t[e](i,i.exports,n),i.exports}' +
    'n.m=t,n.d=(t,e)=>{for(var r in e)n.o(e,r)&&!n.o(t,r)&&Object.defineProperty(t,r,{enumerable:!0,get:e[r]})},' +
    'n.o=(t,e)=>Object.prototype.hasOwnProperty.call(t,e),n.f={},' +
    'n.e=e=>Promise.all(Object.keys(n.f).reduce((t,r)=>(n.f[r](e,t),t),[])),' +
    `n.u=e=>({${names}}[e]+"."+{${hashes}}[e]+".js"),${helper}${publicPath}` +
    '(()=>{var e={792:0};n.f.j=(t,r)=>{var o=n.o(e,t)?e[t]:void 0;if(0!==o)if(o)r.push(o[2]);else{var i=new Promise((r,i)=>o=e[t]=[r,i]);' +
    `r.push(o[2]=i);${loading}}};` +
    'const o=(t,r)=>{let[i,s,a]=r;var c,d,u=0;if(i.some(t=>0!==e[t])){for(c in s)n.o(s,c)&&(n.m[c]=s[c]);a&&a(n)}' +
    'for(t&&t(r);u<i.length;u++)d=i[u],n.o(e,d)&&e[d]&&e[d][0](),e[d]=0},' +
    `l=self.${registry}=self.${registry}||[];l.forEach(o.bind(null,0)),l.push=o.bind(null,l.push.bind(l))})();` +
    `${entry}})();`
  )
}

/** A webpack 5 JSONP chunk: it pushes its chunk ids and factories into the registry `self[name]`. */
export function webpackChunk(ids: string[], modules: Record<string, string>, registry = 'webpackChunkapp'): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  return `"use strict";(self.${registry}=self.${registry}||[]).push([[${ids.join(',')}],{${table}}]);`
}

/**
 * A webpack 5 entry bundle in the ESM chunk format, minified as webpack emits it (Datadog's CDN build): its runtime loads
 * each chunk with `import("./" + n.u(id))`, whose URL function maps the chunk ids of `chunks` to `chunks/<id>-<hash>.js`,
 * and installs the module table the chunk exports into its own (`__webpack_esm_ids__`, `__webpack_esm_modules__`).
 */
export function webpackEsmEntry(modules: Record<string, string>, chunks: Record<string, string>, entry: string): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  const hashes = Object.entries(chunks).map(([id, hash]) => `${id}:"${hash}"`).join(',')
  return (
    `(()=>{"use strict";var t={${table}},r={};` +
    'function n(e){var o=r[e];if(void 0!==o)return o.exports;var i=r[e]={exports:{}};return t[e](i,i.exports,n),i.exports}' +
    'n.m=t,n.d=(t,e)=>{for(var r in e)n.o(e,r)&&!n.o(t,r)&&Object.defineProperty(t,r,{enumerable:!0,get:e[r]})},' +
    'n.o=(t,e)=>Object.prototype.hasOwnProperty.call(t,e),n.f={},n.e=t=>{const e=[];return n.f.j(t,e),Promise.all(e)},' +
    `n.u=t=>"chunks/"+t+"-"+{${hashes}}[t]+".js",` +
    '(()=>{const t={main:0},e=e=>{let{__webpack_esm_ids__:r,__webpack_esm_modules__:o,__webpack_esm_runtime__:i}=e;' +
    'var s,a,c=0;for(s in o)n.o(o,s)&&(n.m[s]=o[s]);for(i&&i(n);c<r.length;c++)a=r[c],n.o(t,a)&&t[a]&&t[a][0](),t[a]=0};' +
    'n.f.j=(r,o)=>{let i=n.o(t,r)?t[r]:void 0;if(0!==i)if(i)o.push(i[1]);else{let s=import("./"+n.u(r)).then(e,e=>{throw' +
    ' 0!==t[r]&&(t[r]=void 0),e});s=Promise.race([s,new Promise(e=>i=t[r]=[e])]),o.push(i[1]=s)}}})();' +
    `${entry}})();`
  )
}

/** A webpack 5 chunk in the ESM chunk format: it exports its chunk ids and its module table. */
export function webpackEsmChunk(ids: string[], modules: Record<string, string>): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  return `export const __webpack_esm_ids__=${JSON.stringify(ids)};export const __webpack_esm_modules__={${table}};`
}
