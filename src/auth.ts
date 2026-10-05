export function authenticate(request: Request, token: string): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization === `Bearer ${token}`) return true;

  const url = new URL(request.url);
  return url.searchParams.get("token") === token;
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
