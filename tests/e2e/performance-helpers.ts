import { expect, type Page } from "@playwright/test";
export async function openPreview(page: Page) {
  const button = page.getByRole("button", {
    name: "Preview / Compatibility JSON",
    exact: true,
  });
  await expect(button).toBeVisible();
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  await expect(page.getByTestId("canonical-preview")).toBeVisible();
}
export async function choose(page: Page, label: string, id: string) {
  await page
    .getByRole("textbox", { name: `Search ${label}`, exact: true })
    .fill(id);
  const select = page.getByRole("combobox", { name: label, exact: true });
  await expect(select.locator(`option[value="${id}"]`)).toHaveCount(1);
  await select.selectOption(id);
}
export async function mutateAndReload(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  await expect(page.locator(".summary-strip")).toBeVisible();
  const pathname = new URL(page.url()).pathname;
  const navigation = page.waitForResponse(
    (response) =>
      response.request().isNavigationRequest() &&
      response.request().frame() === page.mainFrame() &&
      new URL(response.url()).pathname === pathname,
  );
  await button.click();
  await navigation;
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".summary-strip")).toBeVisible();
}
