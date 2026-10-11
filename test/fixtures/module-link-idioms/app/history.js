// An ES module loaded with a dynamic import.
import wrap from './wrap.cjs'

export function patchHistory() {
  wrap(History.prototype, 'pushState', function (original, args) {
    return original.apply(this, args)
  })
}
