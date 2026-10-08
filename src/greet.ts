/** A pure greeting formatter. `greet` takes a name and returns `` `Hello, ${name}!` ``,
 * doing no I/O and no validation — name validity is the caller's job, not a pure
 * formatter's. */
export function greet(name: string): string {
  return `Hello, ${name}!`
}
