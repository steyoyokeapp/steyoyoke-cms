import { expect, test, type Page } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function signIn(page: Page, email: string, password: string) { await page.goto("/sign-in"); await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Sign in" }).click(); await expect(page).toHaveURL(/\/admin\/artists$/); }

test("Editor uploads local images and Artist delivery follows frozen artwork revisions", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const suffix = Date.now(); const firstName = `media-a-${suffix}.png`; const secondName = `media-b-${suffix}.png`; const artistName = `Media E2E Artist ${suffix}`; const apiKey = process.env.LEGACY_API_KEY_A!;
  await signIn(page, process.env.SEED_EDITOR_EMAIL!, process.env.SEED_EDITOR_PASSWORD!); await page.getByRole("link", { name: "Media", exact: true }).click(); await expect(page).toHaveURL(/\/admin\/media$/);
  await page.evaluate(() => {
    const state = { created: [] as string[], revoked: [] as string[] }; Object.assign(window, { __mediaObjectUrls: state });
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); state.created.push(url); return url; };
    URL.revokeObjectURL = (url) => { state.revoked.push(url); revoke(url); };
  });
  let continueUpload!: () => void; const uploadGate = new Promise<void>((resolve) => { continueUpload = resolve; });
  await page.route("**/api/admin/media", async (route) => { if (route.request().method() === "POST") await uploadGate; await route.continue(); });
  const upload = page.getByText("Upload image", { exact: true }).locator("input").setInputFiles({ name: firstName, mimeType: "image/png", buffer: png });
  const optimistic = page.locator('[data-optimistic="true"]').filter({ hasText: firstName }); await expect(optimistic).toBeVisible(); await expect(optimistic).toContainText("UPLOADING"); await expect(optimistic).not.toHaveJSProperty("tagName", "BUTTON");
  continueUpload(); await upload; await expect(optimistic).toHaveCount(0); await page.unroute("**/api/admin/media");
  await expect(page.getByText(firstName, { exact: true })).toBeVisible(); await expect(page.locator(".media-card").first()).toContainText("READY"); await expect.poll(() => page.evaluate(() => (window as unknown as { __mediaObjectUrls: { revoked: string[] } }).__mediaObjectUrls.revoked.length)).toBe(1); await expect(page.locator(".preview")).toContainText("ORIGINAL"); await expect(page.locator(".preview")).toContainText("LEGACY_THUMB_80");
  const assets = await (await page.request.get("/api/admin/media")).json(); const first = assets.find((asset: { originalFilename: string }) => asset.originalFilename === firstName); expect(first).toBeTruthy();
  await page.getByRole("link", { name: "Artists", exact: true }).click(); await page.getByRole("link", { name: "New artist" }).click(); await page.getByLabel("Artist name").fill(artistName); await page.getByRole("button", { name: "Create draft" }).click(); await page.getByLabel("Artwork").selectOption(first.id); await page.getByRole("button", { name: "Save draft" }).click(); const legacyId = await page.locator(".summary-strip .mono").first().textContent(); await page.getByRole("button", { name: "Publish now" }).click(); await expect(page.getByTestId("legacy-preview")).toContainText(first.compatibilityFilename);
  let legacy = (await (await page.request.get(`/index.php/cms/api/${legacyId}?filter=artists`, { headers: { "X-Csrf-Token": apiKey } })).json()).artists[0]; expect(legacy.image).toContain(first.compatibilityFilename); expect((await page.request.get(legacy.image)).ok()).toBe(true);
  await page.locator('.media-picker input[type="file"]').setInputFiles({ name: secondName, mimeType: "image/png", buffer: png }); await expect(page.getByText(secondName, { exact: true })).toBeVisible(); const second = (await (await page.request.get("/api/admin/media")).json()).find((asset: { originalFilename: string }) => asset.originalFilename === secondName); expect(second).toBeTruthy(); await page.getByRole("button", { name: "Save draft" }).click();
  legacy = (await (await page.request.get(`/index.php/cms/api/${legacyId}?filter=artists`, { headers: { "X-Csrf-Token": apiKey } })).json()).artists[0]; expect(legacy.image).toContain(first.compatibilityFilename); await page.getByRole("button", { name: "Publish now" }).click(); await expect(page.getByTestId("legacy-preview")).toContainText(second.compatibilityFilename); legacy = (await (await page.request.get(`/index.php/cms/api/${legacyId}?filter=artists`, { headers: { "X-Csrf-Token": apiKey } })).json()).artists[0]; expect(legacy.image).toContain(second.compatibilityFilename); expect(errors).toEqual([]);
});

test("Optimistic failure is removed and its local preview URL is revoked", async ({ page }) => {
  const name = `media-failed-${Date.now()}.png`; await signIn(page, process.env.SEED_EDITOR_EMAIL!, process.env.SEED_EDITOR_PASSWORD!); await page.getByRole("link", { name: "Media", exact: true }).click();
  await page.evaluate(() => {
    const state = { created: [] as string[], revoked: [] as string[] }; Object.assign(window, { __mediaObjectUrls: state });
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); state.created.push(url); return url; };
    URL.revokeObjectURL = (url) => { state.revoked.push(url); revoke(url); };
  });
  await page.route("**/api/admin/media", async (route) => { if (route.request().method() !== "POST") return route.continue(); await new Promise((resolve) => setTimeout(resolve, 250)); await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: { message: "Image upload failed cleanly." } }) }); });
  const upload = page.getByText("Upload image", { exact: true }).locator("input").setInputFiles({ name, mimeType: "image/png", buffer: png });
  const optimistic = page.locator('[data-optimistic="true"]').filter({ hasText: name }); await expect(optimistic).toContainText("UPLOADING"); await upload; await expect(optimistic).toHaveCount(0); await page.unroute("**/api/admin/media"); await expect(page.locator(".alert.error")).toContainText("Image upload failed cleanly.");
  expect(await page.evaluate(() => (window as unknown as { __mediaObjectUrls: { created: string[]; revoked: string[] } }).__mediaObjectUrls)).toMatchObject({ created: expect.any(Array), revoked: expect.any(Array) });
  expect(await page.evaluate(() => { const value = (window as unknown as { __mediaObjectUrls: { created: string[]; revoked: string[] } }).__mediaObjectUrls; return [value.created.length, value.revoked.length]; })).toEqual([1, 1]);
});

test("Admin moves an unreferenced asset from Active to Retired and permanently deletes it with confirmation", async ({ page }) => {
  const name = `media-delete-${Date.now()}.png`; await signIn(page, process.env.SEED_ADMIN_EMAIL!, process.env.SEED_ADMIN_PASSWORD!); await page.getByRole("link", { name: "Media", exact: true }).click();
  await page.getByText("Upload image", { exact: true }).locator("input").setInputFiles({ name, mimeType: "image/png", buffer: png }); const card = page.locator(".media-card").filter({ hasText: name }); await expect(card).toContainText("READY"); await card.click();
  await page.getByRole("button", { name: "Retire", exact: true }).click(); await expect(card).toHaveCount(0);
  await page.getByRole("tab", { name: /Retired/ }).click(); await expect(page).toHaveURL(/view=retired/); await expect(card).toContainText("RETIRED");
  await page.getByLabel("Kind filter").selectOption("AUDIO"); await expect(card).toHaveCount(0); await expect(page).toHaveURL(/kind=AUDIO/); await page.getByLabel("Kind filter").selectOption("IMAGE"); await expect(card).toBeVisible(); await card.click();
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Delete permanently?" }); await expect(dialog).toContainText("the uploaded source"); await expect(dialog).toContainText("all generated variants"); await expect(dialog).toContainText("This cannot be undone."); await dialog.getByRole("button", { name: "Cancel" }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Delete permanently", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "DELETE PERMANENTLY", exact: true }).click(); await expect(card).toHaveCount(0); await page.reload(); await expect(page.locator(".media-card").filter({ hasText: name })).toHaveCount(0);
  expect((await (await page.request.get("/api/admin/media")).json()).some((asset: { originalFilename: string }) => asset.originalFilename === name)).toBe(false);
});

test("Viewer can inspect Media but cannot upload or replace", async ({ page }) => {
  await signIn(page, process.env.SEED_VIEWER_EMAIL!, process.env.SEED_VIEWER_PASSWORD!); await page.getByRole("link", { name: "Media", exact: true }).click(); await expect(page.getByRole("heading", { name: "Media", exact: true })).toBeVisible(); await expect(page.locator('input[type="file"]')).toHaveCount(0);
  const denied = await page.request.post("/api/admin/media", { multipart: { file: { name: "denied.png", mimeType: "image/png", buffer: png } } }); expect(denied.status()).toBe(403);
});
