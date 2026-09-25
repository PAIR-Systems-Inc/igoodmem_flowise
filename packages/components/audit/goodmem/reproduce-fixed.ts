/** The same scenarios as reproduce-baseline.ts, driven through the rewrite. */
import * as fs from 'fs'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startMock, fixture, UNKNOWN_STATUS } from './mockServer'
import { createGoodMemTools, GOODMEM_ACTIONS } from '../../nodes/tools/GoodMem/core'
import { GoodMemConnection } from '../../nodes/tools/GoodMem/client'
import { equals } from '../../nodes/tools/GoodMem/filters'
import { TOOL_ARGS_PREFIX } from '../../src/agents'

const A = (label: string, detail: string) => console.log(`\n### ${label}\n${detail}`)
const parse = (s: string) => JSON.parse(s.split(TOOL_ARGS_PREFIX)[0])
const mk = (url: string, extra: any = {}) =>
    createGoodMemTools({ baseUrl: url, apiKey: 'gm_test', defaultSpaceId: 'space-EXISTING', ...extra })
const byName = (tools: any[], n: string) => tools.find((t) => t.name === n)!

async function main() {
    console.log('FIXED BEHAVIOUR -- Flowise GoodMem node after the rewrite')
    console.log('server: mock, NDJSON captured from live server-v1.0.320')

    {
        const tools = mk('http://x')
        A(
            'P28 over-broad tool surface (default config)',
            `  tools exposed by default: ${tools.length}\n` +
                tools.map((t: any) => `    - ${t.name}`).join('\n') +
                `\n  destructive present: ${
                    tools
                        .filter((t: any) => /delete|update/.test(t.name))
                        .map((t: any) => t.name)
                        .join(', ') || 'NONE'
                }`
        )
        const search: any = byName(tools, 'goodmem_search')
        A('P28b search argument surface', `  goodmem_search takes: ${Object.keys(search.schema.shape).join(', ')}`)
        const all = mk('http://x', { actions: [...GOODMEM_ACTIONS] })
        A(
            'P10 model-controlled file path',
            `  goodmem_upload_file present without an upload directory: ${all.some((t: any) => t.name === 'goodmem_upload_file')}\n` +
                `  file_path argument anywhere in the surface: ${all.some((t: any) => 'file_path' in (t as any).schema.shape)}`
        )
        A(
            'P2 publicRead',
            `  public_read argument anywhere in the surface: ${all.some((t: any) => 'public_read' in (t as any).schema.shape)}`
        )
        A(
            'P34 raw filter expression',
            `  filter_expression argument anywhere in the surface: ${all.some(
                (t: any) => 'filter_expression' in (t as any).schema.shape
            )}\n` + `  developer-set filter is escaped: ${equals('owner', "x' OR '1'='1")}`
        )
        A(
            'P29 score semantics in the schema shown to the model',
            `  relevance_threshold argument: ${all.some((t: any) => 'relevance_threshold' in (t as any).schema.shape)} ` +
                `(it is node configuration, described as "not a 0-1 range")`
        )
    }

    {
        const m = await startMock({ retrieveBody: fixture('retrieve_degraded_hits.ndjson') })
        const t: any = byName(mk(m.url), 'goodmem_search')
        const out = parse(await t._call({ query: 'q', top_k: 5 }))
        A(
            'P4 retrieval statuses (Q4a: problem + hits)',
            `  server sent: NOT_FOUND, FEATURE_DISABLED, RERANKING_FAILED (3 status events)\n` +
                `  tool returned keys: ${Object.keys(out).join(', ')}\n` +
                `  totalResults=${out.totalResults}  partial=${out.partial}\n` +
                `  statuses surfaced: ${out.statuses.map((s: any) => s.code).join(', ')}   (FEATURE_DISABLED filtered per Q1)\n` +
                `  warning: ${out.warning?.slice(0, 90)}...`
        )
        await m.close()
    }
    {
        const m = await startMock({ retrieveBody: UNKNOWN_STATUS })
        const t: any = byName(mk(m.url), 'goodmem_search')
        const out = parse(await t._call({ query: 'q' }))
        A(
            'P3 unknown status code (forward compatibility)',
            `  tool returned: totalResults=${out.totalResults} partial=${out.partial} ` +
                `statuses=${out.statuses.map((s: any) => s.code).join(', ')}\n` +
                `  message kept: ${JSON.stringify(out.statuses[0]?.message)}`
        )
        await m.close()
    }
    {
        const m = await startMock({ retrieveBody: fixture('retrieve_degraded_empty.ndjson') })
        const t: any = byName(mk(m.url), 'goodmem_search')
        const t0 = Date.now()
        const out = parse(await t._call({ query: 'q' }))
        A(
            'P5 + Q4b failed retrieval with no hits',
            `  elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s   HTTP retrieve calls: ${m.retrieveCalls}\n` +
                `  totalResults=${out.totalResults} partial=${out.partial} statuses=${out.statuses.map((s: any) => s.code).join(', ')}\n` +
                `  warning: ${out.warning?.slice(0, 120)}`
        )
        await m.close()
    }
    {
        const m = await startMock({ spaceEmbedderId: 'emb-REAL' })
        const c = new GoodMemConnection({ baseUrl: m.url, apiKey: 'k', defaultEmbedderId: 'emb-ASKED-FOR' })
        let outcome: string
        try {
            outcome = JSON.stringify(await c.createSpace('demo-space'))
        } catch (error: any) {
            outcome = `REFUSED -- ${error.message}`
        }
        A(
            'P32 unchecked embedder reuse',
            `  existing space "demo-space" is built on: emb-REAL\n  caller asked for: emb-ASKED-FOR\n  result: ${outcome}`
        )
        await m.close()
    }
    {
        const m = await startMock({})
        const c = new GoodMemConnection({ baseUrl: m.url, apiKey: 'k' })
        await c.updateSpace('space-EXISTING', { name: 'renamed' })
        const put = m.requests.filter((r) => r.method === 'PUT').pop()!
        A('P2 publicRead on the wire', `  PUT body: ${put.body}   (no publicRead -> no 400)`)
        await m.close()
    }
    {
        const bin = Buffer.from([
            0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0xff, 0xfe, 0x00, 0x01
        ])
        const m = await startMock({ pdfBytes: bin })
        const t: any = byName(mk(m.url, { actions: [...GOODMEM_ACTIONS] }), 'goodmem_get_memory')
        const out = parse(await t._call({ memory_id: 'mem-1', include_content: true }))
        const round = Buffer.from(out.contentBase64 ?? '', 'base64')
        A(
            'P16 binary content',
            `  server sent ${bin.length} bytes of application/pdf\n` +
                `  encoding: ${out.contentEncoding}  bytes reported: ${out.contentBytes}\n` +
                `  byte-identical after decode: ${round.equals(bin)}  U+FFFD: ${(JSON.stringify(out).match(/\\ufffd/gi) || []).length}`
        )
        await m.close()
    }
    {
        const m = await startMock({ retrieveBody: fixture('retrieve_ok.ndjson') })
        const t: any = byName(mk(m.url), 'goodmem_search')
        const out = parse(await t._call({ query: 'q' }))
        const r = out.results[0]
        A(
            'P29 / P30 score + chunk-to-memory join',
            `  score=${r.score} rawScore=${r.rawScore} scoreKind=${r.scoreKind}\n` +
                `  memoryId=${r.memoryId}  spaceId=${r.spaceId}  (joined by UUID, not arrival position)`
        )
        await m.close()
    }
    {
        const m = await startMock({})
        const t: any = byName(mk(m.url), 'goodmem_list_memories')
        const out = parse(await t._call({}))
        A(
            'P6 listing',
            `  list_memories returned ${out.totalMemories} memories, truncated=${out.truncated}, nextToken exposed: ${'nextToken' in out}`
        )
        await m.close()
    }
    {
        const dir = mkdtempSync(join(tmpdir(), 'gm-upload-'))
        writeFileSync(join(dir, 'allowed.txt'), 'inside the boundary')
        const m = await startMock({})
        const t: any = byName(mk(m.url, { actions: [...GOODMEM_ACTIONS], uploadDir: dir }), 'goodmem_upload_file')
        const escaped = await t._call({ file_name: '/etc/hostname' })
        const allowed = await t._call({ file_name: 'allowed.txt' })
        A(
            'P10 model-supplied path',
            `  goodmem_upload_file(file_name="/etc/hostname") -> ${escaped.split(TOOL_ARGS_PREFIX)[0].slice(0, 110)}\n` +
                `  goodmem_upload_file(file_name="allowed.txt")  -> ${allowed.split(TOOL_ARGS_PREFIX)[0].slice(0, 110)}\n` +
                `  /etc/hostname reached the server: ${m.requests.some((r) => r.body.includes('bashar'))}`
        )
        await m.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }

    console.log('\nDONE')
}
main().catch((e) => {
    console.error(e)
    process.exit(1)
})
