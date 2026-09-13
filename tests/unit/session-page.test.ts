import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  memo: new Map<unknown, unknown>(),
  headers: new Headers(),
}));
// Model React's per-render cache lifetime, reset for every simulated request.
vi.mock("react", () => ({
  cache: (fn: () => unknown) => () => {
    if (!state.memo.has(fn)) state.memo.set(fn, fn());
    return state.memo.get(fn);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: state.getSession } },
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect");
  }),
}));
import { actorForPage, actorFromHeaders, sessionForPage } from "@/lib/session";
beforeEach(() => {
  state.memo.clear();
  state.getSession.mockReset();
  state.getSession.mockResolvedValue({
    user: { id: "a", role: "VIEWER", name: "A" },
  });
});
it("layout/page share session resolution only within the React request", async () => {
  await Promise.all([sessionForPage(), actorForPage()]);
  expect(state.getSession).toHaveBeenCalledTimes(1);
  state.memo.clear();
  state.getSession.mockResolvedValue({ user: { id: "b", role: "EDITOR" } });
  expect((await actorForPage()).userId).toBe("b");
  expect(state.getSession).toHaveBeenCalledTimes(2);
});
it("mutation authentication always resolves authoritatively, even after a page read", async () => {
  await sessionForPage();
  state.getSession.mockResolvedValue(null);
  await expect(actorFromHeaders(new Headers())).rejects.toMatchObject({
    status: 401,
  });
  await expect(actorFromHeaders(new Headers())).rejects.toMatchObject({
    status: 401,
  });
  expect(state.getSession).toHaveBeenCalledTimes(3);
});
it("invalid roles fail closed", async () => {
  state.getSession.mockResolvedValue({ user: { id: "a", role: "OWNER" } });
  await expect(actorForPage()).rejects.toMatchObject({ status: 403 });
});
