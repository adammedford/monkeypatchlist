# Shadowing writes name the object written, not the inherited native

A write like `window.addEventListener = w` or `history.pushState = w` creates an own property that shadows an inherited native (`EventTarget.prototype.addEventListener`, `History.prototype.pushState`). Its target is the written object's member (`Window.addEventListener`, `history.pushState`), and it carries a `shadows` field derived from the native catalog that is not part of identity. The two writes reach very different amounts of code. single-spa's `window.addEventListener` affects listeners on `window` only, while zone.js's `EventTarget.prototype.addEventListener` affects every node and document. Naming both after the inherited native would merge them, and a library that widened from one to the other would show no change in its target. The runtime ground truth already names these writes the same way.

## Consequences

- Shadowing targets are derived, not enumerated in the catalog. A target is valid when its member resolves along the written object's IDL chain.
- The protected surface still matches a shadowing write through its `shadows` member, keyed on (interface, member).
- A holder chosen at runtime (`hasOwnProperty(history, m) ? history : History.prototype`, or prototype walks) is decided against the unmutated catalog, so one write still yields one target.
