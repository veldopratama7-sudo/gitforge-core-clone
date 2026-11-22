// gitforge — a GitHub-compatible git forge for make.fun's github-core-clone-01.
// Entry point: contest lifecycle only (bind ephemeral port, register with the
// trial env, serve until the env reports done, then exit 0). All the forge
// surfaces live in app.ts.
import { startServer } from "./app.ts";

const envUrl = process.env.MAKEFUN_ENV_URL;
const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? "";

const server = startServer(shopToken);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
if (addr === null || typeof addr !== "object") throw new Error("no address");
const port = addr.port;

if (!envUrl) {
  // Local mode: no trial env to talk to. Serve until interrupted.
  console.log(`gitforge listening on http://127.0.0.1:${port}`);
} else {
  await register(envUrl, port);
  await waitUntilDone(envUrl);
  server.close();
  process.exit(0);
}

async function register(base: string, port: number): Promise<void> {
  let delay = 200;
  for (;;) {
    try {
      const res = await fetch(new URL("/register", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      if (res.status === 409) return; // first register wins
      throw new Error(`register ${res.status}`);
    } catch (err) {
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
}

async function waitUntilDone(base: string): Promise<void> {
  let delay = 300;
  for (;;) {
    try {
      const res = await fetch(new URL("/done", base));
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
        delay = 300;
      } else {
        throw new Error(`done ${res.status}`);
      }
    } catch {
      // keep polling through transient errors
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
