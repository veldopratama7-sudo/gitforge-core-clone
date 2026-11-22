# gitforge — GitHub-compatible git forge (github-core-clone-01)

A single-process, dependency-free Node 22 forge that speaks four surfaces from
one in-memory store:

- **git smart HTTP** — protocol v2 and v0 (`info/refs`, `git-upload-pack`,
  `git-receive-pack`), shallow/deepen, thin packs with OFS/REF deltas,
  fast-forward enforcement, report-status, side-band-64k.
- **REST v3** under `/api/v3` — repos, branches, refs, commits, contents
  (blob-sha checks), labels, issues + comments, pulls (squash merge, conflict
  405), bearer auth, pagination `Link` headers.
- **GraphQL** at `/api/graphql` — hand-written tokenizer/parser/exec, viewer,
  repository, node, cursor pagination, introspection, 5 mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP (2026-07-28), tools/list +
  8 tools.

Lifecycle (`main.ts`): bind an ephemeral port, `POST {port}` to
`$MAKEFUN_ENV_URL/register`, serve until `{"done":true}` on `/done`, exit 0.

Run tests:

    node --experimental-strip-types test/smoke.mjs     # 50 checks (REST/GraphQL/MCP/git HTTP)
    node --experimental-strip-types test/git-cli.mjs   # 15 checks with a real git client
