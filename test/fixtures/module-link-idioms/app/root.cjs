// A CommonJS module whose exports are the global object.
module.exports = typeof window === 'object' ? window : globalThis
