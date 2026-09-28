/**
 * Ids that reach a URL path.
 *
 * GoodMem ids are UUIDs, and several of them are interpolated into a request
 * path (`/v1/memories/{id}`, `/v1/spaces/{id}`, `/v1/spaces/{id}/memories`).
 * The SDK percent-encodes `/`, but not `.`, and resolves the URL afterwards,
 * so `..` walks up the path on the client; what the server does with an
 * encoded `..%2Fspaces%2F<id>` is outside this node's control. So every entry
 * point that accepts an id -- from the model, from a developer calling the
 * connection, or from node configuration -- must refuse a non-UUID id before a
 * single request is made.
 *
 * Each case drives the real `@pairsystems/goodmem` SDK against a server that
 * records every request, and asserts that the server recorded nothing. This
 * file deliberately imports nothing but the node's public surface, so it can
 * be run against an older build to show what that build sent.
 */

import { toJsonSchema } from '@langchain/core/utils/json_schema'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TOOL_ARGS_PREFIX } from '../../../../src/agents'
import { GoodMemConnection } from '../client'
import { createGoodMemTools, GOODMEM_ACTIONS } from '../core'
import { MOCK_IDS, MockServer, startMockGoodMem } from '../testing/mockGoodMem'

const { nodeClass: GoodMemNode } = require('../GoodMem')

const OK = require('fs').readFileSync(join(__dirname, '..', 'testing', 'fixtures', 'retrieve_ok.ndjson'), 'utf-8')

/** A space somebody would like to see deleted. */
const U = '0199b8a0-dead-7000-8000-00000000beef'

const HOSTILE = [
    `../spaces/${U}`,
    `a/../../spaces/${U}`,
    `%2e%2e/spaces/${U}`,
    `..%2Fspaces%2F${U}`,
    `${U}/../../spaces/${U}`,
    '',
    ` ${U}`,
    `${U}?x=1`,
    `${U}#frag`,
    // Specific to this SDK: it leaves "." unencoded and then resolves the
    // URL, so a bare dot segment is a traversal on the client itself.
    '..',
    '.',
    `${U}\n`
]

let uploadDir: string
beforeAll(() => {
    uploadDir = mkdtempSync(join(tmpdir(), 'goodmem-ids-'))
    writeFileSync(join(uploadDir, 'note.txt'), 'inside the boundary')
})
afterAll(() => rmSync(uploadDir, { recursive: true, force: true }))

const ALL_ACTIONS = [...GOODMEM_ACTIONS]
const connect = (url: string, extra: Record<string, unknown> = {}) =>
    new GoodMemConnection({ baseUrl: url, apiKey: 'gm_test', defaultSpaceId: MOCK_IDS.space, uploadDir, ...extra })
const toolsFor = (url: string, extra: Record<string, unknown> = {}) =>
    createGoodMemTools({ baseUrl: url, apiKey: 'gm_test', defaultSpaceId: MOCK_IDS.space, actions: ALL_ACTIONS, ...extra })
const tool = (tools: any[], name: string): any => {
    const found = tools.find((t) => t.name === name)
    if (!found) throw new Error(`tool ${name} not built`)
    return found
}
const nodeInit = (url: string, inputs: Record<string, unknown>): Promise<any[]> =>
    new GoodMemNode().init({ credential: '', inputs: { goodMemBaseUrl: url, goodMemApiKey: 'gm_test', ...inputs } }, '', {})

interface Entry {
    /** The entry point as a model or developer sees it. */
    name: string
    /** What the refusal has to name. */
    field: string
    run: (url: string, id: string) => Promise<unknown>
    /** Payloads that mean something else at this entry point (see the node-form cases). */
    skip?: string[]
}

/** Every model-facing tool that takes an id, and the arguments a model would send. */
const MODEL_TOOLS: Array<{ name: string; field: string; args: (_id: string) => Record<string, unknown> }> = [
    { name: 'goodmem_get_memory', field: 'memory_id', args: (id) => ({ memory_id: id, include_content: true }) },
    { name: 'goodmem_list_memories', field: 'space_id', args: (id) => ({ space_id: id }) },
    { name: 'goodmem_get_space', field: 'space_id', args: (id) => ({ space_id: id }) },
    { name: 'goodmem_update_space', field: 'space_id', args: (id) => ({ space_id: id, name: 'renamed' }) },
    { name: 'goodmem_delete_space', field: 'space_id', args: (id) => ({ space_id: id }) },
    { name: 'goodmem_delete_memory', field: 'memory_id', args: (id) => ({ memory_id: id }) }
]

/** The tool body itself, as reached by any caller that skips schema validation. */
const MODEL_TOOL_BODIES: Entry[] = MODEL_TOOLS.map((t) => ({
    name: t.name,
    field: t.field,
    run: (url: string, id: string) => tool(toolsFor(url), t.name)._call(t.args(id))
}))

/** The same tools through the framework's `call`, which is what Flowise's agent runners use. */
const MODEL_TOOL_CALLS: Entry[] = MODEL_TOOLS.map((t) => ({
    name: `${t.name} via tool.call`,
    field: t.field,
    run: (url: string, id: string) => tool(toolsFor(url), t.name).call(t.args(id))
}))

/** `GoodMemConnection`, called directly by a developer. */
const DEVELOPER: Entry[] = [
    { name: 'GoodMemConnection.getMemory', field: 'memory_id', run: (url, id) => connect(url).getMemory(id, true) },
    { name: 'GoodMemConnection.listMemories', field: 'space_id', run: (url, id) => connect(url).listMemories(id) },
    { name: 'GoodMemConnection.updateSpace', field: 'space_id', run: (url, id) => connect(url).updateSpace(id, { name: 'renamed' }) },
    { name: 'GoodMemConnection.deleteSpace', field: 'space_id', run: (url, id) => connect(url).deleteSpace(id) },
    { name: 'GoodMemConnection.deleteMemory', field: 'memory_id', run: (url, id) => connect(url).deleteMemory(id) },
    { name: 'GoodMemConnection.requireSpaceId', field: 'space_id', run: async (url, id) => connect(url).requireSpaceId(id) },
    // The space id travels in a request body here, not a path; it is checked
    // anyway, because it is the same id and the same helper.
    { name: 'GoodMemConnection.search (space ids)', field: 'space_id', run: (url, id) => connect(url).search('q', 5, [id]) },
    { name: 'GoodMemConnection.remember (space id)', field: 'space_id', run: (url, id) => connect(url).remember('a fact', id) },
    { name: 'GoodMemConnection.uploadFile (space id)', field: 'space_id', run: (url, id) => connect(url).uploadFile('note.txt', id) },
    {
        name: 'GoodMemConnection.createSpace (embedder id)',
        field: 'embedder_id',
        run: (url, id) => connect(url).createSpace('brand-new', id)
    }
]

/** Ids that come from node configuration. */
const CONFIG: Entry[] = [
    {
        name: 'defaultSpaceId -> goodmem_list_memories()',
        field: 'Default Space',
        run: (url, id) => tool(toolsFor(url, { defaultSpaceId: id }), 'goodmem_list_memories')._call({})
    },
    {
        name: 'defaultSpaceId -> goodmem_remember(text)',
        field: 'Default Space',
        run: (url, id) => tool(toolsFor(url, { defaultSpaceId: id }), 'goodmem_remember')._call({ text: 'a fact' })
    },
    {
        name: 'defaultEmbedderId -> goodmem_create_space(name)',
        field: 'Default Embedder',
        run: (url, id) => tool(toolsFor(url, { defaultEmbedderId: id }), 'goodmem_create_space')._call({ name: 'brand-new' })
    },
    {
        name: 'rerankerId -> goodmem_search(query)',
        field: 'Reranker',
        run: (url, id) => tool(toolsFor(url, { rerankerId: id }), 'goodmem_search')._call({ query: 'q', top_k: 5 })
    },
    // Through the Flowise node itself. The node form uses an empty string for
    // "nothing selected", so '' there means "unset", not an id.
    {
        name: 'node init: Default Space -> goodmem_list_memories()',
        field: 'Default Space',
        skip: [''],
        run: async (url, id) => tool(await nodeInit(url, { defaultSpaceId: id }), 'goodmem_list_memories')._call({})
    },
    {
        name: 'node init: Default Embedder -> goodmem_create_space(name)',
        field: 'Default Embedder',
        skip: [''],
        run: async (url, id) =>
            tool(
                await nodeInit(url, { defaultSpaceId: MOCK_IDS.space, defaultEmbedderId: id, actions: JSON.stringify(['createSpace']) }),
                'goodmem_create_space'
            )._call({ name: 'brand-new' })
    },
    {
        name: 'node init: Reranker -> goodmem_search(query)',
        field: 'Reranker',
        skip: [''],
        run: async (url, id) =>
            tool(await nodeInit(url, { defaultSpaceId: MOCK_IDS.space, rerankerId: id }), 'goodmem_search')._call({ query: 'q', top_k: 5 })
    }
]

/** Run one entry point with one id and report what the server received and what the caller was told. */
async function probe(server: MockServer, entry: Entry, id: string): Promise<{ id: string; sent: string[]; told: string }> {
    server.requests.length = 0
    let told: string
    try {
        const out = await entry.run(server.baseUrl, id)
        told = typeof out === 'string' ? out.split(TOOL_ARGS_PREFIX)[0] : JSON.stringify(out) ?? 'undefined'
    } catch (error: any) {
        told = String(error?.message ?? error)
    }
    return { id, sent: server.requests.map((r) => `${r.method} ${r.path}`), told }
}

describe('a non-UUID id never reaches the server', () => {
    let server: MockServer
    let warn: jest.SpyInstance

    beforeEach(async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })
    afterEach(async () => {
        warn.mockRestore()
        await server.close()
    })

    it.each([...MODEL_TOOL_BODIES, ...MODEL_TOOL_CALLS, ...DEVELOPER, ...CONFIG].map((e) => [e.name, e]))(
        '%s',
        async (_name, entry: Entry) => {
            const results = []
            for (const id of HOSTILE.filter((h) => !(entry.skip ?? []).includes(h))) results.push(await probe(server, entry, id))

            // What reached the server, per payload. Empty is the only pass.
            expect(results.filter((r) => r.sent.length > 0).map((r) => ({ id: r.id, sent: r.sent, told: r.told }))).toEqual([])
            // Every refusal names the field and says it must be a UUID; none reports success.
            const refusedProperly = (told: string) =>
                told.includes(entry.field) && told.includes('must be a GoodMem UUID') && !/"deleted":true/.test(told)
            expect(results.filter((r) => !refusedProperly(r.told)).map((r) => ({ id: r.id, told: r.told }))).toEqual([])
        }
    )

    it('loadMethods list without an id, so a hostile configured id never reaches a path from them', async () => {
        const node = new GoodMemNode()
        const nodeData: any = {
            credential: '',
            inputs: {
                goodMemBaseUrl: server.baseUrl,
                goodMemApiKey: 'gm_test',
                defaultSpaceId: `../spaces/${U}`,
                defaultEmbedderId: `../embedders/${U}`,
                rerankerId: `../rerankers/${U}`
            }
        }
        for (const method of ['listSpaces', 'listEmbedders', 'listRerankers']) {
            const options = await node.loadMethods[method](nodeData, {})
            expect(options.length).toBeGreaterThan(0)
        }
        expect(server.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`)).toEqual([
            'GET /v1/spaces',
            'GET /v1/embedders',
            'GET /v1/rerankers'
        ])
    })
})

describe('a UUID reaches exactly the path it names', () => {
    let server: MockServer
    let warn: jest.SpyInstance

    beforeEach(async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })
    afterEach(async () => {
        warn.mockRestore()
        await server.close()
    })

    const sent = () => server.requests.map((r) => `${r.method} ${r.path}`)
    const payload = (raw: string) => JSON.parse(raw.split(TOOL_ARGS_PREFIX)[0])

    it('goodmem_delete_memory deletes that memory and nothing else', async () => {
        const out = await tool(toolsFor(server.baseUrl), 'goodmem_delete_memory').call({ memory_id: U })
        expect(sent()).toEqual([`DELETE /v1/memories/${U}`])
        expect(payload(out)).toEqual({ memoryId: U, deleted: true })
    })

    it('goodmem_delete_space deletes that space and nothing else', async () => {
        const out = await tool(toolsFor(server.baseUrl), 'goodmem_delete_space').call({ space_id: U })
        expect(sent()).toEqual([`DELETE /v1/spaces/${U}`])
        expect(payload(out)).toEqual({ spaceId: U, deleted: true })
    })

    it('goodmem_update_space renames that space', async () => {
        await tool(toolsFor(server.baseUrl), 'goodmem_update_space').call({ space_id: U, name: 'renamed' })
        expect(sent()).toEqual([`PUT /v1/spaces/${U}`])
    })

    it('goodmem_get_memory reads that memory and its content', async () => {
        await tool(toolsFor(server.baseUrl), 'goodmem_get_memory').call({ memory_id: U, include_content: true })
        expect(sent()).toEqual([`GET /v1/memories/${U}`, `GET /v1/memories/${U}/content`])
    })

    it('goodmem_list_memories lists that space, and the Default Space when none is given', async () => {
        const list = tool(toolsFor(server.baseUrl), 'goodmem_list_memories')
        await list.call({ space_id: U })
        await list.call({})
        expect(sent().map((s) => s.split('?')[0])).toEqual([`GET /v1/spaces/${U}/memories`, `GET /v1/spaces/${MOCK_IDS.space}/memories`])
    })

    it('goodmem_get_space finds the space in the listing without putting the id in a path', async () => {
        const out = await tool(toolsFor(server.baseUrl), 'goodmem_get_space').call({ space_id: MOCK_IDS.space })
        expect(payload(out).space.spaceId).toBe(MOCK_IDS.space)
        expect(sent().map((s) => s.split('?')[0])).toEqual(['GET /v1/spaces'])
    })

    it('an upper-case UUID is accepted and sent in canonical lower case', async () => {
        const out = await tool(toolsFor(server.baseUrl), 'goodmem_delete_memory').call({ memory_id: U.toUpperCase() })
        expect(sent()).toEqual([`DELETE /v1/memories/${U}`])
        expect(payload(out).memoryId).toBe(U)
    })

    it('tells the model in the tool schema that an id is a UUID', () => {
        const tools = toolsFor(server.baseUrl)
        for (const { name, field } of MODEL_TOOLS) {
            // What the model is shown ...
            const shown: any = toJsonSchema(tool(tools, name).schema)
            expect(shown.properties[field].pattern).toBe('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
            // ... and what the framework enforces before the tool body runs.
            const shape = tool(tools, name).schema.shape
            expect(shape[field].safeParse(U).success).toBe(true)
            const refused = shape[field].safeParse(`../spaces/${U}`)
            expect(refused.success).toBe(false)
            expect(refused.error.issues[0].message).toContain(`${field} must be a GoodMem UUID`)
        }
    })
})
