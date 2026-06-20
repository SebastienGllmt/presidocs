// Idle-fallback scheduling shared by the lazy boot loaders (narratorLoader,
// commentsLoader): run `cb` when the main thread goes idle so a passive reader
// who never interacts still gets the deferred chunk mounted — bounded, but long
// enough not to pre-empt the engagement triggers on a fast load. Uses
// `requestIdleCallback` where available, else a timer; returns a handle the
// caller cancels (via `cancelIdle`) when an engagement trigger wins the race.

export function scheduleIdle(cb: () => void): number {
  if (typeof requestIdleCallback === "function") {
    return requestIdleCallback(cb, { timeout: 4000 });
  }
  return setTimeout(cb, 2500) as unknown as number;
}

export function cancelIdle(handle: number): void {
  if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
  else clearTimeout(handle);
}
