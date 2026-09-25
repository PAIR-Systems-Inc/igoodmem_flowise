/**
 * What the agent can reach: the tool surface, the upload boundary, and the
 * shape Flowise's agent runner expects back.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TOOL_ARGS_PREFIX } from '../../../../src/agents'
import { GoodMemConnection } from '../client'
import { createGoodMemTools, DEFAULT_ACTIONS, DESTRUCTIVE_ACTIONS, GOODMEM_ACTIONS } from '../core'
import { GoodMemUploadError, resolveUploadPath } from '../uploads'
import { MockServer, startMockGoodMem } from '../testing/mockGoodMem'

const base = { baseUrl: 'http://127.0.0.1:1', apiKey: 'gm_test', defaultSpaceId: 'space-existing' }
const names = (tools: any[]) => tools.map((t) => t.name)

describe('model-facing tool surface', () => {
    it('exposes no destructive tool until the builder asks for one', () => {
        const tools = createGoodMemTools({ ...base })

        expect(names(tools)).toEqual([
            'goodmem_search',
            'goodmem_remember',
            'goodmem_list_memories',
            'goodmem_get_memory',
            'goodmem_list_spaces',
            'goodmem_get_space',
            'goodmem_list_embedders'
        ])
        expect(names(tools)).not.toContain('goodmem_delete_space')
        expect(names(tools)).not.toContain('goodmem_delete_memory')
        expect(names(tools)).not.toContain('goodmem_update_space')
    })

    it('adds the destructive tools only when they are explicitly selected', () => {
        const tools = createGoodMemTools({ ...base, actions: [...DEFAULT_ACTIONS, ...DESTRUCTIVE_ACTIONS] })

        expect(names(tools)).toContain('goodmem_delete_space')
        expect(names(tools)).toContain('goodmem_delete_memory')
        expect(names(tools)).toContain('goodmem_update_space')
    })

    it('asks the model for a query and a size, and nothing that changes what a search means', () => {
        const search: any = createGoodMemTools({ ...base }).find((t) => t.name === 'goodmem_search')

        expect(Object.keys(search.schema.shape).sort()).toEqual(['query', 'top_k'])
        for (const forbidden of ['reranker_id', 'llm_id', 'relevance_threshold', 'filter_expression', 'wait_for_indexing', 'space_ids']) {
            expect(search.schema.shape[forbidden]).toBeUndefined()
        }
    })

    it('never offers public_read, which the server rejects outright', () => {
        const tools = createGoodMemTools({ ...base, actions: [...GOODMEM_ACTIONS] })
        for (const tool of tools as any[]) {
            expect(Object.keys(tool.schema.shape)).not.toContain('public_read')
        }
    })

    it('hides the upload tool entirely when no upload directory is configured', () => {
        const withoutDir = createGoodMemTools({ ...base, actions: [...GOODMEM_ACTIONS] })
        expect(names(withoutDir)).not.toContain('goodmem_upload_file')

        const withDir = createGoodMemTools({ ...base, actions: [...GOODMEM_ACTIONS], uploadDir: tmpdir() })
        expect(names(withDir)).toContain('goodmem_upload_file')
    })
})

describe('upload confinement', () => {
    let dir: string
    let outside: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'goodmem-uploads-'))
        outside = mkdtempSync(join(tmpdir(), 'goodmem-outside-'))
        writeFileSync(join(dir, 'report.txt'), 'inside the boundary')
        writeFileSync(join(outside, 'secret.txt'), 'outside the boundary')
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
    })

    it('accepts a file inside the directory', () => {
        expect(resolveUploadPath('report.txt', dir)).toBe(join(dir, 'report.txt'))
    })

    it('refuses an absolute path outside the directory', () => {
        expect(() => resolveUploadPath('/etc/hostname', dir)).toThrow(GoodMemUploadError)
    })

    it('refuses traversal out of the directory', () => {
        expect(() => resolveUploadPath(join('..', 'anything.txt'), dir)).toThrow(GoodMemUploadError)
    })

    it('refuses a symlink that points outside the directory', () => {
        symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'))
        expect(() => resolveUploadPath('link.txt', dir)).toThrow(/outside the upload directory/)
    })

    it('refuses a directory', () => {
        mkdirSync(join(dir, 'nested'))
        expect(() => resolveUploadPath('nested', dir)).toThrow(/not a regular file/)
    })

    it('refuses everything when no upload directory is set', () => {
        expect(() => resolveUploadPath('report.txt', undefined)).toThrow(/uploads are disabled/i)
    })
})

describe('Flowise tool result contract', () => {
    let server: MockServer

    afterEach(async () => {
        if (server) await server.close()
    })

    it('returns the payload and the arguments separated by the runner prefix', async () => {
        server = await startMockGoodMem({})
        const tool: any = createGoodMemTools({ ...base, baseUrl: server.baseUrl }).find((t) => t.name === 'goodmem_remember')

        const raw = await tool._call({ text: 'a fact worth keeping' })
        const [payload, args] = raw.split(TOOL_ARGS_PREFIX)
        expect(JSON.parse(payload).memoryId).toBe('mem-new')
        expect(JSON.parse(args)).toEqual({ text: 'a fact worth keeping' })
    })

    it("hands the agent the server's own reason when a call fails", async () => {
        server = await startMockGoodMem({ retrieveStatus: 403 })
        const tool: any = createGoodMemTools({ ...base, baseUrl: server.baseUrl }).find((t) => t.name === 'goodmem_search')

        const raw = await tool._call({ query: 'anything', top_k: 5 })
        expect(raw).toContain('retrieval refused by the server')
        expect(raw).toContain(TOOL_ARGS_PREFIX)
    })

    it('tells the agent a degraded empty search is not an empty store', async () => {
        const degraded = require('fs').readFileSync(join(__dirname, '..', 'testing', 'fixtures', 'retrieve_degraded_empty.ndjson'), 'utf-8')
        server = await startMockGoodMem({ retrieveBody: degraded })
        const tool: any = createGoodMemTools({ ...base, baseUrl: server.baseUrl }).find((t) => t.name === 'goodmem_search')

        const payload = JSON.parse((await tool._call({ query: 'anything', top_k: 5 })).split(TOOL_ARGS_PREFIX)[0])
        expect(payload.totalResults).toBe(0)
        expect(payload.partial).toBe(true)
        expect(payload.warning).toMatch(/NOT an empty memory store/)
        expect(payload.statuses.map((s: any) => s.code)).toContain('RERANKING_FAILED')
    })

    it('refuses to act without a space rather than guessing one', async () => {
        server = await startMockGoodMem({})
        const connection = new GoodMemConnection({ baseUrl: server.baseUrl, apiKey: 'k' })
        expect(() => connection.requireSpaceId()).toThrow(/No GoodMem space configured/)
    })
})
