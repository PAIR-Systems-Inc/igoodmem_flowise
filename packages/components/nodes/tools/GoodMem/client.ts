/**
 * GoodMem connection for the Flowise node.
 *
 * This is a thin layer over the official `@pairsystems/goodmem` SDK, not a
 * second HTTP client: the SDK owns transport, retries, pagination, streaming
 * and typed errors, and this file owns the decisions that are specific to
 * driving GoodMem from a Flowise chatflow.
 *
 * Three rules are enforced here rather than left to each tool:
 *  - a retrieval is folded through `results.ts`, so server status events are
 *    never dropped and a failure is never reported as an empty index;
 *  - listings are drained through the SDK's auto-paginating `Page`, capped by
 *    `maxListItems`, so a caller never sees a half-answer plus a token;
 *  - a space is reused only when its embedder matches the one requested.
 */

import { Goodmem } from '@pairsystems/goodmem'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { fromMapping } from './filters'
import { outcomeFromEvents, RetrievalOutcome, warningText } from './results'
import { resolveUploadPath } from './uploads'

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_LIST_ITEMS = 200

/** Raised for GoodMem problems this node detects itself. */
export class GoodMemError extends Error {
    status?: number
    constructor(message: string, status?: number) {
        super(message)
        this.name = 'GoodMemError'
        this.status = status
    }
}

export interface GoodMemConnectionOptions {
    baseUrl: string
    apiKey: string
    /** Verify the server's TLS certificate. Defaults to true. */
    verifySsl?: boolean
    timeoutMs?: number
    /** Space the tools operate on when the chatflow does not name one. */
    defaultSpaceId?: string
    /** Embedder used when a space has to be created. */
    defaultEmbedderId?: string
    /** Directory model-supplied upload paths are confined to. */
    uploadDir?: string
    /** Reranker applied to every search, chosen by the developer. */
    rerankerId?: string
    /** Developer-set metadata filter applied server-side to every search. */
    metadataFilter?: Record<string, unknown>
    /** Drop hits below this score. Only meaningful with a reranker. */
    minScore?: number
    maxListItems?: number
}

/**
 * Build the fetch the SDK will use.
 *
 * TLS verification stays on unless the credential explicitly turns it off,
 * and turning it off applies only to this connection -- it never mutates
 * `NODE_TLS_REJECT_UNAUTHORIZED`, which would silently disable verification
 * for every other node in the Flowise process.
 */
function buildFetch(verifySsl: boolean, baseUrl: string): typeof fetch | undefined {
    if (verifySsl) return undefined
    let Agent: any
    try {
        // Loaded only on the opt-out path so the default path needs nothing.
        Agent = require('undici').Agent
    } catch {
        throw new GoodMemError(
            'Verify SSL was turned off, but the undici agent needed to do that is not available in this Flowise install. ' +
                'Re-enable Verify SSL, or install a certificate the server trusts.'
        )
    }
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
    let warned = false
    return ((input: any, init?: any) => {
        if (!warned) {
            warned = true
            // eslint-disable-next-line no-console
            console.warn(
                `[GoodMem] TLS certificate verification is DISABLED for ${baseUrl}. ` +
                    'This is intended for a self-signed local server only; traffic to this host can be intercepted.'
            )
        }
        return (globalThis as any).fetch(input, { ...(init ?? {}), dispatcher })
    }) as unknown as typeof fetch
}

/** Turn an SDK error into a message worth showing the caller. */
export function describeError(error: any, what: string): GoodMemError {
    const status = error?.status ?? error?.statusCode
    const detail = error?.body?.message ?? error?.message ?? String(error)
    return new GoodMemError(`${what} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`, status)
}

export class GoodMemConnection {
    readonly client: Goodmem
    readonly defaultSpaceId?: string
    readonly defaultEmbedderId?: string
    readonly uploadDir?: string
    readonly rerankerId?: string
    readonly metadataFilter: Record<string, unknown>
    readonly minScore?: number
    readonly maxListItems: number

    constructor(options: GoodMemConnectionOptions) {
        if (!options.baseUrl) throw new GoodMemError('GoodMem base URL is required.')
        if (!options.apiKey) throw new GoodMemError('GoodMem API key is required.')
        const verifySsl = options.verifySsl !== false
        this.client = new Goodmem({
            baseUrl: options.baseUrl.replace(/\/+$/, ''),
            apiKey: options.apiKey,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            fetch: buildFetch(verifySsl, options.baseUrl)
        } as any)
        this.defaultSpaceId = options.defaultSpaceId
        this.defaultEmbedderId = options.defaultEmbedderId
        this.uploadDir = options.uploadDir
        this.rerankerId = options.rerankerId
        this.metadataFilter = options.metadataFilter ?? {}
        this.minScore = options.minScore
        this.maxListItems = options.maxListItems ?? DEFAULT_MAX_LIST_ITEMS
    }

    /** The space a tool call operates on. */
    requireSpaceId(provided?: string): string {
        const id = provided ?? this.defaultSpaceId
        if (!id) {
            throw new GoodMemError('No GoodMem space configured. Set a Default Space on the GoodMem node.')
        }
        return id
    }

    private spaceKeys(spaceIds: string[]): Array<Record<string, unknown>> {
        const expression = fromMapping(this.metadataFilter)
        return spaceIds.map((spaceId) => (expression ? { spaceId, filter: expression } : { spaceId }))
    }

    /**
     * Semantic search.
     *
     * Returns whatever the server produced together with the statuses it
     * reported. There is no polling: an empty result is reported immediately
     * as an empty result, and a *failed* retrieval is reported as a failure
     * rather than waited out.
     */
    async search(query: string, topK: number, spaceIds?: string[]): Promise<RetrievalOutcome> {
        const ids = spaceIds && spaceIds.length > 0 ? spaceIds : [this.requireSpaceId()]
        const request: Record<string, unknown> = {
            message: query,
            spaceKeys: this.spaceKeys(ids),
            requestedSize: topK,
            fetchMemory: true
        }
        if (this.rerankerId) {
            request.postProcessor = {
                name: 'com.goodmem.retrieval.postprocess.ChatPostProcessorFactory',
                config: { reranker_id: this.rerankerId, max_results: topK }
            }
        }
        let outcome: RetrievalOutcome
        try {
            outcome = await outcomeFromEvents(this.client.memories.retrieve(request as any), Boolean(this.rerankerId))
        } catch (error: any) {
            throw describeError(error, 'GoodMem retrieval')
        }

        if (this.minScore !== undefined) {
            const kept = outcome.hits.filter((h) => h.score !== null && h.score >= (this.minScore as number))
            if (outcome.hits.length > 0 && kept.length === 0) {
                const scores = outcome.hits.map((h) => h.score).filter((s): s is number => s !== null)
                // eslint-disable-next-line no-console
                console.warn(
                    `[GoodMem] Minimum Score ${this.minScore} removed all ${outcome.hits.length} result(s); observed scores ranged ` +
                        `${Math.min(...scores).toFixed(4)}..${Math.max(...scores).toFixed(4)}. Vector scores are oriented distances ` +
                        'and reranker scales are provider-dependent -- neither is a 0-1 range.'
                )
            }
            outcome.hits = kept
        }
        if (outcome.partial) {
            // eslint-disable-next-line no-console
            console.warn(`[GoodMem] ${warningText(outcome.statuses)}`)
        }
        return outcome
    }

    /** Store a piece of text as a memory. */
    async remember(text: string, spaceId?: string, metadata?: Record<string, unknown>): Promise<Record<string, any>> {
        try {
            const created: any = await this.client.memories.create({
                spaceId: this.requireSpaceId(spaceId),
                originalContent: text,
                contentType: 'text/plain',
                ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
            } as any)
            return { memoryId: created?.memoryId, spaceId: created?.spaceId, processingStatus: created?.processingStatus ?? 'PENDING' }
        } catch (error: any) {
            throw describeError(error, 'Creating a memory')
        }
    }

    /**
     * Upload a file from the configured upload directory.
     *
     * `name` is resolved inside that directory; anything outside it is
     * refused before a byte is read.
     */
    async uploadFile(name: string, spaceId?: string, metadata?: Record<string, unknown>): Promise<Record<string, any>> {
        const resolved = resolveUploadPath(name, this.uploadDir)
        try {
            const created: any = await (this.client.memories as any).createFromPath({
                path: resolved,
                spaceId: this.requireSpaceId(spaceId),
                ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
            })
            return {
                memoryId: created?.memoryId,
                spaceId: created?.spaceId,
                fileName: basename(resolved),
                processingStatus: created?.processingStatus ?? 'PENDING'
            }
        } catch (error: any) {
            throw describeError(error, `Uploading ${JSON.stringify(basename(resolved))}`)
        }
    }

    /** Every space the key can see, following pagination internally. */
    async listSpaces(): Promise<Record<string, any>[]> {
        try {
            const out: Record<string, any>[] = []
            for await (const space of (await this.client.spaces.list({} as any)) as any) {
                out.push(space)
                if (out.length >= this.maxListItems) break
            }
            return out
        } catch (error: any) {
            throw describeError(error, 'Listing spaces')
        }
    }

    /** Every embedder registered on the server. */
    async listEmbedders(): Promise<Record<string, any>[]> {
        try {
            const listed: any = await this.client.embedders.list({} as any)
            const out: Record<string, any>[] = []
            for await (const embedder of listed) {
                out.push(embedder)
                if (out.length >= this.maxListItems) break
            }
            return out
        } catch (error: any) {
            throw describeError(error, 'Listing embedders')
        }
    }

    /** Memories in a space, following pagination internally. */
    async listMemories(spaceId?: string): Promise<Record<string, any>[]> {
        const target = this.requireSpaceId(spaceId)
        try {
            const out: Record<string, any>[] = []
            for await (const memory of (await this.client.memories.list(target, {} as any)) as any) {
                out.push(memory)
                if (out.length >= this.maxListItems) break
            }
            return out
        } catch (error: any) {
            throw describeError(error, 'Listing memories')
        }
    }

    /**
     * One memory, optionally with its stored content.
     *
     * Content is fetched as bytes and only decoded when the memory's own
     * content type says it is text. A PDF is returned base64-encoded and
     * intact rather than force-decoded into replacement characters.
     */
    async getMemory(memoryId: string, includeContent = false): Promise<Record<string, any>> {
        let memory: any
        try {
            memory = await this.client.memories.get(memoryId)
        } catch (error: any) {
            throw describeError(error, `Fetching memory ${JSON.stringify(memoryId)}`)
        }
        const result: Record<string, any> = { memory }
        if (!includeContent) return result
        try {
            const bytes: Uint8Array = await this.client.memories.content(memoryId)
            const buffer = Buffer.from(bytes)
            const contentType = String(memory?.contentType ?? '')
            if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) {
                result.content = buffer.toString('utf-8')
                result.contentEncoding = 'utf-8'
            } else {
                result.contentBase64 = buffer.toString('base64')
                result.contentEncoding = 'base64'
            }
            result.contentType = contentType
            result.contentBytes = buffer.length
        } catch (error: any) {
            result.contentError = describeError(error, 'Fetching memory content').message
        }
        return result
    }

    /**
     * Create a space, or reuse one of the same name.
     *
     * Reuse requires the existing space to carry the requested embedder. A
     * space built on a different embedder is a different search index, so
     * reusing it while reporting the requested embedder would write documents
     * that the caller's later searches cannot find.
     */
    async createSpace(name: string, embedderId?: string): Promise<Record<string, any>> {
        const wanted = embedderId ?? this.defaultEmbedderId
        if (!wanted) {
            throw new GoodMemError('No embedder configured. Set a Default Embedder on the GoodMem node to create spaces.')
        }
        const existing = (await this.listSpaces()).filter((s) => s?.name === name)
        if (existing.length > 1) {
            throw new GoodMemError(`${existing.length} spaces are named ${JSON.stringify(name)}; pass an explicit space id instead.`)
        }
        if (existing.length === 1) {
            const space = existing[0]
            const embedders: string[] = (space.spaceEmbedders ?? []).map((e: any) => String(e?.embedderId ?? e))
            if (!embedders.includes(wanted)) {
                throw new GoodMemError(
                    `Space ${JSON.stringify(name)} already exists but is built on embedder(s) ${embedders.join(', ') || '(none)'}, ` +
                        `not ${wanted}. A space's embedder cannot be changed; use a different name or the matching embedder.`
                )
            }
            return { spaceId: space.spaceId, name: space.name, embedderId: wanted, reused: true }
        }
        try {
            const created: any = await this.client.spaces.create({
                name,
                spaceEmbedders: [{ embedderId: wanted }]
            } as any)
            return { spaceId: created?.spaceId, name: created?.name ?? name, embedderId: wanted, reused: false }
        } catch (error: any) {
            throw describeError(error, `Creating space ${JSON.stringify(name)}`)
        }
    }

    /** Rename a space or change its labels. `publicRead` is not settable: the server rejects it. */
    async updateSpace(
        spaceId: string,
        changes: { name?: string; replaceLabels?: Record<string, string>; mergeLabels?: Record<string, string> }
    ): Promise<Record<string, any>> {
        const body: Record<string, unknown> = {}
        if (changes.name !== undefined) body.name = changes.name
        if (changes.replaceLabels !== undefined) body.replaceLabels = changes.replaceLabels
        if (changes.mergeLabels !== undefined) body.mergeLabels = changes.mergeLabels
        if (Object.keys(body).length === 0) throw new GoodMemError('Nothing to update: provide a name or labels.')
        try {
            const updated: any = await this.client.spaces.update(spaceId, body as any)
            return { spaceId: updated?.spaceId ?? spaceId, name: updated?.name }
        } catch (error: any) {
            throw describeError(error, `Updating space ${JSON.stringify(spaceId)}`)
        }
    }

    async deleteSpace(spaceId: string): Promise<void> {
        try {
            await this.client.spaces.delete(spaceId)
        } catch (error: any) {
            throw describeError(error, `Deleting space ${JSON.stringify(spaceId)}`)
        }
    }

    async deleteMemory(memoryId: string): Promise<void> {
        try {
            await this.client.memories.delete(memoryId)
        } catch (error: any) {
            throw describeError(error, `Deleting memory ${JSON.stringify(memoryId)}`)
        }
    }

    /** Read a file from the upload directory without sending it anywhere. Used by tests. */
    readConfinedFile(name: string): Buffer {
        return readFileSync(resolveUploadPath(name, this.uploadDir))
    }
}
