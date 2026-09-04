/**
 * Append a transfer item so conversation history stays oldest-first.
 * The newest item is therefore rendered at the bottom of the list.
 */
export function appendTransferItem<T>(items: T[], item: T): T[] {
  return [...items, item];
}
