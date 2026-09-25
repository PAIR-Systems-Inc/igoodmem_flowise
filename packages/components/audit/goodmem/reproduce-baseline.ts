/** Baseline reproduction: drives the SHIPPED GoodMem tools over a mock GoodMem server. */
import * as fs from 'fs'
import { startMock, fixture, UNKNOWN_STATUS } from './mockServer'
import { createGoodMemTools } from './baseline/core'
import { GoodMemClient } from './baseline/client'
import { TOOL_ARGS_PREFIX } from '../../src/agents'

const A = (label: string, detail: string) => console.log(`\n### ${label}\n${detail}`)
const parse = (s: string) => JSON.parse(s.split(TOOL_ARGS_PREFIX)[0])
const mk = (url: string, extra: any = {}) =>
    createGoodMemTools({ baseUrl: url, apiKey: 'gm_test', defaultSpaceId: 'space-EXISTING', ...extra })
const byName = (tools: any[], n: string) => tools.find((t) => t.name === n)!

async function main() {
    console.log('BASELINE REPRODUCTION — Flowise GoodMem node @ 0118886e')
    console.log('server: mock, NDJSON captured from live server-v1.0.320')

    // ---- P28: model-facing surface ----
    {
        const tools = mk('http://x')
        A(
            'P28 over-broad tool surface (default config)',
            `  tools exposed by default: ${tools.length}\n` +
                tools.map((t: any) => `    - ${t.name}`).join('\n') +
                `\n  destructive present: ${tools
                    .filter((t: any) => /delete|update/.test(t.name))
                    .map((t: any) => t.name)
                    .join(', ')}`
        )
        const retrieve: any = byName(tools, 'goodmem_retrieve_memories')
        const argNames = Object.keys(retrieve.schema.shape)
        A(
            'P28b retrieve argument surface',
            `  goodmem_retrieve_memories takes ${argNames.length} model-supplied args:\n    ${argNames.join(', ')}`
        )
        const cm: any = byName(tools, 'goodmem_create_memory')
        A(
            'P10 model-controlled file path (schema)',
            `  goodmem_create_memory args: ${Object.keys(cm.schema.shape).join(', ')}\n` +
                `  file_path description: ${cm.schema.shape.file_path.description}`
        )
        const us: any = byName(tools, 'goodmem_update_space')
        A('P2 publicRead is a model-facing argument', `  goodmem_update_space args: ${Object.keys(us.schema.shape).join(', ')}`)
        const lm: any = byName(tools, 'goodmem_list_memories')
        A('P34 raw filter expression is model-facing', `  filter_expression: ${lm.schema.shape.filter_expression.description}`)
        A(
            'P29 score semantics in the schema shown to the model',
            `  relevance_threshold: ${retrieve.schema.shape.relevance_threshold.description}`
        )
    }

    // ---- P4 / P38: statuses dropped, success hardcoded ----
    {
        const m = await startMock({ retrieveBody: fixture('retrieve_degraded_hits.ndjson') })
        const t: any = byName(mk(m.url), 'goodmem_retrieve_memories')
        const out = parse(await t._call({ query: 'q', max_results: 5 }))
        A(
            'P4 retrieval statuses dropped (Q4a: problem + hits)',
            `  server sent: NOT_FOUND, FEATURE_DISABLED, RERANKING_FAILED (3 status events)\n` +
                `  tool returned keys: ${Object.keys(out).join(', ')}\n` +
                `  success=${out.success}  totalResults=${out.totalResults}\n` +
                `  statuses surfaced: ${out.statuses ?? 'NONE — the reranker failure is invisible to the agent'}\n` +
                `  partial flag: ${out.partial ?? 'absent'}`
        )
        await m.close()
    }
    {
        const m = await startMock({ retrieveBody: UNKNOWN_STATUS })
        const t: any = byName(mk(m.url), 'goodmem_retrieve_memories')
        const out = parse(await t._call({ query: 'q' }))
        A(
            'P3 unknown status code (forward compatibility)',
            `  server sent: TEST_ONLY_FUTURE_RETRIEVAL_STATUS_9E4AD2\n` +
                `  tool returned: success=${out.success} totalResults=${out.totalResults} statuses=${
                    out.statuses ?? 'NONE — dropped silently'
                }`
        )
        await m.close()
    }

    // ---- P5 + Q4b: empty results poll for 60s ----
    {
        const m = await startMock({ retrieveBody: fixture('retrieve_degraded_empty.ndjson') })
        const t: any = byName(mk(m.url), 'goodmem_retrieve_memories')
        const t0 = Date.now()
        const out = parse(await t._call({ query: 'q', wait_for_indexing: true }))
        const secs = ((Date.now() - t0) / 1000).toFixed(1)
        A(
            'P5 + Q4b failed retrieval polled as if empty',
            `  server said RERANKING_FAILED and returned no hits (a FAILURE, not an empty index)\n` +
                `  elapsed: ${secs}s   HTTP retrieve calls: ${m.retrieveCalls}\n` +
                `  success=${out.success}  message=${JSON.stringify(out.message ?? null)}\n` +
                `  statuses: ${out.statuses ?? 'NONE'}`
        )
        await m.close()
    }

    // ---- P32: embedder reuse lies ----
    {
        const m = await startMock({ spaceEmbedderId: 'emb-REAL' })
        const t: any = byName(mk(m.url), 'goodmem_create_space')
        const out = parse(
            await t._call({
                name: 'demo-space',
                embedder_id: 'emb-ASKED-FOR',
                chunking_strategy: 'recursive',
                chunk_size: 512,
                chunk_overlap: 50
            })
        )
        A(
            'P32 unchecked embedder reuse',
            `  existing space "demo-space" is built on: emb-REAL\n` +
                `  caller asked for:                        emb-ASKED-FOR\n` +
                `  tool reported embedderId:                ${out.embedderId}   <-- the one asked for\n` +
                `  reused=${out.reused}  success=${out.success}`
        )
        await m.close()
    }

    // ---- P2 live-shaped 400 ----
    {
        const m = await startMock({})
        const t: any = byName(mk(m.url), 'goodmem_update_space')
        const raw = await t._call({ space_id: 'space-EXISTING', public_read: true })
        A('P2 publicRead rejected by the server', `  sent body contained publicRead -> ${raw.split(TOOL_ARGS_PREFIX)[0].slice(0, 120)}`)
        await m.close()
    }

    // ---- P16 binary content mangled ----
    {
        const bin = Buffer.from([
            0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0xff, 0xfe, 0x00, 0x01
        ])
        const m = await startMock({ pdfBytes: bin })
        const t: any = byName(mk(m.url), 'goodmem_get_memory')
        const out = parse(await t._call({ memory_id: 'mem-1', include_content: true }))
        const got = Buffer.from(out.content, 'utf-8')
        A(
            'P16 binary content force-decoded as text',
            `  server sent ${bin.length} bytes of application/pdf\n` +
                `  tool returned a JS string of ${String(out.content).length} chars -> ${got.length} bytes when re-encoded\n` +
                `  byte-identical: ${got.equals(bin)}\n` +
                `  U+FFFD replacement chars: ${(String(out.content).match(/�/g) || []).length}`
        )
        await m.close()
    }

    // ---- P30 positional join / P29 raw negative score ----
    {
        const m = await startMock({ retrieveBody: fixture('retrieve_ok.ndjson') })
        const t: any = byName(mk(m.url), 'goodmem_retrieve_memories')
        const out = parse(await t._call({ query: 'q' }))
        A(
            'P29 / P30 score + chunk-to-memory join',
            `  result[0]: ${JSON.stringify(out.results[0])}\n` +
                `  relevanceScore is a NEGATIVE distance, handed to the model as-is\n` +
                `  the schema tells the model the threshold range is "0-1" -> threshold 0.5 drops every vector hit\n` +
                `  memories[] returned separately; chunks point at them by memoryIndex (arrival position), not memoryId`
        )
        await m.close()
    }

    // ---- P6 pagination pushed onto the model ----
    {
        const m = await startMock({})
        const t: any = byName(mk(m.url), 'goodmem_list_memories')
        const out = parse(await t._call({ include_content: false }))
        A(
            'P6 first-page-only listing',
            `  list_memories returned ${out.totalMemories} memories + nextToken=${JSON.stringify(out.nextToken)}\n` +
                `  the model must notice the token and call again; listSpaces/listEmbedders have no pagination at all`
        )
        const c = new GoodMemClient({ baseUrl: m.url, apiKey: 'k' })
        const spaces = await c.listSpaces()
        A('P6b listSpaces', `  returns a bare array of ${spaces.length}; no token handling in the client at all`)
        await m.close()
    }

    // ---- P10 live file read ----
    {
        const m = await startMock({})
        const t: any = byName(mk(m.url), 'goodmem_create_memory')
        const out = parse(await t._call({ file_path: '/etc/hostname' }))
        const sent = JSON.parse(m.requests.filter((r) => r.path === '/v1/memories').pop()!.body)
        A(
            'P10 model-supplied path read off the host disk',
            `  model called goodmem_create_memory(file_path="/etc/hostname")\n` +
                `  result: success=${out.success} memoryId=${out.memoryId}\n` +
                `  bytes actually uploaded: ${JSON.stringify(sent.originalContent ?? sent.originalContentB64)}\n` +
                `  /etc/hostname on this host: ${JSON.stringify(fs.readFileSync('/etc/hostname', 'utf-8'))}`
        )
        await m.close()
    }

    // ---- P34 injection reaches the server verbatim ----
    {
        const m = await startMock({})
        const t: any = byName(mk(m.url), 'goodmem_list_memories')
        await t._call({ filter_expression: "val('$.owner') = 'x' OR '1'='1" })
        const req = m.requests.filter((r) => r.path.includes('/memories?')).pop()!
        A(
            'P34 filter expression interpolated verbatim',
            `  model supplied: val('$.owner') = 'x' OR '1'='1\n` + `  query string sent: ${decodeURIComponent(req.path)}`
        )
        await m.close()
    }

    console.log('\nDONE')
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
