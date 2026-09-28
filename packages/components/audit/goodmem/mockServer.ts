/**
 * Mock GoodMem server for baseline fault injection (audit only, not shipped).
 * Serves NDJSON captured from the live server (server-v1.0.320) plus fault cases.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const FIX = path.join(__dirname, '..', '..', 'nodes', 'tools', 'GoodMem', 'testing', 'fixtures')
export const fixture = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf-8')
export const UNKNOWN_STATUS = fixture('retrieve_unknown_status.ndjson')

export interface MockOpts {
    retrieveBody?: string // NDJSON returned by /v1/memories:retrieve
    spaceEmbedderId?: string // embedderId the *existing* space really has
    pdfBytes?: Buffer // body for /v1/memories/:id/content
    rejectPublicRead?: boolean // mimic live server 400
}

export interface MockHandle {
    url: string
    close: () => Promise<void>
    requests: { method: string; path: string; body: string }[]
    retrieveCalls: number
}

export async function startMock(opts: MockOpts = {}): Promise<MockHandle> {
    const requests: { method: string; path: string; body: string }[] = []
    let retrieveCalls = 0
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            const url = req.url || ''
            requests.push({ method: req.method || '', path: url, body })
            const json = (o: any, code = 200) => {
                res.writeHead(code, { 'content-type': 'application/json' })
                res.end(JSON.stringify(o))
            }

            if (url === '/v1/embedders') {
                return json({ embedders: [{ embedderId: 'emb-REAL', displayName: 'MiniLM', providerType: 'OPENAI' }] })
            }
            if (url === '/v1/spaces' && req.method === 'GET') {
                // one existing space, built on a DIFFERENT embedder than callers ask for
                return json({
                    spaces: [
                        {
                            spaceId: 'space-EXISTING',
                            name: 'demo-space',
                            spaceEmbedders: [{ embedderId: opts.spaceEmbedderId ?? 'emb-REAL' }]
                        }
                    ]
                })
            }
            if (url === '/v1/spaces' && req.method === 'POST') {
                return json({ spaceId: 'space-NEW', name: JSON.parse(body || '{}').name })
            }
            if (url.startsWith('/v1/spaces/') && url.endsWith('/memories')) {
                return json({ memories: [{ memoryId: 'mem-1' }], nextToken: 'PAGE2' })
            }
            if (url.startsWith('/v1/spaces/') && req.method === 'PUT') {
                if (opts.rejectPublicRead !== false && body.includes('publicRead')) {
                    res.writeHead(400, { 'content-type': 'application/json' })
                    return res.end(JSON.stringify({ code: 3, message: 'publicRead is not a recognized field' }))
                }
                return json({ spaceId: 'space-EXISTING' })
            }
            if (url.startsWith('/v1/spaces/') && req.method === 'GET') return json({ spaceId: 'space-EXISTING' })
            if (url.startsWith('/v1/spaces/') && req.method === 'DELETE') {
                res.writeHead(204)
                return res.end()
            }

            if (url === '/v1/memories' && req.method === 'POST') {
                return json({ memoryId: 'mem-NEW', spaceId: 'space-EXISTING', processingStatus: 'PENDING' })
            }
            if (url.endsWith('/content')) {
                const pdf = opts.pdfBytes ?? Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\nbinary', 'binary')
                res.writeHead(200, { 'content-type': 'application/pdf' })
                return res.end(pdf)
            }
            if (url.startsWith('/v1/memories/') && req.method === 'GET') return json({ memoryId: 'mem-1' })
            if (url.startsWith('/v1/memories/') && req.method === 'DELETE') {
                res.writeHead(204)
                return res.end()
            }

            if (url === '/v1/memories:retrieve') {
                retrieveCalls++
                handle.retrieveCalls = retrieveCalls
                res.writeHead(200, { 'content-type': 'application/x-ndjson' })
                return res.end(opts.retrieveBody ?? fixture('retrieve_ok.ndjson'))
            }
            json({ error: 'unhandled ' + url }, 404)
        })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const handle: MockHandle = {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
        retrieveCalls: 0
    }
    return handle
}
