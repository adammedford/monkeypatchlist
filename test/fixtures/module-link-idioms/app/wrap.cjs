// A CommonJS patch helper: replaces `holder[name]` with a wrapper that calls `wrapper(original, args)`.
module.exports = function wrap(holder, name, wrapper) {
  var original = holder[name]
  holder[name] = function () {
    return wrapper.call(this, original, arguments)
  }
}
