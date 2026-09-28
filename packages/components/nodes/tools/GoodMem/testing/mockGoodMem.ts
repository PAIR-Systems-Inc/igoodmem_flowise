/**
 * A mock GoodMem server for the offline suite.
 *
 * The tests drive the real `@pairsystems/goodmem` SDK against this server, so
 * what is faked is the network, not the integration. The NDJSON it serves was
 * captured from a live GoodMem server (server-v1.0.320); the fault cases are
 * that capture with events added or removed, never hand-written shapes.
 */

import * as http from 'http'

/**
 * The ids this server hands out. GoodMem ids are UUIDs and the node refuses
 * anything else before a request is made, so the fakes are UUIDs too.
 */
export const MOCK_IDS = {
    space: '0199b8a0-5ace-7000-8000-000000000001',
    spacePage2: '0199b8a0-5ace-7000-8000-000000000002',
    spaceCreated: '0199b8a0-5ace-7000-8000-000000000003',
    memory: '0199b8a0-3e30-7000-8000-000000000001',
    memoryPage2: '0199b8a0-3e30-7000-8000-000000000002',
    memoryCreated: '0199b8a0-3e30-7000-8000-000000000003',
    embedder: '0199b8a0-e3bd-7000-8000-000000000001',
    otherEmbedder: '0199b8a0-e3bd-7000-8000-000000000002',
    reranker: '0199b8a0-4e4a-7000-8000-000000000001'
} as const

export interface MockOptions {
    /** NDJSON body returned by POST /v1/memories:retrieve. */
    retrieveBody?: string
    /** Truncate the NDJSON body mid-line to simulate a broken stream. */
    truncateRetrieve?: boolean
    /** Return an empty body (no events at all). */
    emptyRetrieve?: boolean
    /** Embedder id the pre-existing space "demo-space" was built on. Defaults to `MOCK_IDS.embedder`. */
    spaceEmbedderId?: string
    /** Bytes served by GET /v1/memories/:id/content. */
    contentBytes?: Buffer
    /** Content type reported for the stored memory and its content. */
    contentType?: string
    /** Serve space and memory listings in two pages. */
    paginate?: boolean
    /** Fail POST /v1/memories:retrieve with this status. */
    retrieveStatus?: number
}

export interface MockServer {
    baseUrl: string
    close(): Promise<void>
    /** Every request received, in order. */
    requests: Array<{ method: string; path: string; body: string }>
    retrieveCalls: number
}

const json = (res: http.ServerResponse, body: unknown, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}

export async function startMockGoodMem(options: MockOptions = {}): Promise<MockServer> {
    const state: MockServer = {
        baseUrl: '',
        close: async () => undefined,
        requests: [],
        retrieveCalls: 0
    }

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c as Buffer))
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            const raw = req.url ?? ''
            const url = new URL(raw, 'http://mock')
            const path = url.pathname
            const token = url.searchParams.get('nextToken')
            state.requests.push({ method: req.method ?? '', path: raw, body })

            if (path === '/v1/embedders') {
                return json(res, { embedders: [{ embedderId: MOCK_IDS.embedder, displayName: 'MiniLM', providerType: 'OPENAI' }] })
            }
            if (path === '/v1/rerankers') {
                return json(res, { rerankers: [{ rerankerId: MOCK_IDS.reranker, displayName: 'Voyage' }] })
            }

            if (path === '/v1/spaces' && req.method === 'GET') {
                const first = {
                    spaces: [
                        {
                            spaceId: MOCK_IDS.space,
                            name: 'demo-space',
                            spaceEmbedders: [{ embedderId: options.spaceEmbedderId ?? MOCK_IDS.embedder }]
                        }
                    ],
                    ...(options.paginate && !token ? { nextToken: 'SPACES-PAGE-2' } : {})
                }
                const second = { spaces: [{ spaceId: MOCK_IDS.spacePage2, name: 'second-page-space', spaceEmbedders: [] }] }
                return json(res, token ? second : first)
            }
            if (path === '/v1/spaces' && req.method === 'POST') {
                const parsed = JSON.parse(body || '{}')
                return json(res, { spaceId: MOCK_IDS.spaceCreated, name: parsed.name, spaceEmbedders: parsed.spaceEmbedders })
            }
            if (path.startsWith('/v1/spaces/') && path.endsWith('/memories')) {
                const first = {
                    memories: [{ memoryId: MOCK_IDS.memory, spaceId: MOCK_IDS.space, contentType: 'text/plain' }],
                    ...(options.paginate && !token ? { nextToken: 'MEMS-PAGE-2' } : {})
                }
                const second = { memories: [{ memoryId: MOCK_IDS.memoryPage2, spaceId: MOCK_IDS.space, contentType: 'text/plain' }] }
                return json(res, token ? second : first)
            }
            if (path.startsWith('/v1/spaces/') && req.method === 'PUT') {
                if (body.includes('publicRead')) {
                    // The live server answers 400 for this field; the mock
                    // mirrors it so a regression is a test failure, not a
                    // silent success.
                    return json(res, { code: 3, message: 'publicRead is not a recognized field' }, 400)
                }
                return json(res, { spaceId: MOCK_IDS.space, name: JSON.parse(body || '{}').name })
            }
            if (path.startsWith('/v1/spaces/') && req.method === 'DELETE') {
                res.writeHead(204)
                return res.end()
            }

            if (path === '/v1/memories' && req.method === 'POST') {
                return json(res, { memoryId: MOCK_IDS.memoryCreated, spaceId: MOCK_IDS.space, processingStatus: 'PENDING' })
            }
            if (path.endsWith('/content')) {
                const bytes = options.contentBytes ?? Buffer.from('plain text body', 'utf-8')
                res.writeHead(200, { 'content-type': options.contentType ?? 'text/plain' })
                return res.end(bytes)
            }
            if (path.startsWith('/v1/memories/') && req.method === 'GET') {
                return json(res, { memoryId: MOCK_IDS.memory, spaceId: MOCK_IDS.space, contentType: options.contentType ?? 'text/plain' })
            }
            if (path.startsWith('/v1/memories/') && req.method === 'DELETE') {
                res.writeHead(204)
                return res.end()
            }

            if (path === '/v1/memories:retrieve') {
                state.retrieveCalls += 1
                if (options.retrieveStatus) {
                    return json(res, { code: 7, message: 'retrieval refused by the server' }, options.retrieveStatus)
                }
                res.writeHead(200, { 'content-type': 'application/x-ndjson' })
                if (options.emptyRetrieve) return res.end('')
                const payload = options.retrieveBody ?? ''
                if (options.truncateRetrieve) {
                    // Cut inside the final JSON object so the last line cannot
                    // parse. The SDK raises a ParseError partway through the
                    // stream, after earlier events have already been yielded.
                    return res.end(payload.slice(0, Math.max(1, payload.length - 25)))
                }
                return res.end(payload)
            }

            json(res, { message: `unhandled ${req.method} ${path}` }, 404)
        })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    state.baseUrl = `http://127.0.0.1:${port}`
    state.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
    return state
}
