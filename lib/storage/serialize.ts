import { StorageError } from "./types";

/**
 * JSON that survives `Date`.
 *
 * Plain `JSON.stringify(new Date())` produces an ISO string, and `JSON.parse`
 * gives that string back — so a naive round trip silently changes the type of
 * every date field. Tracking data is full of them (watched-at, added-at), and
 * the failure is quiet: `.getTime()` throws only later, somewhere else.
 *
 * THE TRAP, and why the replacer below is a `function` and not an arrow:
 * `JSON.stringify` calls `Date.prototype.toJSON()` on a value *before* handing
 * it to the replacer. By then `value` is already a string and `instanceof Date`
 * is false. The only way to see the original is `this[key]` — the replacer is
 * invoked with `this` bound to the holding object, which an arrow function
 * would not receive. Rewriting this as an arrow silently breaks date support
 * and every test that doesn't specifically check types will still pass.
 */

/** Distinctive enough that real content data will not collide with it. */
const DATE_TAG = "__mq_date";

interface DateEnvelope {
  [DATE_TAG]: string;
}

function isDateEnvelope(value: unknown): value is DateEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[DATE_TAG] === "string"
  );
}

export function encode(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      function (this: unknown, key: string, alreadyStringified: unknown) {
        // `this` is the object holding `key`. For the root, JSON.stringify
        // uses a synthetic holder `{ "": value }`, so this works at every
        // depth including the top level.
        const original = (this as Record<string, unknown>)[key];

        if (original instanceof Date) {
          if (Number.isNaN(original.getTime())) {
            throw new StorageError(
              "serialization",
              `Cannot store an Invalid Date at key "${key}".`,
            );
          }
          return { [DATE_TAG]: original.toISOString() };
        }

        // Everything else passes through as stringify already computed it,
        // which correctly honours custom toJSON further down the tree.
        return alreadyStringified;
      },
    );
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    // Circular references and BigInt both land here.
    throw new StorageError(
      "serialization",
      "Value could not be serialized for storage.",
      { cause },
    );
  }
}

export function decode<T>(text: string): T {
  try {
    return JSON.parse(text, (_key, value: unknown) => {
      if (isDateEnvelope(value)) {
        const restored = new Date(value[DATE_TAG]);
        if (Number.isNaN(restored.getTime())) {
          throw new StorageError(
            "serialization",
            "Stored value contains an unparseable date.",
          );
        }
        return restored;
      }
      return value;
    }) as T;
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError(
      "serialization",
      "Stored value could not be parsed.",
      { cause },
    );
  }
}
