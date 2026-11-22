// server-child.mjs — run the forge in a child process for cross-process tests.
// Prints PORTURL=<url> once listening.
import { startServer } from "../app.ts";

const token = process.argv[2] ?? "test-token";
const server = startServer(token);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`PORTURL=${base}`);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
