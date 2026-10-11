// A CommonJS module that requires two others: its patch of `fetch` goes through both.
var wrap = require('./wrap.cjs')
var root = require('./root.cjs')

module.exports = function patchFetch() {
  wrap(root, 'fetch', function (original, args) {
    return original.apply(this, args)
  })
}
