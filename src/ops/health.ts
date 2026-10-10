export interface HealthSource {
  health(): unknown;
}
export function serveHealth(
  source: HealthSource,
  options: { port?: number; hostname?: string } = {},
) {
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 9090,
    fetch: (request) =>
      new URL(request.url).pathname === "/health"
        ? Response.json(source.health())
        : new Response("Not found", { status: 404 }),
  });
}
