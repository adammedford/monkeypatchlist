// The entry: default imports of CommonJS modules (interop), a namespace object passed on as a value, and a dynamic
// import of an ES module.
import wrap from './wrap.cjs'
import patchFetch from './fetch.cjs'
import * as xhr from './xhr.js'

function patchXhr(module) {
  wrap(module.prototype, module.method(), function (original, args) {
    return original.apply(this, args)
  })
}

patchFetch()
patchXhr(xhr)
import('./history.js').then(function (module) {
  module.patchHistory()
})
