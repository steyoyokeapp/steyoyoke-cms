import { expect, type Page } from "@playwright/test";

// Publication/media remain backend capabilities, outside the normal Artist form.
export async function artistAction(page: Page, id: string, action: string, expectedWorkingVersion = 1) {
  const response = await page.request.post(`/api/admin/artists/${id}/actions`, {
    headers: { Origin: new URL(page.url()).origin }, data: { action, expectedWorkingVersion },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

export async function createPublishedArtist(page: Page, name: string, imageAssetId?: string) {
  const response = await page.request.post("/api/admin/artists", {
    headers: { Origin: new URL(page.url()).origin }, data: { name, imageAssetId },
  });
  expect(response.ok()).toBe(true);
  const artist = await response.json();
  await artistAction(page, artist.id, "publish", artist.workingVersion);
  return artist;
}
