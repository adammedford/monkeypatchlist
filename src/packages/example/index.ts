import { greeting } from './lib/impl.ts'

/** Greets `name`, or the world when `name` is blank. A starter entry point: copy this package or delete it. */
export function greet(name: string): string {
  return greeting(name.trim() || 'world')
}
