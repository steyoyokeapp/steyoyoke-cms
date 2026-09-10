import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
