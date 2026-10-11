// Fixture pages expected to fail until the ticket that implements their feature lands. That ticket removes the page's
// marker: a marked page that passes fails the check, so a marker never outlives its feature. Build-time only.

/** Page name → the ticket that implements what the page needs. */
export const expectedToFail: Readonly<Record<string, string>> = {}
