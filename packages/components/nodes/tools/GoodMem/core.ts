import { z } from 'zod/v3'
import { DynamicStructuredTool } from '../OpenAPIToolkit/core'
import { TOOL_ARGS_PREFIX, formatToolError } from '../../../src/agents'
import { GoodMemConnection, GoodMemConnectionOptions, GoodMemError } from './client'
import { warningText } from './results'

export const desc = `Use this when you want to interact with GoodMem - a memory layer for AI agents that handles semantic storage and vector retrieval.`

/**
 * The model-facing surface.
 *
 * Two principles decide what a tool accepts. Anything that changes *what a
 * search means* -- the reranker, the metadata filter, the score threshold,
 * the upload directory -- is configuration the developer sets on the node,
 * because a model that can widen its own scope has no scope. Anything
 * destructive is off unless the developer turns it on.
 *
 * What is left is what the model genuinely decides: the query, the text to
 * remember, which document to read.
 */

const SearchSchema = z.object({
    query: z.string().describe('A natural language question or phrase to find semantically similar memories for.'),
    top_k: z.number().int().min(1).max(50).optional().default(5).describe('How many matching chunks to return (1-50).')
})

const RememberSchema = z.object({
    text: z.string().describe('The text to store as a memory so it can be recalled later.')
})

const UploadFileSchema = z.object({
    file_name: z
        .string()
        .describe("Name of a file inside the node's configured Upload Directory. Paths outside that directory are refused.")
})

const ListSpacesSchema = z.object({})
const ListEmbeddersSchema = z.object({})

const GetSpaceSchema = z.object({
    space_id: z.string().optional().describe('The UUID of the space to fetch. Defaults to the space configured on the GoodMem node.')
})

const ListMemoriesSchema = z.object({
    space_id: z.string().optional().describe('The UUID of the space to list. Defaults to the space configured on the GoodMem node.')
})

const GetMemorySchema = z.object({
    memory_id: z.string().describe('The UUID of the memory to fetch.'),
    include_content: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also return the stored document. Text is returned as text; anything else is returned base64-encoded.')
})

const CreateSpaceSchema = z.object({
    name: z.string().describe('A name for the space. An existing space with this name is reused only if its embedder matches.')
})

const UpdateSpaceSchema = z.object({
    space_id: z.string().describe('The UUID of the space to update.'),
    name: z.string().describe('The new name for the space.')
})

const DeleteSpaceSchema = z.object({
    space_id: z.string().describe('The UUID of the space to delete. This cannot be undone.')
})

const DeleteMemorySchema = z.object({
    memory_id: z.string().describe('The UUID of the memory to delete. This cannot be undone.')
})

export interface GoodMemFactoryArgs extends GoodMemConnectionOptions {
    actions?: string[]
}

abstract class BaseGoodMemTool extends DynamicStructuredTool {
    protected connection: GoodMemConnection

    constructor(toolInput: any, connection: GoodMemConnection, baseUrl: string) {
        super({ ...toolInput, baseUrl, method: 'POST', headers: {} })
        this.connection = connection
    }

    protected ok(result: any, params: any): string {
        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    protected fail(err: unknown, params: any): string {
        const message = err instanceof GoodMemError || err instanceof Error ? err.message : String(err)
        return formatToolError(message, params)
    }
}

class SearchTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_search',
                description:
                    'Search stored memories for information relevant to a question. Returns the matching passages with a relevance ' +
                    'score where higher is a better match.',
                schema: SearchSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof SearchSchema>): Promise<string> {
        try {
            const outcome = await this.connection.search(arg.query, arg.top_k ?? 5)
            const payload: Record<string, any> = {
                query: arg.query,
                totalResults: outcome.hits.length,
                results: outcome.hits.map((h) => ({
                    chunkId: h.chunkId,
                    text: h.text,
                    memoryId: h.memoryId,
                    spaceId: h.spaceId,
                    score: h.score,
                    rawScore: h.rawScore,
                    scoreKind: h.scoreKind,
                    metadata: h.metadata
                })),
                // Q4a and Q4b of the retrieval status contract: a degraded
                // retrieval always says so, whether or not hits came back.
                partial: outcome.partial,
                statuses: outcome.statuses
            }
            if (outcome.partial) {
                payload.warning =
                    outcome.hits.length === 0
                        ? `${warningText(outcome.statuses)}. This is NOT an empty memory store - the search itself was degraded, so ` +
                          'do not conclude that nothing is stored.'
                        : warningText(outcome.statuses)
            }
            if (outcome.abstractReply) payload.abstractReply = outcome.abstractReply
            return this.ok(payload, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class RememberTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_remember',
                description: 'Store a piece of text in memory so it can be recalled in a later turn or by another chatflow.',
                schema: RememberSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof RememberSchema>): Promise<string> {
        try {
            return this.ok(await this.connection.remember(arg.text), arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class UploadFileTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_upload_file',
                description:
                    'Store a file from the configured upload directory as a memory. Only files inside that directory can be uploaded.',
                schema: UploadFileSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof UploadFileSchema>): Promise<string> {
        try {
            return this.ok(await this.connection.uploadFile(arg.file_name), arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class ListSpacesTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_list_spaces',
                description: 'List every GoodMem space this connection can see.',
                schema: ListSpacesSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof ListSpacesSchema>): Promise<string> {
        try {
            const spaces = await this.connection.listSpaces()
            return this.ok({ spaces, totalSpaces: spaces.length }, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class ListEmbeddersTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_list_embedders',
                description: 'List the embedder models registered on the GoodMem server.',
                schema: ListEmbeddersSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof ListEmbeddersSchema>): Promise<string> {
        try {
            const embedders = await this.connection.listEmbedders()
            return this.ok({ embedders, totalEmbedders: embedders.length }, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class GetSpaceTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_get_space',
                description: 'Fetch one GoodMem space by ID, including its name, labels and embedder configuration.',
                schema: GetSpaceSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof GetSpaceSchema>): Promise<string> {
        try {
            const spaceId = this.connection.requireSpaceId(arg.space_id)
            const spaces = await this.connection.listSpaces()
            const space = spaces.find((s) => s.spaceId === spaceId)
            if (!space) throw new GoodMemError(`No space with id ${JSON.stringify(spaceId)} is visible to this connection.`)
            return this.ok({ space }, { ...arg, space_id: spaceId })
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class ListMemoriesTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_list_memories',
                description:
                    'List the memories stored in a space. Pagination is followed internally, so the list returned is complete up to ' +
                    "the node's Max List Items.",
                schema: ListMemoriesSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof ListMemoriesSchema>): Promise<string> {
        try {
            const spaceId = this.connection.requireSpaceId(arg.space_id)
            const memories = await this.connection.listMemories(spaceId)
            return this.ok(
                {
                    spaceId,
                    memories,
                    totalMemories: memories.length,
                    truncated: memories.length >= this.connection.maxListItems
                },
                { ...arg, space_id: spaceId }
            )
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class GetMemoryTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_get_memory',
                description: 'Fetch one memory by ID, optionally including the document that was stored.',
                schema: GetMemorySchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof GetMemorySchema>): Promise<string> {
        try {
            return this.ok(await this.connection.getMemory(arg.memory_id, arg.include_content ?? false), arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class CreateSpaceTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_create_space',
                description: 'Create a GoodMem space, or reuse an existing space of the same name when it was built on the same embedder.',
                schema: CreateSpaceSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof CreateSpaceSchema>): Promise<string> {
        try {
            return this.ok(await this.connection.createSpace(arg.name), arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class UpdateSpaceTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_update_space',
                description: 'Rename a GoodMem space.',
                schema: UpdateSpaceSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof UpdateSpaceSchema>): Promise<string> {
        try {
            return this.ok(await this.connection.updateSpace(arg.space_id, { name: arg.name }), arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class DeleteSpaceTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_delete_space',
                description: 'Permanently delete a GoodMem space and every memory in it. This cannot be undone.',
                schema: DeleteSpaceSchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof DeleteSpaceSchema>): Promise<string> {
        try {
            await this.connection.deleteSpace(arg.space_id)
            return this.ok({ spaceId: arg.space_id, deleted: true }, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

class DeleteMemoryTool extends BaseGoodMemTool {
    constructor(c: GoodMemConnection, baseUrl: string) {
        super(
            {
                name: 'goodmem_delete_memory',
                description: 'Permanently delete one GoodMem memory and its embeddings. This cannot be undone.',
                schema: DeleteMemorySchema
            },
            c,
            baseUrl
        )
    }

    async _call(arg: z.infer<typeof DeleteMemorySchema>): Promise<string> {
        try {
            await this.connection.deleteMemory(arg.memory_id)
            return this.ok({ memoryId: arg.memory_id, deleted: true }, arg)
        } catch (err) {
            return this.fail(err, arg)
        }
    }
}

/** Every action a chatflow can switch on, in the order they appear in the UI. */
export const GOODMEM_ACTIONS = [
    'retrieveMemories',
    'createMemory',
    'uploadFile',
    'listMemories',
    'getMemory',
    'listSpaces',
    'getSpace',
    'listEmbedders',
    'createSpace',
    'updateSpace',
    'deleteSpace',
    'deleteMemory'
] as const

export type GoodMemAction = (typeof GOODMEM_ACTIONS)[number]

/**
 * Actions enabled when the node is dropped on a canvas untouched.
 *
 * Reading and writing memories; no deleting, no renaming, no space
 * administration, and no file upload (which additionally needs an upload
 * directory before it will do anything).
 */
export const DEFAULT_ACTIONS: GoodMemAction[] = [
    'retrieveMemories',
    'createMemory',
    'listMemories',
    'getMemory',
    'listSpaces',
    'getSpace',
    'listEmbedders'
]

/** Actions that can destroy or rename data, and are therefore never on by default. */
export const DESTRUCTIVE_ACTIONS: GoodMemAction[] = ['updateSpace', 'deleteSpace', 'deleteMemory']

const BUILDERS: Record<GoodMemAction, (c: GoodMemConnection, baseUrl: string) => DynamicStructuredTool> = {
    retrieveMemories: (c, u) => new SearchTool(c, u),
    createMemory: (c, u) => new RememberTool(c, u),
    uploadFile: (c, u) => new UploadFileTool(c, u),
    listMemories: (c, u) => new ListMemoriesTool(c, u),
    getMemory: (c, u) => new GetMemoryTool(c, u),
    listSpaces: (c, u) => new ListSpacesTool(c, u),
    getSpace: (c, u) => new GetSpaceTool(c, u),
    listEmbedders: (c, u) => new ListEmbeddersTool(c, u),
    createSpace: (c, u) => new CreateSpaceTool(c, u),
    updateSpace: (c, u) => new UpdateSpaceTool(c, u),
    deleteSpace: (c, u) => new DeleteSpaceTool(c, u),
    deleteMemory: (c, u) => new DeleteMemoryTool(c, u)
}

export const createGoodMemTools = (args: GoodMemFactoryArgs): DynamicStructuredTool[] => {
    const connection = new GoodMemConnection(args)
    const requested = args.actions && args.actions.length > 0 ? args.actions : DEFAULT_ACTIONS
    const tools: DynamicStructuredTool[] = []
    for (const action of GOODMEM_ACTIONS) {
        if (!requested.includes(action)) continue
        // Uploading is meaningless without a directory to confine it to, and
        // silently exposing a tool that always fails is worse than not
        // exposing it.
        if (action === 'uploadFile' && !args.uploadDir) continue
        tools.push(BUILDERS[action](connection, args.baseUrl))
    }
    return tools
}
