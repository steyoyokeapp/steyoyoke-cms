export async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, operation: (value: T, index: number) => Promise<R>) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  async function worker() {
    while (nextIndex < values.length && !failed) {
      const index = nextIndex++;
      try { results[index] = await operation(values[index]!, index); }
      catch (error) { failed = true; failure = error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (failed) throw failure;
  return results;
}
