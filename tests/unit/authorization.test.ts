import { describe, expect, it } from "vitest";
import { requirePermission } from "@/lib/authorization";
import { AppError } from "@/lib/errors";

describe("role permissions", () => {
  it("allows editors to write but not hard delete", () => {
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "EDITOR" }, "artist:write")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "EDITOR" }, "release:write")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "EDITOR" }, "artist:hard-delete"))
      .toThrowError(AppError);
  });

  it("keeps viewers read-only", () => {
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "artist:read")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "release:read")).not.toThrow();
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "release:write")).toThrowError(/permission/);
    expect(() => requirePermission({ userId: crypto.randomUUID(), role: "VIEWER" }, "artist:write"))
      .toThrowError(/permission/);
  });
});
