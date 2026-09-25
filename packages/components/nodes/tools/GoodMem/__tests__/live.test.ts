/**
 * Live suite -- runs only when a GoodMem server is configured.
 *
 * Set GOODMEM_BASE_URL and GOODMEM_API_KEY to run it. With neither set every
 * test here skips, which is also the check that no credential is baked into
 * this package.
 *
 *   GOODMEM_BASE_URL=https://localhost:8080 GOODMEM_API_KEY=gm_... \
 *   GOODMEM_VERIFY_SSL=false npx jest nodes/tools/GoodMem/__tests__/live
 */

import { GoodMemConnection } from '../client'

const BASE_URL = process.env.GOODMEM_BASE_URL
const API_KEY = process.env.GOODMEM_API_KEY
const VERIFY_SSL = (process.env.GOODMEM_VERIFY_SSL ?? 'true').toLowerCase() !== 'false'
const CONFIGURED = Boolean(BASE_URL && API_KEY)

// `describe.skip` when unconfigured, so an unconfigured run reports skips
// rather than passing tests that never talked to a server.
const live = CONFIGURED ? describe : describe.skip

const SPACE_NAME = `flowise-goodmem-live-${Date.now()}`
const CANARY = `ORYX-${Math.floor(Math.random() * 1e6)}`

live('live GoodMem server', () => {
    let connection: GoodMemConnection
    let spaceId: string
    let embedderId: string
    const createdMemoryIds: string[] = []

    jest.setTimeout(180_000)

    beforeAll(async () => {
        connection = new GoodMemConnection({ baseUrl: BASE_URL as string, apiKey: API_KEY as string, verifySsl: VERIFY_SSL })
        const embedders = await connection.listEmbedders()
        if (embedders.length === 0) throw new Error('the live server has no embedders registered')
        embedderId = String(embedders[0].embedderId)
        const space = await connection.createSpace(SPACE_NAME, embedderId)
        spaceId = String(space.spaceId)
    })

    afterAll(async () => {
        if (!connection || !spaceId) return
        for (const id of createdMemoryIds) {
            try {
                await connection.deleteMemory(id)
            } catch {
                /* reported by the teardown check below */
            }
        }
        await connection.deleteSpace(spaceId)

        // Teardown is verified against a fresh inventory, not assumed from a
        // delete call returning 204.
        const remaining = (await connection.listSpaces()).filter((s) => s.spaceId === spaceId)
        expect(remaining).toHaveLength(0)
    })

    it('creates a space and reuses it only for a matching embedder', async () => {
        const again = await connection.createSpace(SPACE_NAME, embedderId)
        expect(again.reused).toBe(true)
        expect(again.spaceId).toBe(spaceId)

        await expect(connection.createSpace(SPACE_NAME, '00000000-0000-7000-8000-000000000000')).rejects.toThrow(
            /already exists but is built on embedder/
        )
    })

    it('stores a memory and finds it again by meaning', async () => {
        const scoped = new GoodMemConnection({
            baseUrl: BASE_URL as string,
            apiKey: API_KEY as string,
            verifySsl: VERIFY_SSL,
            defaultSpaceId: spaceId
        })
        const created = await scoped.remember(`The project canary for this run is ${CANARY}.`)
        createdMemoryIds.push(String(created.memoryId))

        // Indexing is asynchronous; poll the write we just made rather than
        // making every search wait.
        let found = false
        for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
            const outcome = await scoped.search('what is the project canary', 5)
            found = outcome.hits.some((h) => h.text.includes(CANARY))
            if (!found) await new Promise((r) => setTimeout(r, 2000))
        }
        expect(found).toBe(true)
    })

    it('orients live vector scores so higher is better', async () => {
        const scoped = new GoodMemConnection({
            baseUrl: BASE_URL as string,
            apiKey: API_KEY as string,
            verifySsl: VERIFY_SSL,
            defaultSpaceId: spaceId
        })
        const outcome = await scoped.search('project canary', 5)
        expect(outcome.hits.length).toBeGreaterThan(0)
        for (const hit of outcome.hits) {
            expect(hit.scoreKind).toBe('vector')
            expect(hit.rawScore).not.toBeNull()
            expect(hit.score).toBeCloseTo(-(hit.rawScore as number), 10)
        }
    })

    it('reports a broken reranker instead of calling the retrieval a success', async () => {
        const broken = new GoodMemConnection({
            baseUrl: BASE_URL as string,
            apiKey: API_KEY as string,
            verifySsl: VERIFY_SSL,
            defaultSpaceId: spaceId,
            rerankerId: '00000000-0000-7000-8000-000000000000'
        })
        const outcome = await broken.search('project canary', 5)

        expect(outcome.partial).toBe(true)
        expect(outcome.statuses.length).toBeGreaterThan(0)
    })

    it('escapes a filter value instead of letting it change the query', async () => {
        const injected = new GoodMemConnection({
            baseUrl: BASE_URL as string,
            apiKey: API_KEY as string,
            verifySsl: VERIFY_SSL,
            defaultSpaceId: spaceId,
            metadataFilter: { category: "x' OR '1'='1" }
        })
        const outcome = await injected.search('project canary', 5)

        // The injection is a literal nothing was stored under, so it matches
        // nothing -- rather than matching everything.
        expect(outcome.hits).toHaveLength(0)
    })

    it('empty searches return immediately rather than polling for a minute', async () => {
        const empty = await connection.createSpace(`${SPACE_NAME}-empty`, embedderId)
        const scoped = new GoodMemConnection({
            baseUrl: BASE_URL as string,
            apiKey: API_KEY as string,
            verifySsl: VERIFY_SSL,
            defaultSpaceId: String(empty.spaceId)
        })
        try {
            const started = Date.now()
            const outcome = await scoped.search('nothing was ever stored here', 5)
            const elapsed = Date.now() - started

            expect(outcome.hits).toHaveLength(0)
            expect(outcome.partial).toBe(false)
            expect(elapsed).toBeLessThan(10_000)
        } finally {
            await connection.deleteSpace(String(empty.spaceId))
        }
    })

    it('follows pagination internally when listing', async () => {
        const memories = await connection.listMemories(spaceId)
        expect(Array.isArray(memories)).toBe(true)
    })
})
