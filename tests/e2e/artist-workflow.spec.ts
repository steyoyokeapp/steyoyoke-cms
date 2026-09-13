import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
}

test("name-only create and edit preserve identity and legacy freeze semantics", async ({ page }) => {
  await signIn(page, process.env.SEED_ADMIN_EMAIL!, process.env.SEED_ADMIN_PASSWORD!);
  const name = `E2E Artist ${Date.now()}`;
  await page.getByRole("link", { name: "New artist" }).click();
  await expect(page.locator("form input")).toHaveCount(1);
  await expect(page.locator("form button")).toHaveText("Create artist");
  await page.getByLabel("Artist name").fill(name);
  const created = page.waitForResponse(r => r.url().endsWith("/api/admin/artists") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create artist", exact: true }).click();
  const artist = await (await created).json();
  expect(artist.slug).toBe(name.toLowerCase().replaceAll(" ", "-"));
  await expect(page).toHaveURL(new RegExp(`/admin/artists/${artist.id}`));
  await expect(page.getByRole("heading", { name: "Artist", exact: true })).toBeVisible();
  await expect(page.locator("form input")).toHaveCount(1);
  await expect(page.locator("form button")).toHaveText("Save changes");
  for (const label of ["Slug", "Short biography", "Facebook URL", "Artwork"]) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  for (const label of ["Revision history", "Audit trail", "Compatibility previews", "Publish now"]) await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  const headers = { Origin: new URL(page.url()).origin };
  const publish = await page.request.post(`/api/admin/artists/${artist.id}/actions`, { headers, data: { action: "publish", expectedWorkingVersion: 1 } });
  expect(publish.ok()).toBe(true);
  for (const changed of [`${name} renamed`, `${name} again`]) {
    await page.getByLabel("Artist name").fill(changed);
    const saved = page.waitForResponse(r => r.url().endsWith(`/api/admin/artists/${artist.id}`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator("form").getByRole("status")).toHaveText("Changes saved.");
    await expect(page.getByLabel("Artist name")).toHaveValue(changed);
  }
  await page.reload();
  await expect(page.getByLabel("Artist name")).toHaveValue(`${name} again`);
  const stored = await (await page.request.get(`/api/admin/artists/${artist.id}`)).json();
  expect(stored.slug).toBe(artist.slug);
  expect(stored.workingVersion).toBe(3);
  const legacy = await page.request.get(`/index.php/cms/api/${artist.legacyId}?filter=artists`, { headers: { "X-Csrf-Token": process.env.LEGACY_API_KEY_A! } });
  expect((await legacy.json()).artists[0].name).toBe(name);
});

test("signup is closed, viewer writes are denied, and sign-out revokes access", async ({ page }) => {
  const signup = await page.request.post("/api/auth/sign-up/email", {
    data: { name: "Public User", email: `public-${Date.now()}@example.test`, password: "not-a-real-password" },
  });
  expect(signup.ok()).toBeFalsy();

  await signIn(page, process.env.SEED_VIEWER_EMAIL!, process.env.SEED_VIEWER_PASSWORD!);
  await expect(page.getByRole("link", { name: "New artist" })).toHaveCount(0);
  const denied = await page.request.post("/api/admin/artists", {
    headers: { Origin: new URL(page.url()).origin }, data: { name: "Viewer must not create" },
  });
  expect(denied.status()).toBe(403);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/admin/artists");
  await expect(page).toHaveURL(/\/sign-in$/);
});
