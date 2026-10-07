import { createHash, timingSafeEqual } from "node:crypto";

export function authenticate(request: Request, token: string): boolean {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (bearer && secureCompare(bearer, token)) return true;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return queryToken !== null && secureCompare(queryToken, token);
}

function secureCompare(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": "Bearer",
      "cache-control": "no-store",
    },
  });
}
