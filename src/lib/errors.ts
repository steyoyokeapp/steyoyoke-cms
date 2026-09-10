export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }

  log("error", "internal_error", { errorName: error instanceof Error ? error.name : "UnknownError" });
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
    { status: 500 },
  );
}
import { log } from "@/lib/logger";
