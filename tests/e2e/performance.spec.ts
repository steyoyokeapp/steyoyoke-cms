import { expect, test } from "@playwright/test";
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname !== "/steyoyoke_cms_local"
  )
    throw new Error(
      "Performance browser fixtures require the local development database",
    );
  const { prisma } = await import("../../src/lib/prisma");
  const existing = await prisma.mediaAsset.count({
    where: { status: { not: "RETIRED" } },
  });
  if (existing < 50) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: process.env.SEED_ADMIN_EMAIL! },
    });
    await prisma.mediaAsset.createMany({
      data: Array.from({ length: 50 - existing }, () => ({
        kind: "AUDIO",
        status: "EXTERNAL",
        provider: "LEGACY_EXTERNAL",
        createdById: user.id,
        legacyAudioId: `PERF_${crypto.randomUUID()}`,
      })),
    });
  }
  await prisma.$disconnect();
});
test("initial navigation bounds data, defers history, and streams Media without a client list fetch", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_VIEWER_EMAIL!);
  await page.getByLabel("Password").fill(process.env.SEED_VIEWER_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
  const secondary: string[] = [];
  const choices: string[] = [];
  const mediaLists: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/admin/secondary") secondary.push(u.search);
    if (u.pathname === "/api/admin/choices") choices.push(u.search);
    if (u.pathname === "/api/admin/media" && r.method() === "GET")
      mediaLists.push(u.search);
  });
  const timings = [];
  for (const kind of ["Artists", "Tracks", "Podcasts", "Releases"]) {
    const start = Date.now();
    await page.getByRole("link", { name: kind, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: kind, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".table-head")).toBeVisible();
    const rows = page.locator("a.table-row");
    expect(await rows.count()).toBeLessThanOrEqual(50);
    timings.push({ page: kind, ms: Date.now() - start });
    if (await rows.count()) {
      const detailStart = Date.now();
      await rows.first().click();
      await expect(
        page.getByRole("button", { name: "Revision history", exact: true }),
      ).toBeVisible();
      timings.push({ page: kind + " detail", ms: Date.now() - detailStart });
      expect(await page.locator("select option").count()).toBeLessThan(40);
      await expect(page.getByTestId("canonical-preview")).toHaveCount(0);
    }
  }
  expect(secondary).toEqual([]);
  expect(choices).toEqual([]);
  await page.evaluate(() => {
    const metrics: { start: number; shellMs?: number; cardsMs?: number } = {
      start: performance.now(),
    };
    (window as unknown as { mediaMetrics: typeof metrics }).mediaMetrics =
      metrics;
    const observer = new MutationObserver(() => {
      if (
        document.querySelector("h1")?.textContent === "Media" &&
        metrics.shellMs === undefined
      )
        metrics.shellMs = performance.now() - metrics.start;
      if (document.querySelector('.media-library-panel[aria-busy="false"]')) {
        metrics.cardsMs = performance.now() - metrics.start;
        observer.disconnect();
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  });
  const start = Date.now();
  await page.getByRole("link", { name: "Media", exact: true }).click();
  await expect(page.locator(".media-library-panel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(await page.locator(".media-card").count()).toBe(50);
  expect(mediaLists).toEqual([]);
  timings.push({ page: "Media populated", ms: Date.now() - start });
  const mediaMetrics = await page.evaluate(() => {
    const m = (
      window as unknown as {
        mediaMetrics: { start: number; shellMs: number; cardsMs: number };
      }
    ).mediaMetrics;
    return {
      ...m,
      resources: performance
        .getEntriesByType("resource")
        .filter((x) => x.startTime >= m.start)
        .map((x) => ({
          kind: (x as PerformanceResourceTiming).initiatorType,
          ms: x.duration,
          ttfb: (x as PerformanceResourceTiming).responseStart - x.startTime,
          path: new URL(x.name).pathname,
        })),
      images: [...document.querySelectorAll(".media-card img")].length,
      cards: document.querySelectorAll(".media-card").length,
    };
  });
  console.log("LOCAL_PRODUCTION_NAVIGATION", JSON.stringify(timings));
  console.log("MEDIA_STAGES", JSON.stringify(mediaMetrics));
  await page.goto("/admin/media?page=99999");
  await expect(page).not.toHaveURL(/page=99999/);
  await expect(page.locator(".media-library-panel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(await page.locator(".media-card").count()).toBeLessThanOrEqual(50);
});
test("history is authenticated and bounded, external audio is excluded, and filters preserve list state", async ({
  page,
}) => {
  expect(
    (await page.request.get("/api/admin/choices?kind=AUDIO")).status(),
  ).toBe(401);
  expect(
    (await page.request.get("/api/admin/secondary?kind=tracks")).status(),
  ).toBe(401);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill(process.env.SEED_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
  const audio = await (
    await page.request.get("/api/admin/choices?kind=AUDIO")
  ).json();
  expect(audio.length).toBeLessThanOrEqual(25);
  expect(audio.every((x: { status: string }) => x.status === "READY")).toBe(
    true,
  );
  await page.goto("/admin/artists?page=1&q=E2E");
  const row = page.locator("a.table-row").first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(
    page.getByRole("button", { name: "Revision history", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Revision history", exact: true })
    .click();
  await expect(page.getByText("Loading Revision history…")).toHaveCount(0);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const history = await page.request.get(
    `/api/admin/secondary?kind=artists&id=${id}&section=history`,
  );
  expect(history.status()).toBe(200);
  expect((await history.json()).items.length).toBeLessThanOrEqual(25);
  await page.getByRole("link", { name: "← Artists", exact: true }).click();
  await expect(page).toHaveURL(/page=1&q=E2E$/);
});
test("picker search cancels stale results and keeps a chosen value across another search", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(process.env.SEED_EDITOR_EMAIL!);
  await page.getByLabel("Password").fill(process.env.SEED_EDITOR_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
  await page.goto("/admin/tracks");
  await page.locator("a.table-row").first().click();
  await expect(
    page.getByRole("combobox", { name: "Primary Artist", exact: true }),
  ).toBeVisible();
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let seenA = false;
  const selectedId = "00000000-0000-4000-8000-000000000099";
  await page.route("**/api/admin/choices?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "slow") {
      seenA = true;
      await gate;
    }
    await route.fulfill({
      json:
        q === "slow"
          ? [
              {
                id: "00000000-0000-4000-8000-000000000098",
                name: "Stale result",
                legacyId: 98,
              },
            ]
          : q === "latest"
            ? [{ id: selectedId, name: "Latest choice", legacyId: 99 }]
            : [],
    });
  });
  await page
    .getByRole("textbox", { name: "Search Primary Artist", exact: true })
    .fill("slow");
  await expect.poll(() => seenA).toBe(true);
  await page
    .getByRole("textbox", { name: "Search Primary Artist", exact: true })
    .fill("latest");
  const select = page.getByRole("combobox", {
    name: "Primary Artist",
    exact: true,
  });
  await expect(select.locator(`option[value="${selectedId}"]`)).toHaveCount(1);
  await select.selectOption(selectedId);
  releaseA();
  await page
    .getByRole("textbox", { name: "Search Primary Artist", exact: true })
    .fill("empty");
  await expect(select).toHaveValue(selectedId);
  await expect(
    select.locator("option").filter({ hasText: "Stale result" }),
  ).toHaveCount(0);
  await expect(
    select.locator("option").filter({ hasText: "Latest choice" }),
  ).toHaveCount(1);
});
