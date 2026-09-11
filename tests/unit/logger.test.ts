import { afterEach, describe, expect, it, vi } from "vitest";
import { logSafeError, safeErrorFields } from "@/lib/logger";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.restoreAllMocks();
});

describe("safe error logging", () => {
  it("redacts credentials from sanitized messages and stacks", () => {
    process.env.DATABASE_URL = "postgresql://owner:database-password@example.test/catalogue";
    const secret = process.env.DATABASE_URL;
    const error = new Error(`failed with ${secret} and AKIA1234567890ABCDEF`);
    const fields = safeErrorFields(error);

    expect(fields.errorMessage).toContain("[REDACTED]");
    expect(fields.errorStack).toContain("[REDACTED]");
    expect(JSON.stringify(fields)).not.toContain(secret);
    expect(JSON.stringify(fields)).not.toContain("example.test/catalogue");
    expect(JSON.stringify(fields)).not.toContain("AKIA1234567890ABCDEF");
  });

  it("emits structured operational context without raw error data", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSafeError("media_image_upload_failed", new Error("safe failure summary"), { requestId: "iad1::request", operation: "image upload", failureKind: "storage" });

    const record = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(record).toMatchObject({ event: "media_image_upload_failed", requestId: "iad1::request", operation: "image upload", failureKind: "storage", errorName: "Error", errorMessage: "safe failure summary" });
    expect(record.errorStack).toContain("Error: safe failure summary");
  });
});
