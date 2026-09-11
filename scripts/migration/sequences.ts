import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

export function monotonicNextValue(importedMax: number, targetMax: number, sequenceLastValue: number, isCalled: boolean) {
  const currentNext = isCalled ? sequenceLastValue + 1 : sequenceLastValue;
  return Math.max(importedMax + 1, targetMax + 1, currentNext);
}

async function finalize(db: Prisma.TransactionClient, sequence: string, importedMax: number, targetMax: number) {
  const [state] = await db.$queryRawUnsafe<Array<{ last_value: bigint; is_called: boolean }>>(`SELECT last_value, is_called FROM ${sequence}`);
  if (!state) throw new Error(`Sequence ${sequence} is unavailable.`);
  const next = monotonicNextValue(importedMax, targetMax, Number(state.last_value), state.is_called);
  await db.$executeRawUnsafe(`SELECT setval('${sequence}', ${next}, false)`);
  return next;
}

export async function finalizeLegacySequences(db: PrismaClient, maxima: { artist: number; content: number; release: number }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936502001)`;
    const [artist, track, podcast, release] = await Promise.all([
      tx.artist.aggregate({ _max: { legacyId: true } }), tx.track.aggregate({ _max: { legacyId: true } }),
      tx.podcastEpisode.aggregate({ _max: { legacyId: true } }), tx.release.aggregate({ _max: { legacyId: true } }),
    ]);
    return {
      artistNext: await finalize(tx, "legacy_artist_id_seq", maxima.artist, artist._max.legacyId ?? 0),
      trackNext: await finalize(tx, "legacy_track_id_seq", maxima.content, Math.max(track._max.legacyId ?? 0, podcast._max.legacyId ?? 0)),
      releaseNext: await finalize(tx, "legacy_release_id_seq", maxima.release, release._max.legacyId ?? 0),
    };
  });
}
