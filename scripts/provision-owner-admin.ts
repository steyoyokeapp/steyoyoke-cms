import "dotenv/config";
import { z } from "zod";
import { OwnerAdminAlreadyExistsError, provisionOwnerAdmin } from "../src/lib/owner-admin";
import { prisma } from "../src/lib/prisma";

const runtimeInput = z.object({
  OWNER_ADMIN_EMAIL: z.email(),
  OWNER_ADMIN_NAME: z.string().trim().min(1).max(100).default("Steyoyoke Owner"),
  OWNER_ADMIN_PASSWORD: z.string().min(12).max(128),
});

try {
  const input = runtimeInput.parse(process.env);
  await provisionOwnerAdmin({
    email: input.OWNER_ADMIN_EMAIL,
    name: input.OWNER_ADMIN_NAME,
    password: input.OWNER_ADMIN_PASSWORD,
  });
  console.log("Owner ADMIN account created successfully. No credentials were printed.");
} catch (error) {
  if (error instanceof OwnerAdminAlreadyExistsError) {
    console.error(error.message);
  } else if (error instanceof z.ZodError) {
    console.error("Invalid owner ADMIN input. Check the email, name, and password length requirements.");
  } else {
    console.error("Owner ADMIN provisioning failed. No credentials were printed.");
  }
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
