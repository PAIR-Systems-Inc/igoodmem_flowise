# Captured retrieval streams

Recorded from a live GoodMem server (`server-v1.0.320`) and replayed by the
offline suite, so the tests assert against event shapes the server really
produces rather than shapes this repo invented.

| File                             | What it captures                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `retrieve_ok.ndjson`             | A healthy retrieval: boundary, memory definition, one chunk (vector score `-0.5845…`), closing boundary.                                      |
| `retrieve_degraded_hits.ndjson`  | The same retrieval with a broken reranker: `NOT_FOUND`, `FEATURE_DISABLED` and `RERANKING_FAILED` arrive _before_ the hit. Contract case Q4a. |
| `retrieve_degraded_empty.ndjson` | The same three statuses with no hit at all. Contract case Q4b — a failure, not an empty index.                                                |
| `retrieve_unknown_status.ndjson` | A status code no released build knows, between two chunks. Contract case Q3.                                                                  |
