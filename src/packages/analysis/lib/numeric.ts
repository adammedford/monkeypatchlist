// Numeric folding (Principle 2, §5 Resolver capabilities 1): the unary and binary operators on primitive constants, as
// ECMA-262 defines them. The operation itself is JavaScript's own, so its result, and whether it throws, are the
// engine's. Two guards come first, because a BigInt can be far too large to compute:
//
// - A BigInt result whose decimal string would pass the `fold-length` cap is `too-long`, judged from the operands' bit
//   lengths before it is computed (`10n ** 2000000n`), or from its own once it is (§5, §18).
// - A BigInt result over V8's own limit, 2^30 bits, makes Chromium throw a RangeError, so it `throws` (Principle 1).
//
// A BigInt literal is bounded by its source, so only an operator's result is judged.

import type { Primitive } from './global-object.ts'

/** What an operation on constants gives: its value, or that it throws, or that its value passes the `fold-length` cap. */
export type Outcome = { value: Primitive } | 'throws' | 'too-long'

/** The unary operators that convert their operand to a numeric value (ECMA-262 13.5). */
export const numericUnary: ReadonlySet<string> = new Set(['-', '+', '~'])

/**
 * The binary operators that convert both operands to numeric values (ECMA-262 ApplyStringOrNumericBinaryOperator),
 * besides `+`, which concatenates when either operand is a string.
 */
export const numericBinary: ReadonlySet<string> = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'])

/** V8's largest BigInt, in bits (`BigInt::kMaxLengthBits`): a result past it throws a RangeError. */
const maxBigIntBits = 2 ** 30

const log10Of2 = Math.log10(2)

/** `op value` for one of `numericUnary`. */
export function unaryOperation(op: string, value: Primitive, maxLength: number): Outcome {
  const numeric = toNumeric(value)
  if (numeric === 'throws') return 'throws'
  // Unary `+` is ToNumber, which a BigInt throws on.
  if (op === '+') return typeof numeric === 'bigint' ? 'throws' : { value: numeric }
  if (typeof numeric === 'number') return { value: op === '-' ? -numeric : ~numeric }
  return judged(op === '-' ? -numeric : ~numeric, maxLength)
}

/** `a op b` for `+` or one of `numericBinary`. */
export function binaryOperation(op: string, a: Primitive, b: Primitive, maxLength: number): Outcome {
  if (op === '+') {
    // ToPrimitive of a primitive is itself. A symbol throws in ToString and in ToNumeric alike.
    if (typeof a === 'symbol' || typeof b === 'symbol') return 'throws'
    if (typeof a === 'string' || typeof b === 'string') return { value: String(a) + String(b) }
  }
  const x = toNumeric(a)
  const y = toNumeric(b)
  if (x === 'throws' || y === 'throws') return 'throws'
  // Mixing a BigInt and a Number is a TypeError.
  if (typeof x !== typeof y) return 'throws'
  if (typeof x === 'number') return { value: numberOperation(op, x, y as number) }
  return bigintOperation(op, x, y as bigint, maxLength)
}

/** ECMA-262 ToNumeric of a primitive: a BigInt stays one, a symbol throws, and anything else is ToNumber'd. */
function toNumeric(value: Primitive): number | bigint | 'throws' {
  if (typeof value === 'bigint') return value
  if (typeof value === 'symbol') return 'throws'
  return Number(value)
}

function numberOperation(op: string, x: number, y: number): number {
  switch (op) {
    case '+':
      return x + y
    case '-':
      return x - y
    case '*':
      return x * y
    case '/':
      return x / y
    case '%':
      return x % y
    case '**':
      return x ** y
    case '&':
      return x & y
    case '|':
      return x | y
    case '^':
      return x ^ y
    case '<<':
      return x << y
    case '>>':
      return x >> y
    default:
      return x >>> y
  }
}

/**
 * A BigInt operation. One that can grow its result past what the operands' sizes show (`*`, `**`, `<<`, a `>>` by a
 * negative amount) is judged from bit lengths first.
 */
function bigintOperation(op: string, x: bigint, y: bigint, maxLength: number): Outcome {
  const before = beforeComputing(op, x, y, maxLength)
  if (before !== undefined) return before
  let value: bigint
  try {
    value = computed(op, x, y)
  } catch {
    // `/` or `%` by zero, a negative exponent, or `>>>`, which BigInts don't have.
    return 'throws'
  }
  return judged(value, maxLength)
}

function computed(op: string, x: bigint, y: bigint): bigint {
  switch (op) {
    case '+':
      return x + y
    case '-':
      return x - y
    case '*':
      return x * y
    case '/':
      return x / y
    case '%':
      return x % y
    case '**':
      return x ** y
    case '&':
      return x & y
    case '|':
      return x | y
    case '^':
      return x ^ y
    case '<<':
      return x << y
    case '>>':
      return x >> y
    default:
      // `>>>` throws a TypeError on BigInts.
      throw new TypeError('BigInts have no unsigned right shift')
  }
}

/**
 * What a growing BigInt operation gives before it is computed: `throws` when its result's bit length is surely past
 * V8's limit, `too-long` when its decimal string surely passes the cap, and undefined when it is small enough to compute.
 * `bits` is the least bit length the result can have.
 */
function beforeComputing(op: string, x: bigint, y: bigint, maxLength: number): Outcome | undefined {
  const bits = leastBits(op, x, y)
  if (bits === undefined) return undefined
  if (bits > maxBigIntBits) return 'throws'
  return leastDigits(bits) > maxLength ? 'too-long' : undefined
}

/** The least bit length the result of a growing operation can have, or undefined when it can't grow much. */
function leastBits(op: string, x: bigint, y: bigint): number | undefined {
  switch (op) {
    case '*':
      return x === 0n || y === 0n ? undefined : bitLength(x) + bitLength(y) - 1
    case '**': {
      // A negative exponent throws, and a base of 0, 1 or -1 stays small.
      if (y <= 0n || x === 0n || x === 1n || x === -1n) return undefined
      // V8 refuses an exponent of 2^30 or more for any other base, whatever the result's size.
      if (y >= BigInt(maxBigIntBits)) return Infinity
      const exponent = Number(y)
      const magnitude = x < 0n ? -x : x
      // A power of 2, 2^k, gives exactly k * y + 1 bits.
      if ((magnitude & (magnitude - 1n)) === 0n) return (bitLength(magnitude) - 1) * exponent + 1
      // Any other |x| ** y has floor(y * log2|x|) + 1 bits. The estimate's floating-point error is below a relative
      // 1e-14, so lowering it by a relative 1e-12 keeps it from rising past the exact count.
      const estimate = exponent * log2(x)
      return Math.floor(estimate * (1 - 1e-12)) + 1
    }
    case '<<':
    case '>>': {
      const shift = op === '<<' ? y : -y
      if (shift <= 0n || x === 0n) return undefined
      // Exactly, since shifting left multiplies by a power of 2.
      return bitLength(x) + Number(shift)
    }
    default:
      return undefined
  }
}

/** A computed BigInt: `too-long` when its decimal string passes the cap, else its value. */
function judged(value: bigint, maxLength: number): Outcome {
  const bits = bitLength(value)
  // A string that surely fits, sign included, isn't made.
  if (mostDigits(bits) + 1 <= maxLength) return { value }
  if (leastDigits(bits) > maxLength) return 'too-long'
  return String(value).length > maxLength ? 'too-long' : { value }
}

/** The bit length of |x|: 0 for 0n. */
function bitLength(x: bigint): number {
  if (x === 0n) return 0
  const hex = (x < 0n ? -x : x).toString(16)
  return (hex.length - 1) * 4 + Number.parseInt(hex[0]!, 16).toString(2).length
}

/** log2 |x| of a BigInt other than 0, from its leading 52 bits. */
function log2(x: bigint): number {
  const bits = bitLength(x)
  const magnitude = x < 0n ? -x : x
  const shift = Math.max(0, bits - 53)
  return shift + Math.log2(Number(magnitude >> BigInt(shift)))
}

/**
 * The fewest and most decimal digits a number of `bits` bits can have: |x| is in [2^(bits-1), 2^bits). The margin keeps
 * floating-point error from deciding either bound wrongly, so a result between them is measured.
 */
const margin = 1e-6
function leastDigits(bits: number): number {
  return bits === 0 ? 1 : Math.floor((bits - 1) * log10Of2 - margin) + 1
}
function mostDigits(bits: number): number {
  return bits === 0 ? 1 : Math.floor(bits * log10Of2 + margin) + 1
}
