import { describe, expect, it, vi } from "vitest";
import { assertLocalCmsDatabase } from "../../scripts/local-database";
import { PasswordResetCredentialNotFoundError, PasswordResetUserNotFoundError, resetExistingUserPassword, type PasswordResetDependencies } from "@/lib/password-reset";

const target = { userId: "00000000-0000-4000-8000-000000000001", credentialAccountId: "credential-account" };

function dependencies(found: typeof target | null = target) {
  return {
    findTarget: vi.fn().mockResolvedValue(found),
    hashPassword: vi.fn().mockResolvedValue("better-auth-scrypt-hash"),
    updateCredentialAndRevokeSessions: vi.fn().mockResolvedValue({ revokedSessions: 2 }),
  } satisfies PasswordResetDependencies;
}

describe("existing-user password reset", () => {
  it("normalizes email, hashes through the configured dependency, and updates only the credential target", async () => {
    const resetter = dependencies(); const password = "new-owner-password-1234";
    await expect(resetExistingUserPassword({ email: " OWNER@TEST.LOCAL ", password }, resetter)).resolves.toEqual({ revokedSessions: 2 });
    expect(resetter.findTarget).toHaveBeenCalledWith("owner@test.local");
    expect(resetter.hashPassword).toHaveBeenCalledWith(password);
    expect(resetter.updateCredentialAndRevokeSessions).toHaveBeenCalledWith(target, "better-auth-scrypt-hash");
    expect(resetter.updateCredentialAndRevokeSessions).not.toHaveBeenCalledWith(target, password);
  });

  it("fails before hashing or writing when the email does not exist", async () => {
    const resetter = dependencies(null);
    await expect(resetExistingUserPassword({ email: "missing@test.local", password: "new-owner-password-1234" }, resetter)).rejects.toBeInstanceOf(PasswordResetUserNotFoundError);
    expect(resetter.hashPassword).not.toHaveBeenCalled(); expect(resetter.updateCredentialAndRevokeSessions).not.toHaveBeenCalled();
  });

  it("fails before hashing or writing when the user has no password credential", async () => {
    const resetter = dependencies(); resetter.findTarget.mockRejectedValue(new PasswordResetCredentialNotFoundError());
    await expect(resetExistingUserPassword({ email: "owner@test.local", password: "new-owner-password-1234" }, resetter)).rejects.toBeInstanceOf(PasswordResetCredentialNotFoundError);
    expect(resetter.hashPassword).not.toHaveBeenCalled(); expect(resetter.updateCredentialAndRevokeSessions).not.toHaveBeenCalled();
  });

  it("allows only the dedicated local CMS database", () => {
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@127.0.0.1:5432/steyoyoke_cms_local")).not.toThrow();
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@[::1]:5432/steyoyoke_cms_local")).not.toThrow();
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@localhost:5432/steyoyoke_cms_test")).toThrow(/restricted/);
    expect(() => assertLocalCmsDatabase("postgresql://cms:test@ep-example.neon.tech/steyoyoke")).toThrow(/restricted/);
  });
});
