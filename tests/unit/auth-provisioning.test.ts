import { describe, expect, it, vi } from "vitest";
import { auth } from "@/lib/auth";
import {
  OwnerAdminAlreadyExistsError,
  provisionOwnerAdmin,
  type OwnerAdminProvisioningDependencies,
} from "@/lib/owner-admin";

const owner = {
  email: "OWNER@test.local",
  name: " Catalogue Owner ",
  password: "owner-test-password-1234",
};

function dependencies(existingUserId: string | null = null) {
  return {
    findUserIdByEmail: vi.fn().mockResolvedValue(existingUserId),
    hashPassword: vi.fn().mockResolvedValue("better-auth-password-hash"),
    createOwnerWithCredential: vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@test.local",
      role: "ADMIN" as const,
    }),
  } satisfies OwnerAdminProvisioningDependencies;
}

describe("owner ADMIN provisioning", () => {
  it("normalizes input and passes only a Better Auth hash to atomic creation", async () => {
    const provisioner = dependencies();
    const created = await provisionOwnerAdmin(owner, provisioner);

    expect(created).toMatchObject({ email: "owner@test.local", role: "ADMIN" });
    expect(provisioner.findUserIdByEmail).toHaveBeenCalledWith("owner@test.local");
    expect(provisioner.hashPassword).toHaveBeenCalledWith(owner.password);
    expect(provisioner.createOwnerWithCredential).toHaveBeenCalledWith({
      email: "owner@test.local",
      name: "Catalogue Owner",
      passwordHash: "better-auth-password-hash",
    });
    expect(provisioner.createOwnerWithCredential).not.toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: owner.password }),
    );
  });

  it("refuses a duplicate email before hashing or writing", async () => {
    const provisioner = dependencies("existing-user-id");

    await expect(provisionOwnerAdmin(owner, provisioner)).rejects.toBeInstanceOf(
      OwnerAdminAlreadyExistsError,
    );
    expect(provisioner.hashPassword).not.toHaveBeenCalled();
    expect(provisioner.createOwnerWithCredential).not.toHaveBeenCalled();
  });

  it("uses the configured Better Auth hasher and keeps public signup closed", async () => {
    const context = await auth.$context;
    const hash = await context.password.hash(owner.password);

    expect(hash).not.toBe(owner.password);
    expect(await context.password.verify({ hash, password: owner.password })).toBe(true);
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
  });
});
