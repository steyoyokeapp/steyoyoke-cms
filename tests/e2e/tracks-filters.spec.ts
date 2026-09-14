import { expect, test, type Page } from "@playwright/test";

const prefix = `Filter UX ${Date.now()}`;
let artist: { id: string; name: string };
let labels: { id: string; name: string }[];
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/steyoyoke_cms_local") throw new Error("Local fixture database required");
  const { prisma } = await import("../../src/lib/prisma");
  labels = await prisma.label.findMany({ where: { active: true }, take: 2, orderBy: { name: "asc" }, select: { id: true, name: true } });
  expect(labels).toHaveLength(2);
  const artists = await prisma.artist.createManyAndReturn({ data: Array.from({ length: 32 }, (_, i) => ({ name: `${prefix} choice ${String(i).padStart(2, "0")}`, slug: `filter-ux-${Date.now()}-${i}` })) });
  artist = artists[0]!;
  await prisma.track.createMany({ data: [
    ...Array.from({ length: 55 }, (_, i) => ({ title: `${prefix} ${i}`, primaryArtistId: artist.id, labelId: labels[0]!.id })),
    { title: `${prefix} other-label`, primaryArtistId: artist.id, labelId: labels[1]!.id },
    { title: `${prefix} other-artist`, primaryArtistId: artists[1]!.id, labelId: labels[0]!.id },
    { title: `${prefix} archived`, primaryArtistId: artist.id, labelId: labels[0]!.id, status: "ARCHIVED", archivedAt: new Date() },
  ] });
  await prisma.$disconnect();
});
async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_VIEWER_EMAIL!);
  await page.getByLabel("Password").fill(process.env.SEED_VIEWER_PASSWORD!);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
}

test("compact Tracks toolbar keeps bounded search, combined filters, pagination and browser history", async ({ page }) => {
  await signIn(page);
  const choices: string[] = [];
  page.on("request", r => { if (new URL(r.url()).pathname === "/api/admin/choices") choices.push(r.url()); });
  const response = await page.goto("/admin/tracks");
  await expect(page.getByRole("heading", { name: "Tracks", exact: true })).toBeVisible();
  expect(choices).toEqual([]);
  expect(await response!.text()).not.toContain(`${prefix} choice 31`);
  const form = page.getByRole("form", { name: "tracks filters" });
  const title = form.getByLabel("Search title");
  const combo = form.getByRole("combobox", { name: "Artist", exact: true });
  await expect(form.getByLabel("Search Artist filter")).toHaveCount(0);
  await title.fill(prefix);
  await form.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator("a.table-row")).toHaveCount(50);
  await combo.fill(`${prefix} choice`);
  await expect(page.getByRole("option", { name: /choice 00/ })).toBeVisible();
  expect(await page.getByRole("listbox").getByRole("option").count()).toBeLessThanOrEqual(26);
  await combo.fill(artist.name);
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await combo.press("ArrowDown"); await combo.press("ArrowDown"); await combo.press("Enter");
  await expect(combo).toHaveValue(artist.name);
  await form.getByRole("combobox", { name: "Label", exact: true }).selectOption(labels[0]!.id);
  await form.getByRole("combobox", { name: "Status", exact: true }).selectOption("DRAFT");
  await form.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`artistId=${artist.id}`));
  await expect(page.locator("a.table-row")).toHaveCount(50);
  const firstPage = page.url();
  await page.getByRole("navigation", { name: "Catalogue pagination" }).getByRole("link", { name: "Next" }).click();
  await expect(page.locator("a.table-row")).toHaveCount(5);
  expect(new URL(page.url()).searchParams.get("page")).toBe("2");
  for (const key of ["q", "artistId", "labelId", "status"]) expect(new URL(page.url()).searchParams.get(key)).toBe(new URL(firstPage).searchParams.get(key));
  await expect(combo).toHaveValue(artist.name);
  await form.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/admin\/tracks$/);
  await expect(combo).toHaveValue("");
  await page.goBack(); await expect(combo).toHaveValue(artist.name);
  await expect(title).toHaveValue(prefix);
  await expect(form.getByRole("combobox", { name: "Label", exact: true })).toHaveValue(labels[0]!.id);
  await expect(form.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("DRAFT");
  await page.goForward(); await expect(page).toHaveURL(/\/admin\/tracks$/);

  await title.fill(prefix); await combo.fill(artist.name);
  await page.getByRole("option", { name: new RegExp(artist.name) }).click();
  await form.getByRole("combobox", { name: "Label", exact: true }).selectOption(labels[1]!.id);
  await form.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator("a.table-row")).toHaveCount(1);
  await expect(page.locator("a.table-row")).toContainText("other-label");
  await form.getByRole("combobox", { name: "Label", exact: true }).selectOption("");
  await form.getByRole("combobox", { name: "Status", exact: true }).selectOption("ARCHIVED");
  await form.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator("a.table-row")).toHaveCount(1);
  await expect(page.locator("a.table-row")).toContainText("archived");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.mouse.move(0, 0);
  const controls = form.locator('input:not([type="hidden"]), select, button');
  await expect(controls).toHaveCount(5);
  const desktop = await controls.evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { top: r.top, height: r.height }; }));
  expect(new Set(desktop.map(r => Math.round(r.top))).size).toBe(1);
  expect(desktop.every(r => r.height >= 44 && r.height <= 48)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await form.evaluate(node => { const r = node.getBoundingClientRect(); return { width: r.width, scroll: node.scrollWidth, client: node.clientWidth }; });
  expect(mobile.scroll).toBeLessThanOrEqual(mobile.client);
  expect(mobile.width).toBeLessThan(390);
  await expect(combo).toBeVisible();
});

test("Artist search discards stale responses and keeps the selected value on dismiss", async ({ page }) => {
  await signIn(page); await page.goto(`/admin/tracks?artistId=${artist.id}`);
  const combo = page.getByRole("combobox", { name: "Artist", exact: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let slowSeen = false;
  await page.route("**/api/admin/choices?*", async route => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "slow") { slowSeen = true; await gate; }
    await route.fulfill({ json: [{ id: "00000000-0000-4000-8000-000000000098", name: query === "slow" ? "Stale Artist" : "Latest Artist" }] });
  });
  await combo.fill("slow"); await expect.poll(() => slowSeen).toBe(true);
  await combo.fill("latest"); await expect(page.getByRole("option", { name: "Latest Artist" })).toBeVisible();
  release(); await expect(page.getByRole("option", { name: "Stale Artist" })).toHaveCount(0);
  await combo.press("Escape"); await expect(combo).toHaveValue(artist.name);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await combo.click(); await page.getByRole("option", { name: "All Artists", exact: true }).click();
  await expect(combo).toHaveValue("");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("artistId")).toBe("");
});
