import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { StorageProvider } from "@/modules/media/storage";
import { executeImport } from "../../scripts/migration/importer";
import { generateRollbackManifest } from "../../scripts/migration/rollback";
import { MigrationConflictError } from "../../scripts/migration/ownership";
import { buildMigrationPlan } from "../../scripts/migration/plan";
import { APPROVED_SOURCE_SHA256, MIGRATION_ACTOR, migrationRunId } from "../../scripts/migration/safety";
import { stableUuid } from "../../scripts/migration/identity";

class MemoryStorage implements StorageProvider {
  readonly kind = "LOCAL" as const;
  files = new Map<string, Buffer>();
  failNextPut = false;
  async put(key: string, bytes: Buffer) { if (this.failNextPut) { this.failNextPut = false; throw new Error("injected source failure"); } if (this.files.has(key)) throw new Error("immutable collision"); this.files.set(key, bytes); }
  async read(key: string) { const value = this.files.get(key); if (!value) throw new Error("missing"); return value; }
  async exists(key: string) { return this.files.has(key); }
  async delete(key: string) { this.files.delete(key); }
}

const sample = { artists: [4], tracks: [1329], podcasts: [1283], releases: [47] };

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "migration_records", "migration_issues", "migration_runs", "media_audit_logs", "media_processing_jobs", "media_variants", "media_assets", "release_audit_logs", "release_revision_tracks", "release_revisions", "release_tracks", "releases", "podcast_audit_logs", "podcast_chapter_revisions", "podcast_episode_revisions", "podcast_chapters", "podcast_episodes", "track_audit_logs", "track_revisions", "tracks", "audit_logs", "artist_revisions", "artists", "accounts", "sessions", "verifications", "users", "labels" RESTART IDENTITY CASCADE');
});
afterAll(async () => prisma.$disconnect());

describe("production-safe migration orchestration", () => {
  it("imports the sample through async media, resumes catalogue publication, and reruns idempotently", async () => {
    const storage = new MemoryStorage();
    const first = await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    expect(first.summary.imported).toMatchObject({ artists: 1, tracks: 1, podcasts: 1, releases: 1, releaseTracks: 1, podcastChapters: 10, imageAssets: 3, historicalAudioReferences: 2, revisions: 4, releaseRevisionTracks: 1 });
    expect(await prisma.mediaAsset.count({ where: { kind: "IMAGE", status: "READY" } })).toBe(3);
    expect(await prisma.mediaVariant.count()).toBe(18);
    expect(await prisma.mediaProcessingJob.count({ where: { status: "COMPLETED" } })).toBe(3);
    expect(await prisma.mediaAsset.count({ where: { kind: "AUDIO", provider: "LEGACY_EXTERNAL", status: "EXTERNAL" } })).toBe(2);
    expect(storage.files.size).toBe(21);

    await prisma.podcastEpisode.update({ where: { legacyId: 1283 }, data: { status: "DRAFT", publishedRevisionId: null } });
    const second = await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    expect(second.runId).toBe(first.runId);
    expect(await prisma.podcastEpisode.findUnique({ where: { legacyId: 1283 } })).toMatchObject({ status: "PUBLISHED" });
    expect(await prisma.artist.count()).toBe(1); expect(await prisma.track.count()).toBe(1); expect(await prisma.podcastEpisode.count()).toBe(1); expect(await prisma.release.count()).toBe(1);
    expect(await prisma.mediaAsset.count()).toBe(5); expect(await prisma.mediaVariant.count()).toBe(18); expect(await prisma.mediaProcessingJob.count()).toBe(3);

    const rollback = await generateRollbackManifest(prisma, first.runId);
    expect(rollback.executable).toBe(false);
    expect(rollback.owned).toMatchObject({ artists: expect.any(Array), tracks: expect.any(Array), podcasts: expect.any(Array), releases: expect.any(Array) });
    expect(rollback.owned.podcastChapters).toHaveLength(10); expect(rollback.owned.podcastRevisionChapters).toHaveLength(10);
    expect(rollback.owned.releaseTracks).toHaveLength(1); expect(rollback.owned.releaseRevisionTracks).toHaveLength(1);
    expect(rollback.owned.mediaAssets).toHaveLength(5); expect(rollback.owned.mediaVariants).toHaveLength(18); expect(rollback.owned.mediaProcessingJobs).toHaveLength(3); expect(rollback.owned.storageKeys).toHaveLength(21);
  });

  it("resumes after a source-storage failure without duplicating the MediaAsset", async () => {
    const storage = new MemoryStorage(); storage.failNextPut = true;
    await expect(executeImport(process.env.DATABASE_URL!, storage, null, sample)).rejects.toThrow("injected source failure");
    expect(await prisma.mediaAsset.count({ where: { kind: "IMAGE", status: "PROCESSING" } })).toBe(1);
    const result = await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    expect(result.summary.imported.imageAssets).toBe(3);
    expect(await prisma.mediaAsset.count({ where: { kind: "IMAGE", status: "READY" } })).toBe(3);
    expect(await prisma.mediaAsset.count()).toBe(5);
  });

  it("fails loudly rather than adopting a conflicting legacy record", async () => {
    const storage = new MemoryStorage(); await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    await prisma.track.update({ where: { legacyId: 1329 }, data: { title: "Conflicting production title" } });
    await expect(executeImport(process.env.DATABASE_URL!, storage, null, sample)).rejects.toBeInstanceOf(MigrationConflictError);
    expect(await prisma.migrationRecord.findFirst({ where: { entityType: "TRACK", sourceIdentity: "1329" } })).toMatchObject({ status: "CONFLICT", stage: "CONFLICT" });
  });

  it("repairs missing deterministic CREATE and PUBLISH audits on rerun", async () => {
    const storage = new MemoryStorage(); const first = await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    const artist = await prisma.artist.findUniqueOrThrow({ where: { legacyId: 4 } });
    const createId = stableUuid("migration-catalogue-audit", `${first.runId}:ARTIST:4:CREATE`);
    const publishId = stableUuid("migration-catalogue-audit", `${first.runId}:ARTIST:4:PUBLISH`);
    await prisma.auditLog.deleteMany({ where: { id: { in: [createId, publishId] } } });
    await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    expect(await prisma.auditLog.findUnique({ where: { id: createId } })).toMatchObject({ artistId: artist.id, action: "CREATE" });
    expect(await prisma.auditLog.findUnique({ where: { id: publishId } })).toMatchObject({ artistId: artist.id, action: "PUBLISH" });
  });

  it("keeps multiple historical runs and never adopts them as the production-safe run", async () => {
    await prisma.migrationRun.createMany({ data: [
      { id: crypto.randomUUID(), sourceSha256: APPROVED_SOURCE_SHA256, scopeKey: "legacy", toolingVersion: `legacy:${crypto.randomUUID()}`, completedAt: new Date() },
      { id: crypto.randomUUID(), sourceSha256: APPROVED_SOURCE_SHA256, scopeKey: "legacy", toolingVersion: `legacy:${crypto.randomUUID()}`, completedAt: new Date() },
    ] });
    const storage = new MemoryStorage(); const plan = await buildMigrationPlan(sample); const result = await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    expect(result.runId).toBe(plan.runId);
    expect(result.runId).toBe(migrationRunId(APPROVED_SOURCE_SHA256, plan.scopeKey));
    expect(await prisma.migrationRun.count()).toBe(3);
    expect((await prisma.migrationRun.findUniqueOrThrow({ where: { id: result.runId } })).toolingVersion).toBe("phase2-production-safe-v1");
  });

  it.each([
    ["MediaVariant", {}, async (id: string) => prisma.mediaVariant.create({ data: { mediaAssetId: id, variantKey: "ORIGINAL", storageKey: "audio/unexpected.mp3", mimeType: "audio/mpeg", byteSize: 1, sha256Checksum: "0".repeat(64), width: 1, height: 1 } })],
    ["processing job", {}, async (id: string) => prisma.mediaProcessingJob.create({ data: { mediaAssetId: id } })],
  ])("rejects LEGACY_EXTERNAL audio with %s", async (_label, extraData, mutate) => {
    const storage = new MemoryStorage(); const plan = await buildMigrationPlan(sample); const audio = plan.expected.audio[0]!;
    await prisma.user.create({ data: { ...MIGRATION_ACTOR, emailVerified: true } });
    await prisma.mediaAsset.create({ data: { id: audio.id, legacyAudioId: audio.legacyAudioId, kind: "AUDIO", provider: "LEGACY_EXTERNAL", status: "EXTERNAL", createdById: MIGRATION_ACTOR.id, ...extraData } });
    if (mutate) await mutate(audio.id);
    await expect(executeImport(process.env.DATABASE_URL!, storage, null, sample)).rejects.toBeInstanceOf(MigrationConflictError);
  });

  it("reports catalogue conflicts and excludes existing matches from projected rollback ownership", async () => {
    const storage = new MemoryStorage(); await executeImport(process.env.DATABASE_URL!, storage, null, sample);
    const matching = await buildMigrationPlan(sample, process.env.DATABASE_URL!);
    expect(matching.inventory.conflicting).toBe(0);
    expect(matching.projectedRollbackOwnership.workingRows).toHaveLength(0);
    expect(matching.projectedRollbackOwnership.mediaAssets).toHaveLength(0);
    await prisma.track.update({ where: { legacyId: 1329 }, data: { title: "Plan detects this conflict" } });
    const conflicting = await buildMigrationPlan(sample, process.env.DATABASE_URL!);
    expect(conflicting.inventory.items).toContainEqual(expect.objectContaining({ key: "Track:1329", state: "CONFLICT" }));
  });

  it("reports a pre-existing Media conflict in zero-write plan mode", async () => {
    const expected = await buildMigrationPlan(sample); const image = expected.expected.images[0]!;
    await prisma.user.create({ data: { ...MIGRATION_ACTOR, emailVerified: true } });
    await prisma.mediaAsset.create({ data: { id: image.id, kind: "IMAGE", status: "PROCESSING", provider: "LOCAL", sourceStorageKey: image.sourceStorageKey, originalFilename: "conflict.jpg", mimeType: "image/jpeg", byteSize: 1, sha256Checksum: "0".repeat(64), createdById: MIGRATION_ACTOR.id } });
    const mediaConflict = await buildMigrationPlan(sample, process.env.DATABASE_URL!);
    expect(mediaConflict.inventory.items).toContainEqual(expect.objectContaining({ key: `Image:${image.sourceIdentity}`, state: "CONFLICT" }));
  });
});
