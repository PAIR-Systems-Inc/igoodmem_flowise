/**
 * Retrieval behaviour: the status contract, score orientation, chunk joining
 * and stream damage.
 *
 * Every test drives the real GoodMem SDK over a mock transport replaying
 * NDJSON captured from server-v1.0.320.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { GoodMemConnection } from '../client'
import { MALFORMED_STREAM_CODE, UNKNOWN_CODE, classifyStatus, orientScore, rerankerFailed } from '../results'
import { MOCK_IDS, MockServer, startMockGoodMem } from '../testing/mockGoodMem'

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'testing', 'fixtures', name), 'utf-8')

const OK = fixture('retrieve_ok.ndjson')
const DEGRADED_HITS = fixture('retrieve_degraded_hits.ndjson')
const DEGRADED_EMPTY = fixture('retrieve_degraded_empty.ndjson')
const UNKNOWN_STATUS = fixture('retrieve_unknown_status.ndjson')

let server: MockServer

const connect = (extra: Record<string, unknown> = {}) =>
    new GoodMemConnection({ baseUrl: server.baseUrl, apiKey: 'gm_test', defaultSpaceId: MOCK_IDS.space, ...extra })

afterEach(async () => {
    if (server) await server.close()
})

describe('retrieval status contract', () => {
    it('Q4a: reports the problem and still returns the hits', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_HITS })
        const outcome = await connect().search('anything', 5)

        expect(outcome.hits).toHaveLength(1)
        expect(outcome.partial).toBe(true)
        const codes = outcome.statuses.map((s) => s.code)
        expect(codes).toContain('RERANKING_FAILED')
        expect(codes).toContain('NOT_FOUND')
    })

    it('Q1: FEATURE_DISABLED is noise by code alone and never marks a retrieval degraded', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_HITS })
        const outcome = await connect().search('anything', 5)

        expect(outcome.statuses.map((s) => s.code)).not.toContain('FEATURE_DISABLED')
        const informational = classifyStatus('FEATURE_DISABLED', 'no LLM configured')
        expect(informational.informational).toBe(true)
        expect(classifyStatus('LLM_CAPABILITY_INFERRED', '').informational).toBe(true)
    })

    it('Q4b: a failed retrieval with no hits is a failure, not an empty index', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_EMPTY })
        const outcome = await connect().search('anything', 5)

        expect(outcome.hits).toHaveLength(0)
        expect(outcome.partial).toBe(true)
        expect(outcome.statuses.map((s) => s.code)).toContain('RERANKING_FAILED')
    })

    it('Q3: an unrecognised status code is surfaced as UNKNOWN, never dropped', async () => {
        server = await startMockGoodMem({ retrieveBody: UNKNOWN_STATUS })
        const outcome = await connect().search('anything', 5)

        expect(outcome.partial).toBe(true)
        const unknown = outcome.statuses.find((s) => s.code === UNKNOWN_CODE)
        expect(unknown).toBeDefined()
        // The server's own words survive, so an operator can still see what
        // happened. Its machine-readable code does not: the SDK coerces an
        // enum value it does not know to null before this code sees it
        // (verified against @pairsystems/goodmem 0.1.7). Recovering it would
        // mean parsing the stream ourselves, which is the defect this rewrite
        // removed, so the loss is accepted and recorded instead.
        expect(unknown?.message).toBe('Future server notice')
        // Q3's real requirement is that behaviour does not change: the
        // retrieval is flagged, and both chunks around the status survive.
        expect(outcome.hits).toHaveLength(2)
    })

    it('a healthy retrieval is not marked partial', async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        const outcome = await connect().search('anything', 5)

        expect(outcome.partial).toBe(false)
        expect(outcome.statuses).toHaveLength(0)
        expect(outcome.hits).toHaveLength(1)
    })
})

describe('no empty-search polling', () => {
    it('returns an empty result immediately instead of waiting for indexing', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_EMPTY })
        const started = Date.now()
        const outcome = await connect().search('anything', 5)
        const elapsed = Date.now() - started

        expect(outcome.hits).toHaveLength(0)
        // The baseline polled for 60s across 13 requests before answering.
        expect(server.retrieveCalls).toBe(1)
        expect(elapsed).toBeLessThan(5_000)
    })
})

describe('score semantics', () => {
    it('orients a vector distance so higher is better and keeps the raw value', async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        const outcome = await connect().search('anything', 5)
        const hit = outcome.hits[0]

        expect(hit.rawScore).toBeCloseTo(-0.5845972299575806, 10)
        expect(hit.score).toBeCloseTo(0.5845972299575806, 10)
        expect(hit.scoreKind).toBe('vector')
    })

    it('never negates a reranker score, which would invert the ranking', async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        const outcome = await connect({ rerankerId: MOCK_IDS.reranker }).search('anything', 5)
        const hit = outcome.hits[0]

        expect(hit.scoreKind).toBe('reranker')
        expect(hit.score).toBe(hit.rawScore)
        expect(orientScore(0.42, true)).toBe(0.42)
        expect(orientScore(-0.42, false)).toBe(0.42)
    })

    it('warns rather than silently emptying the result when a threshold removes everything', async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            const outcome = await connect({ minScore: 99 }).search('anything', 5)
            expect(outcome.hits).toHaveLength(0)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed all 1 result'))
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('a 0-1 range'))
        } finally {
            warn.mockRestore()
        }
    })
})

describe('reranker fallback (Q4a)', () => {
    it('labels and orients fallback hits as vector when the requested reranker failed', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_HITS })
        const outcome = await connect({ rerankerId: 'e2b7a63e-8f2a-4e3b-9c7a-2d1e0f9a8b7c' }).search('anything', 5)

        // The server sent NOT_FOUND (naming the reranker) + RERANKING_FAILED
        // and still returned its vector fallback hit (rawScore -0.5845...).
        expect(outcome.reranked).toBe(false)
        expect(outcome.partial).toBe(true)
        const hit = outcome.hits[0]
        expect(hit.scoreKind).toBe('vector')
        expect(hit.score).toBeCloseTo(0.5845972299575806, 10)
        expect(hit.rawScore).toBeCloseTo(-0.5845972299575806, 10)
    })

    it('does not apply a reranker-tuned Minimum Score to fallback hits', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_HITS })
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            const outcome = await connect({
                rerankerId: 'e2b7a63e-8f2a-4e3b-9c7a-2d1e0f9a8b7c',
                minScore: 0.9
            }).search('anything', 5)
            // Q4a: the hits the server returned are never discarded.
            expect(outcome.hits).toHaveLength(1)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('not applied'))
        } finally {
            warn.mockRestore()
        }
    })

    it('still applies Minimum Score when the reranker ran', async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            const outcome = await connect({
                rerankerId: 'e2b7a63e-8f2a-4e3b-9c7a-2d1e0f9a8b7c',
                minScore: 0.9
            }).search('anything', 5)
            // OK fixture: no failure statuses, so the hit keeps its reranker
            // label and the raw -0.58 score fails a 0.9 threshold.
            expect(outcome.reranked).toBe(true)
            expect(outcome.hits).toHaveLength(0)
        } finally {
            warn.mockRestore()
        }
    })

    it('recognises the two shapes the server reports a failed reranker with', () => {
        expect(rerankerFailed([{ code: 'RERANKING_FAILED', message: '' }])).toBe(true)
        expect(rerankerFailed([{ code: 'NOT_FOUND', message: 'Reranker validation failed' }])).toBe(true)
        expect(rerankerFailed([{ code: 'NOT_FOUND', message: 'x', details: { reranker_id: 'r' } }])).toBe(true)
        expect(rerankerFailed([{ code: 'NOT_FOUND', message: 'Space missing' }])).toBe(false)
        expect(rerankerFailed([{ code: 'EMBEDDER_FAILED', message: '' }])).toBe(false)
    })
})

describe('stream integrity', () => {
    it('joins a chunk to its memory by id, not by arrival position', async () => {
        server = await startMockGoodMem({ retrieveBody: OK })
        const outcome = await connect().search('anything', 5)
        const hit = outcome.hits[0]

        const memoryEvent = JSON.parse(OK.split('\n').filter(Boolean)[1]).memoryDefinition
        expect(hit.memoryId).toBe(memoryEvent.memoryId)
        expect(hit.spaceId).toBe(memoryEvent.spaceId)
    })

    it('de-duplicates by chunk id so repeated chunks collapse but distinct ones do not', async () => {
        const lines = OK.split('\n').filter(Boolean)
        const chunkLine = lines.find((l) => l.includes('retrievedItem'))!
        const doubled = [...lines, chunkLine].join('\n')
        server = await startMockGoodMem({ retrieveBody: doubled })

        const outcome = await connect().search('anything', 5)
        expect(outcome.hits).toHaveLength(1)
    })

    it('keeps what arrived and reports MALFORMED_STREAM when the stream ends mid-line', async () => {
        server = await startMockGoodMem({ retrieveBody: DEGRADED_HITS, truncateRetrieve: true })
        const outcome = await connect().search('anything', 5)

        expect(outcome.partial).toBe(true)
        expect(outcome.statuses.map((s) => s.code)).toContain(MALFORMED_STREAM_CODE)
    })

    it('raises when the server refuses the retrieval instead of reporting an empty result', async () => {
        server = await startMockGoodMem({ retrieveStatus: 403 })
        await expect(connect().search('anything', 5)).rejects.toThrow(/retrieval failed/i)
    })
})
