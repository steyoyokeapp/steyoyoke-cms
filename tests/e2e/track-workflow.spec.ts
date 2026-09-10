import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in"); await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Sign in" }).click(); await expect(page).toHaveURL(/\/admin\/artists$/);
}

test("Editor completes the Track draft isolation lifecycle", async ({ page }) => {
  const suffix = Date.now(); const artistName = `Track E2E Artist ${suffix}`; const publishedTitle = `Track E2E ${suffix}`; const draftTitle = `Track E2E Draft ${suffix}`; const apiKey = process.env.LEGACY_API_KEY_A!;
  await signIn(page, process.env.SEED_EDITOR_EMAIL!, process.env.SEED_EDITOR_PASSWORD!);
  await page.getByRole("link", { name: "New artist" }).click(); await page.getByLabel("Artist name").fill(artistName); await page.getByRole("button", { name: "Create draft" }).click(); await page.getByRole("button", { name: "Publish now" }).click();
  await page.getByRole("link", { name: "Tracks", exact: true }).click(); await page.getByRole("link", { name: "Create Track" }).click();
  await page.getByLabel("Title").fill(publishedTitle); await page.getByLabel("Search Artists").fill(artistName); await page.getByLabel("Primary Artist").selectOption({ index: 1 }); await page.getByLabel("Label").selectOption({ label: "Steyoyoke" }); await page.getByLabel("Duration").fill("03:45"); await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/admin\/tracks\/[0-9a-f-]+$/); await expect(page.getByText("Not visible to legacy clients until published.")).toBeVisible(); const legacyId = await page.locator(".summary-strip .mono").first().textContent();
  let api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=track`, { headers: { "X-Csrf-Token": apiKey } }); expect((await api.json()).tracks).toEqual([]);
  await page.getByRole("button", { name: "Publish now" }).click(); await expect(page.getByTestId("legacy-preview")).toContainText(publishedTitle);
  api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=track`, { headers: { "X-Csrf-Token": apiKey } }); expect((await api.json()).tracks[0].title).toBe(publishedTitle);
  await page.getByLabel("Title").fill(draftTitle); await page.getByRole("button", { name: "Save draft" }).click(); await expect(page.getByText("Unpublished changes")).toBeVisible(); await expect(page.getByTestId("canonical-preview")).toContainText(draftTitle); await expect(page.getByTestId("legacy-preview")).toContainText(publishedTitle);
  api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=track`, { headers: { "X-Csrf-Token": apiKey } }); expect((await api.json()).tracks[0].title).toBe(publishedTitle);
  await page.getByRole("button", { name: "Publish now" }).click(); await expect(page.getByTestId("legacy-preview")).toContainText(draftTitle); api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=track`, { headers: { "X-Csrf-Token": apiKey } }); expect((await api.json()).tracks[0].title).toBe(draftTitle);
  await page.getByRole("button", { name: "Unpublish" }).click(); await expect(page.locator(".summary-strip")).toContainText("UNPUBLISHED"); api = await page.request.get(`/index.php/cms/api/${legacyId}?filter=tracks&type=track`, { headers: { "X-Csrf-Token": apiKey } }); expect((await api.json()).tracks).toEqual([]);
});

test("Viewer sees Track details without mutation controls or server write access", async ({ page }) => {
  await signIn(page, process.env.SEED_VIEWER_EMAIL!, process.env.SEED_VIEWER_PASSWORD!); await page.getByRole("link", { name: "Tracks", exact: true }).click();
  await expect(page.getByRole("link", { name: "Create Track" })).toHaveCount(0); const row = page.locator("a.table-row").first(); await expect(row).toBeVisible(); await row.click(); await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0); await expect(page.getByRole("button", { name: "Publish now" })).toHaveCount(0);
  const denied = await page.request.patch(`/api/admin/tracks/${page.url().split("/").at(-1)}`, { data: {} }); expect(denied.status()).toBe(403);
});
