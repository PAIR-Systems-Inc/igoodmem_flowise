/**
 * Spaces, listings and stored content.
 */

import { GoodMemConnection } from '../client'
import { MockServer, startMockGoodMem } from '../testing/mockGoodMem'

let server: MockServer

const connect = (extra: Record<string, unknown> = {}) =>
    new GoodMemConnection({ baseUrl: server.baseUrl, apiKey: 'gm_test', defaultSpaceId: 'space-existing', ...extra })

afterEach(async () => {
    if (server) await server.close()
})

describe('space reuse', () => {
    it('reuses a space of the same name when its embedder matches', async () => {
        server = await startMockGoodMem({ spaceEmbedderId: 'emb-real' })
        const result = await connect({ defaultEmbedderId: 'emb-real' }).createSpace('demo-space')

        expect(result.reused).toBe(true)
        expect(result.spaceId).toBe('space-existing')
        expect(result.embedderId).toBe('emb-real')
    })

    it('refuses to reuse a space built on a different embedder', async () => {
        server = await startMockGoodMem({ spaceEmbedderId: 'emb-other' })

        await expect(connect({ defaultEmbedderId: 'emb-real' }).createSpace('demo-space')).rejects.toThrow(
            /already exists but is built on embedder\(s\) emb-other/
        )
    })

    it('creates a new space when no name matches', async () => {
        server = await startMockGoodMem({})
        const result = await connect({ defaultEmbedderId: 'emb-real' }).createSpace('brand-new')

        expect(result.reused).toBe(false)
        expect(result.spaceId).toBe('space-created')
        const created = server.requests.find((r) => r.method === 'POST' && r.path === '/v1/spaces')!
        expect(JSON.parse(created.body).spaceEmbedders).toEqual([{ embedderId: 'emb-real' }])
    })

    it('refuses to create a space with no embedder rather than picking one', async () => {
        server = await startMockGoodMem({})
        await expect(connect().createSpace('brand-new')).rejects.toThrow(/No embedder configured/)
    })
})

describe('space updates', () => {
    it('never sends publicRead, which the server rejects with 400', async () => {
        server = await startMockGoodMem({})
        await connect().updateSpace('space-existing', { name: 'renamed' })

        const put = server.requests.find((r) => r.method === 'PUT')!
        expect(put.body).not.toContain('publicRead')
        expect(JSON.parse(put.body)).toEqual({ name: 'renamed' })
    })

    it('refuses an update that would change nothing', async () => {
        server = await startMockGoodMem({})
        await expect(connect().updateSpace('space-existing', {})).rejects.toThrow(/Nothing to update/)
    })
})

describe('pagination', () => {
    it('follows spaces pagination internally instead of returning a token', async () => {
        server = await startMockGoodMem({ paginate: true })
        const spaces = await connect().listSpaces()

        expect(spaces.map((s) => s.spaceId)).toEqual(['space-existing', 'space-page2'])
        expect(server.requests.filter((r) => r.path.startsWith('/v1/spaces')).length).toBeGreaterThan(1)
    })

    it('follows memory pagination internally', async () => {
        server = await startMockGoodMem({ paginate: true })
        const memories = await connect().listMemories('space-existing')

        expect(memories.map((m) => m.memoryId)).toEqual(['mem-1', 'mem-2'])
    })

    it('stops at maxListItems rather than draining an unbounded space', async () => {
        server = await startMockGoodMem({ paginate: true })
        const memories = await connect({ maxListItems: 1 }).listMemories('space-existing')

        expect(memories).toHaveLength(1)
    })
})

describe('stored content', () => {
    it('returns a binary document intact, base64-encoded', async () => {
        const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0xfe, 0x00, 0x01])
        server = await startMockGoodMem({ contentBytes: pdf, contentType: 'application/pdf' })

        const result = await connect().getMemory('mem-1', true)
        expect(result.contentEncoding).toBe('base64')
        expect(Buffer.from(result.contentBase64, 'base64').equals(pdf)).toBe(true)
        expect(result.contentBytes).toBe(pdf.length)
        expect(result.content).toBeUndefined()
    })

    it('returns a text document as text', async () => {
        server = await startMockGoodMem({ contentBytes: Buffer.from('hello, memory', 'utf-8'), contentType: 'text/plain' })

        const result = await connect().getMemory('mem-1', true)
        expect(result.content).toBe('hello, memory')
        expect(result.contentEncoding).toBe('utf-8')
    })

    it('does not fetch content unless asked', async () => {
        server = await startMockGoodMem({})
        await connect().getMemory('mem-1', false)

        expect(server.requests.some((r) => r.path.endsWith('/content'))).toBe(false)
    })
})
