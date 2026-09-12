/** Runtime reverse proxy from the public Next origin to the private Python API. */
export async function proxyToPython(
  request: Request,
  prefix: "api" | "orchestrator",
  path: string[]
): Promise<Response> {
  const base = (process.env.PYTHON_API_URL || "http://127.0.0.1:5050").replace(/\/$/, "");
  const incoming = new URL(request.url);
  const suffix = path.map(encodeURIComponent).join("/");
  const target = `${base}/${prefix}/${suffix}${incoming.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("accept-encoding");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
    cache: "no-store",
    // Match v3's solve budget; otherwise the proxy fails before the UI's
    // long-running scenario recovery path has had its advertised wait.
    signal: AbortSignal.timeout(600_000)
  };
  if (request.body) init.duplex = "half";

  try {
    const upstream = await fetch(target, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("connection");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("set-cookie");
    for (const value of upstream.headers.getSetCookie()) {
      responseHeaders.append("set-cookie", value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Python API is unavailable";
    return Response.json(
      { error: { code: "BACKEND_UNAVAILABLE", message } },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}
