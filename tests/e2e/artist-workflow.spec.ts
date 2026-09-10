import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
}

test("create → publish → isolated edit → unpublish legacy workflow", async ({ page }) => {
  const email = process.env.SEED_ADMIN_EMAIL!;
  const password = process.env.SEED_ADMIN_PASSWORD!;
  const apiKey = process.env.LEGACY_API_KEY_A!;
  const suffix = Date.now();
  const publishedName = `E2E Artist ${suffix}`;
  const draftName = `E2E Draft ${suffix}`;

  await signIn(page, email, password);
  await page.getByRole("link", { name: "New artist" }).click();
  await page.getByLabel("Artist name").fill(publishedName);
  await page.getByLabel("Short biography").fill("Published biography");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/admin\/artists\/[0-9a-f-]+$/);
  await expect(page.getByText("Not visible to legacy clients until published.")).toBeVisible();

  const legacyId = await page.locator(".summary-strip .mono").first().textContent();
  expect(legacyId).toMatch(/^\d+$/);
  let response = await page.request.get(`/index.php/cms/api/${legacyId}?filter=artists`, {
    headers: { "X-Csrf-Token": apiKey },
  });
  expect((await response.json()).artists).toEqual([]);

  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByTestId("legacy-preview")).toContainText(publishedName);
  response = await page.request.get(`/index.php/cms/api/${legacyId}?filter=artists`, {
    headers: { "X-Csrf-Token": apiKey },
  });
  expect((await response.json()).artists[0].name).toBe(publishedName);

  await page.getByLabel("Artist name").fill(draftName);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: draftName })).toBeVisible();
  await expect(page.getByTestId("legacy-preview")).toContainText(publishedName);
  await expect(page.getByTestId("legacy-preview")).not.toContainText(draftName);

  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.locator(".summary-strip")).toContainText("UNPUBLISHED");
  response = await page.request.get(`/index.php/cms/api/${legacyId}?filter=artists`, {
    headers: { "X-Csrf-Token": apiKey },
  });
  expect((await response.json()).artists).toEqual([]);
});

test("signup is closed, viewer writes are denied, and sign-out revokes access", async ({ page }) => {
  const signup = await page.request.post("/api/auth/sign-up/email", {
    data: { name: "Public User", email: `public-${Date.now()}@example.test`, password: "not-a-real-password" },
  });
  expect(signup.ok()).toBeFalsy();

  await signIn(page, process.env.SEED_VIEWER_EMAIL!, process.env.SEED_VIEWER_PASSWORD!);
  await expect(page.getByRole("link", { name: "New artist" })).toHaveCount(0);
  const denied = await page.request.post("/api/admin/artists", {
    data: { name: "Viewer must not create" },
  });
  expect(denied.status()).toBe(403);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/admin/artists");
  await expect(page).toHaveURL(/\/sign-in$/);
});
