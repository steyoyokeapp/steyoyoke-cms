import {mutateAndReload,openPreview,choose} from "./performance-helpers";
import { expect, test, type Page } from "@playwright/test";
import { testMp3 } from "../fixtures/audio";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in"); await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Sign in" }).click(); await expect(page).toHaveURL(/\/admin\/artists$/);
}

async function uploadArtwork(page: Page, name: string) {
  const response = await page.request.post("/api/admin/media", { headers: { Origin: new URL(page.url()).origin }, multipart: { file: { name, mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") } } });
  const body = await response.text();
  if (!response.ok()) throw new Error(`Media upload ${response.status()}: ${body}`);
  const id = JSON.parse(body).id as string;
  await expect.poll(async () => (await (await page.request.get(`/api/admin/media/${id}`)).json()).status).toBe("READY");
  return id;
}

async function uploadAudio(page: Page, name: string) { const response = await page.request.post("/api/admin/media", { headers: { Origin: new URL(page.url()).origin }, multipart: { kind: "AUDIO", file: { name, mimeType: "audio/mpeg", buffer: testMp3() } } }); const body = await response.text(); if (!response.ok()) throw new Error(`Audio upload ${response.status()}: ${body}`); return JSON.parse(body).id as string; }

async function clickAndWaitForReload(page: Page, name: string) {
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name, exact: true }).click(),
  ]);
}

test("Editor completes the structured Podcast publication lifecycle", async ({ page }) => {
  test.setTimeout(60_000);
  const suffix = Date.now(); const artistName = `Podcast E2E Artist ${suffix}`; const originalTitle = `Steyoyoke Podcast E2E ${suffix}`; const draftTitle = `Podcast E2E Updated ${suffix}`; const apiKey = process.env.LEGACY_API_KEY_A!;
  await signIn(page, process.env.SEED_EDITOR_EMAIL!, process.env.SEED_EDITOR_PASSWORD!);
  const artworkId = await uploadArtwork(page, `podcast-${suffix}.png`); const audioId = await uploadAudio(page, `podcast-${suffix}.mp3`);
  await page.getByRole("link", { name: "New artist" }).click(); await page.getByLabel("Artist name").fill(artistName); await page.getByRole("button", { name: "Create draft" }).click(); await mutateAndReload(page,"Publish now"); await expect(page.locator(".summary-strip")).toContainText("PUBLISHED");
  await page.getByRole("link", { name: "Podcasts", exact: true }).click(); await page.getByRole("link", { name: "Create Podcast" }).click(); await page.getByLabel("Title").fill(originalTitle); await page.getByLabel("Search Primary Artist").fill(artistName); const podcastArtistValue = await page.getByLabel("Primary Artist", {exact:true}).locator("option").filter({ hasText: artistName }).getAttribute("value"); await page.getByLabel("Primary Artist", {exact:true}).selectOption(podcastArtistValue!); await page.getByLabel("Label").selectOption({ label: "Inner Symphony" }); await page.getByLabel("Episode Date").fill("2026-07-08"); await page.getByLabel("Duration").fill("01:03:45"); await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/admin\/podcasts\/[0-9a-f-]+(?:\?.*)?$/); const legacyId = await page.locator(".summary-strip .mono").first().textContent(); await page.getByRole("button", { name: "Publish now" }).click(); await expect(page.locator(".alert.error")).toContainText("Artwork is required"); await choose(page,"Artwork",artworkId); await page.getByRole("button", { name: "Add Chapter" }).click(); await page.getByRole("button", { name: "Add Chapter" }).click();
  await page.getByLabel("Chapter 1 Artist").fill("Opening Artist"); await page.getByLabel("Chapter 1 Title").fill("Opening Track"); await page.getByLabel("Chapter 1 Legacy Reference").fill("OPEN-1");
  await page.getByLabel("Chapter 1 Duration").fill("03:45"); await page.getByLabel("Chapter 2 Artist").fill("Closing Artist"); await page.getByLabel("Chapter 2 Title").fill("Closing Track"); await clickAndWaitForReload(page, "Save Draft"); await openPreview(page); await expect(page.getByTestId("legacy-preview")).toHaveText("null");
  let api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=podcast`, { headers: { "X-Csrf-Token": apiKey } }); expect((await api.json()).tracks).toEqual([]); await page.getByRole("button", { name: "Publish now" }).click(); await expect(page.locator(".alert.error")).toContainText("Audio is required"); await choose(page,"Audio",audioId); await clickAndWaitForReload(page, "Save Draft");
  await clickAndWaitForReload(page, "Publish now"); await openPreview(page); await expect(page.getByTestId("legacy-preview")).toContainText(`Podcast E2E ${suffix}`); api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=podcast`, { headers: { "X-Csrf-Token": apiKey } }); let delivered = (await api.json()).tracks[0]; expect(delivered.title).toBe(`Podcast E2E ${suffix}`); expect(delivered.artist_feature_times.map((chapter: { title: string }) => chapter.title)).toEqual(["Opening Track", "Closing Track"]);
  await page.getByLabel("Title", { exact: true }).fill(draftTitle); await page.getByLabel("Chapter 2 Title").fill("Closing Track Edited"); await page.getByRole("button", { name: "Move Chapter 2 up" }).click(); await clickAndWaitForReload(page, "Save Draft"); await expect(page.getByText("Unpublished changes")).toBeVisible(); await openPreview(page); await expect(page.getByTestId("canonical-preview")).toContainText("Closing Track Edited");
  api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=podcast`, { headers: { "X-Csrf-Token": apiKey } }); delivered = (await api.json()).tracks[0]; expect(delivered.title).toBe(`Podcast E2E ${suffix}`); expect(delivered.artist_feature_times[0].title).toBe("Opening Track");
  await clickAndWaitForReload(page, "Publish now"); await openPreview(page); await expect(page.getByTestId("legacy-preview")).toContainText(draftTitle); api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=podcast`, { headers: { "X-Csrf-Token": apiKey } }); delivered = (await api.json()).tracks[0]; expect(delivered.title).toBe(draftTitle); expect(delivered.artist_feature_times[0].title).toBe("Closing Track Edited");
  await page.getByLabel("Schedule time").fill("2099-01-01T12:00"); await clickAndWaitForReload(page, "Schedule"); await expect(page.locator(".summary-strip")).toContainText("SCHEDULED"); await clickAndWaitForReload(page, "Cancel schedule"); await expect(page.locator(".summary-strip")).toContainText("PUBLISHED");
  await clickAndWaitForReload(page, "Unpublish"); await expect(page.locator(".summary-strip")).toContainText("UNPUBLISHED"); await clickAndWaitForReload(page, "Archive"); await expect(page.locator(".summary-strip")).toContainText("ARCHIVED"); await clickAndWaitForReload(page, "Restore"); await expect(page.locator(".summary-strip")).toContainText("UNPUBLISHED");
});

test("Viewer can inspect Podcasts but cannot mutate them", async ({ page }) => {
  await signIn(page, process.env.SEED_VIEWER_EMAIL!, process.env.SEED_VIEWER_PASSWORD!); await page.getByRole("link", { name: "Podcasts", exact: true }).click(); await expect(page.getByRole("link", { name: "Create Podcast" })).toHaveCount(0); const row = page.locator("a.table-row").first(); await expect(row).toBeVisible(); await row.click(); await expect(page.getByRole("button", { name: "Save Draft" })).toHaveCount(0); await expect(page.getByRole("button", { name: "Publish now" })).toHaveCount(0);
  const denied = await page.request.patch(`/api/admin/podcasts/${new URL(page.url()).pathname.split("/").at(-1)}`, { data: {} }); expect(denied.status()).toBe(403);
});
