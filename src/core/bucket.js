// The steps a doc's buddies have to wake each other (docs/architecture.md,
// When a buddy runs): a bucket that holds `cap`, gains one every `every` ms
// (0: none), and is filled on Refill. Each function takes the bucket and the
// time (performance.now()) and returns a new one: { left (null: full), cap,
// every, at (when it last gained one, or was full) }.

/** The bucket as `cap` and `every` make it at `now`, with the steps gained since. */
export function refilled(bucket, { cap, every }, now) {
  const left = Math.min(bucket.left ?? cap, cap);
  if (left >= cap || !every) return { left, cap, every, at: now };
  const gained = Math.floor((now - bucket.at) / every);
  const more = Math.min(cap, left + gained);
  return { left: more, cap, every, at: more >= cap ? now : bucket.at + gained * every };
}

/** Take a step at `now`: { ok, bucket }, ok false and the bucket as it was when none is left. */
export function take(bucket, now) {
  const left = bucket.left ?? bucket.cap;
  if (left < 1) return { ok: false, bucket };
  return { ok: true, bucket: { ...bucket, left: left - 1, at: left >= bucket.cap ? now : bucket.at } };
}

/** The bucket filled at `now`. */
export const filled = (bucket, now) => ({ ...bucket, left: bucket.cap, at: now });

/** When the next step comes, or null: full, or none come on their own. */
export function nextStepAt(bucket) {
  return bucket.left !== null && bucket.left < bucket.cap && bucket.every ? bucket.at + bucket.every : null;
}
