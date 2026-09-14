// Incremental hashing bounds browser memory even for multi-gigabyte masters.
export async function hashUpload(file: Blob, signal: AbortSignal) {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const hash = sha256.create(); const chunkBytes = 4 * 1024 * 1024;
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      signal.throwIfAborted(); hash.update(new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer()));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted(); return Array.from(hash.digest(), b => b.toString(16).padStart(2, "0")).join("");
  } finally { hash.destroy(); }
}
