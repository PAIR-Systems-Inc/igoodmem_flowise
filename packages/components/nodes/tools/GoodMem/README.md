# GoodMem node for Flowise

Gives a chatflow a long-term memory: text and documents are stored in
[GoodMem](https://goodmem.ai), and an agent recalls them by meaning rather
than by keyword.

Status: **node version 2.0**, built on the official
[`@pairsystems/goodmem`](https://www.npmjs.com/package/@pairsystems/goodmem)
SDK (`^0.1.7`). 98 offline tests and 7 live tests; see
[Developing](#developing). Version 2.0 changes the tools an agent sees —
read [Upgrading from 1.0](#upgrading-from-10) before updating a saved
chatflow.

## Setting it up

1. Add a **GoodMem API** credential: the base URL of your server and an API
   key (sent as `X-API-Key`). _Verify SSL_ stays on unless you are pointing at
   a self-signed local server; turning it off warns once per connection and
   applies only to that connection.
2. Drop the **GoodMem** node into a chatflow and connect it to an agent.
3. Pick a **Default Space**. The dropdown is loaded live from your server.

Nothing else is required. The defaults expose reading and writing memories,
and nothing destructive.

## What the agent can call

| Tool                     | Arguments                      | Enabled by default             |
| ------------------------ | ------------------------------ | ------------------------------ |
| `goodmem_search`         | `query`, `top_k`               | yes                            |
| `goodmem_remember`       | `text`                         | yes                            |
| `goodmem_list_memories`  | `space_id` (optional)          | yes                            |
| `goodmem_get_memory`     | `memory_id`, `include_content` | yes                            |
| `goodmem_list_spaces`    | —                              | yes                            |
| `goodmem_get_space`      | `space_id` (optional)          | yes                            |
| `goodmem_list_embedders` | —                              | yes                            |
| `goodmem_upload_file`    | `file_name`                    | no — needs an Upload Directory |
| `goodmem_create_space`   | `name`                         | no                             |
| `goodmem_update_space`   | `space_id`, `name`             | no — destructive               |
| `goodmem_delete_space`   | `space_id`                     | no — destructive               |
| `goodmem_delete_memory`  | `memory_id`                    | no — destructive               |

Use these names when you write a system prompt or an allow-list.

Every id — `memory_id`, `space_id`, and the Default Space, Default Embedder
and Reranker settings — must be a UUID, and anything else is refused before a
request is sent: ids are placed in the request URL, so a value such as `..` or
`../spaces/<id>` could otherwise address a different resource than the one
named.

Anything that changes _what a search means_ — the reranker, the metadata
filter, the score threshold, the upload directory — is node configuration,
not a tool argument. A model that can widen its own scope has no scope.

## Node settings

| Setting              | What it does                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Actions**          | Which tools to expose. Destructive ones are off until you switch them on.                              |
| **Default Space**    | The space the tools read and write.                                                                    |
| **Default Embedder** | Used when a space has to be created.                                                                   |
| **Reranker**         | Applied to every search.                                                                               |
| **Metadata Filter**  | A JSON object, e.g. `{"category": "support", "archived": false}`, applied server-side to every search. |
| **Minimum Score**    | Drops results below a score. See below.                                                                |
| **Upload Directory** | Absolute path that `goodmem_upload_file` is confined to.                                               |
| **Max List Items**   | Upper bound while following pagination internally. Defaults to 200.                                    |

### Scores

Each result carries `score`, `rawScore` and `scoreKind`. `score` is always
oriented so **higher is better**; `rawScore` is exactly what the server sent.

**There is no 0–1 range.** GoodMem's vector scores are negative distances, so
`score` is the flipped distance; reranker scores come from the reranker and
their scale is provider-dependent — measured live, Voyage `rerank-2.5`
produced `0.27..0.93` and Jina `jina-reranker-v3` produced `-0.14..0.43` over
the same documents. Reranker scores are never negated, which would invert the
ranking. When a configured reranker fails (`RERANKING_FAILED`, or the server
says it was not found), the hits that come back are the vector fallback: they
are labelled and oriented as vector scores, and **Minimum Score is not applied
to them** — it was tuned for a scale that never ran. The result is marked
partial and the statuses say why. Measure your own range before setting **Minimum Score**; when a
threshold removes every result the node logs the range it saw instead of
quietly returning nothing.

### Metadata filters

Values you type into **Metadata Filter** are escaped and cast to the type
GoodMem stored them as: `TEXT` for strings, `NUMERIC` for numbers, `BOOLEAN`
for booleans. The cast has to match — a boolean compared as text is accepted
by the server and matches nothing. An apostrophe in a value is escaped as
`\'`; SQL-style `''` doubling is rejected by the server.

### Uploads

`goodmem_upload_file` exists only when **Upload Directory** is set, and every
path is resolved — symlinks included — and refused unless it lands inside that
directory. A model asking for `/etc/hostname` gets an error, not the file.

## When a retrieval goes wrong

A search result carries `partial` and `statuses`, following GoodMem's
retrieval status contract:

-   A problem the server reports **with** results: the results come back,
    `partial` is `true`, and `statuses` says what failed.
-   A problem **without** results: an empty list, `partial` is `true`, and the
    warning says in as many words that this is _not_ an empty memory store — so
    an agent does not answer "you have nothing saved" after a failed search.
-   A status code this build does not recognise is reported as `UNKNOWN` rather
    than dropped, and the results are unchanged.
-   `FEATURE_DISABLED` and `LLM_CAPABILITY_INFERRED` describe optional features
    you never configured, so they are not treated as problems.

A search never polls. An empty space answers immediately.

## Upgrading from 1.0

Version 1.0 exposed eleven tools with the operation names as arguments. If a
saved chatflow or prompt refers to them, update it:

| 1.0                                                                                                                                                                                       | 2.0                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `goodmem_retrieve_memories(query, space_ids, max_results, include_memory_definition, wait_for_indexing, reranker_id, llm_id, relevance_threshold, llm_temperature, chronological_resort)` | `goodmem_search(query, top_k)` — the rest is node configuration                |
| `goodmem_create_memory(space_id, text_content, file_path, metadata)`                                                                                                                      | `goodmem_remember(text)`, and `goodmem_upload_file(file_name)` for files       |
| `goodmem_update_space(..., public_read, ...)`                                                                                                                                             | `goodmem_update_space(space_id, name)` — the server rejects `publicRead`       |
| `goodmem_list_memories(..., next_token, filter_expression, ...)`                                                                                                                          | `goodmem_list_memories(space_id)` — pagination and filters are handled for you |

Delete and rename tools are no longer exposed unless you select them, and
`file_path` is gone: uploads are confined to the Upload Directory.

## Developing

Run from `packages/components`:

```bash
npx jest nodes/tools/GoodMem          # 98 offline tests
npx tsc --noEmit -p tsconfig.json     # typecheck
npx eslint "nodes/tools/GoodMem/**/*.ts"
```

The offline suite drives the real SDK against a mock transport replaying
NDJSON captured from a live server (`testing/fixtures/`), so it exercises the
integration rather than a stub of it.

The live suite runs only when a server is configured, and skips otherwise:

```bash
GOODMEM_BASE_URL=https://localhost:8080 \
GOODMEM_API_KEY=gm_... \
GOODMEM_VERIFY_SSL=false \
npx jest nodes/tools/GoodMem/__tests__/live
```

It creates its own space, verifies teardown against a fresh server inventory,
and leaves nothing behind.

The audit that produced this rewrite — the frozen 1.0 sources, the
reproduction harness and the measured before/after — is in
[`packages/components/audit/goodmem/`](../../../audit/goodmem/). It is
excluded from the build.

## Known limitations

-   When the server sends a status code the SDK does not know, the SDK replaces
    the code with `null` before this node sees it. The status is still reported
    (as `UNKNOWN`, with the server's message intact) and results are unaffected,
    but the server's own code string is lost. Fixing it belongs in the SDK.
-   `Minimum Score` is applied by this node after the server responds, so it
    reduces what the agent sees but not what the server computed.
