import { convertMultiOptionsToStringArray, getCredentialData, getCredentialParam } from '../../../src/utils'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { createGoodMemTools, DEFAULT_ACTIONS, DESTRUCTIVE_ACTIONS, GoodMemAction, GOODMEM_ACTIONS } from './core'
import { GoodMemConnection } from './client'
import { parseFilterInput } from './filters'

const ALL_ACTION_OPTIONS: { label: string; name: GoodMemAction; description: string }[] = [
    { label: 'Search Memories', name: 'retrieveMemories', description: 'Semantic search — exposes goodmem_search(query, top_k)' },
    { label: 'Remember Text', name: 'createMemory', description: 'Store text — exposes goodmem_remember(text)' },
    {
        label: 'Upload File',
        name: 'uploadFile',
        description: 'Store a file from the Upload Directory — exposes goodmem_upload_file(file_name). Needs an Upload Directory.'
    },
    { label: 'List Memories', name: 'listMemories', description: 'List memories in a space (pagination followed internally)' },
    { label: 'Get Memory', name: 'getMemory', description: 'Fetch one memory, optionally with its stored document' },
    { label: 'List Spaces', name: 'listSpaces', description: 'List every visible space' },
    { label: 'Get Space', name: 'getSpace', description: 'Fetch one space by ID' },
    { label: 'List Embedders', name: 'listEmbedders', description: 'List embedder models on the server' },
    { label: 'Create Space', name: 'createSpace', description: 'Create a space (reuses a same-named space only if the embedder matches)' },
    { label: 'Rename Space (destructive)', name: 'updateSpace', description: 'Rename a space. Off by default.' },
    {
        label: 'Delete Space (destructive)',
        name: 'deleteSpace',
        description: 'Permanently delete a space and its memories. Off by default.'
    },
    { label: 'Delete Memory (destructive)', name: 'deleteMemory', description: 'Permanently delete one memory. Off by default.' }
]

// Flowise's form layer can serialize booleans as the string "true"/"false".
// Default to verify=true when unset; only flip to false when explicitly false.
const parseVerifySsl = (raw: unknown): boolean => {
    if (raw === undefined || raw === null) return true
    if (typeof raw === 'boolean') return raw
    return String(raw).toLowerCase() !== 'false'
}

const optionalNumber = (raw: unknown): number | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
}

class GoodMem_Tools implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'GoodMem'
        this.name = 'goodMem'
        this.version = 2.0
        this.type = 'GoodMem'
        this.icon = 'goodmem.png'
        this.category = 'Tools'
        this.description = 'Memory layer for AI agents: semantic storage and retrieval via GoodMem.'
        this.baseClasses = [this.type, 'Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['goodMemApi']
        }
        this.inputs = [
            {
                label: 'Actions',
                name: 'actions',
                type: 'multiOptions',
                description:
                    'Which GoodMem operations the agent can call. Defaults to reading and writing memories. The three destructive ' +
                    'actions are off until you switch them on here.',
                options: ALL_ACTION_OPTIONS.map((a) => ({ label: a.label, name: a.name, description: a.description })),
                default: DEFAULT_ACTIONS
            },
            {
                label: 'Default Space',
                name: 'defaultSpaceId',
                type: 'asyncOptions',
                loadMethod: 'listSpaces',
                description: 'The space the tools read and write. Pulled live from your GoodMem server.',
                optional: true,
                refresh: true
            },
            {
                label: 'Default Embedder',
                name: 'defaultEmbedderId',
                type: 'asyncOptions',
                loadMethod: 'listEmbedders',
                description: 'Embedder used when a space has to be created. Pulled live from your GoodMem server.',
                optional: true,
                refresh: true,
                additionalParams: true
            },
            {
                label: 'Reranker',
                name: 'rerankerId',
                type: 'asyncOptions',
                loadMethod: 'listRerankers',
                description:
                    'Optional reranker applied to every search. You choose this, not the agent, so a prompt cannot change what a ' +
                    'search means.',
                optional: true,
                refresh: true,
                additionalParams: true
            },
            {
                label: 'Metadata Filter',
                name: 'metadataFilter',
                type: 'string',
                rows: 3,
                placeholder: '{"category": "support", "archived": false}',
                description:
                    'A JSON object of metadata equality conditions applied server-side to every search. Values are escaped and cast ' +
                    'to the type GoodMem stored them as; the agent never composes this.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Minimum Score',
                name: 'minScore',
                type: 'number',
                description:
                    'Drop results scoring below this. Scores are oriented so higher is better, but the scale depends on the model — ' +
                    'vector scores are oriented distances and reranker scales are provider-dependent. This is not a 0-1 range; ' +
                    'measure your own before setting it. Leave empty to keep every result.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Upload Directory',
                name: 'uploadDir',
                type: 'string',
                placeholder: '/var/lib/flowise/goodmem-uploads',
                description:
                    'Absolute path the Upload File action is confined to. Without it, file upload is not exposed at all. Paths outside ' +
                    'this directory — including through symlinks — are refused.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Max List Items',
                name: 'maxListItems',
                type: 'number',
                default: 200,
                description: 'Upper bound on how many items a list action returns while following pagination internally.',
                optional: true,
                additionalParams: true
            }
        ]
    }

    /** Build a connection from the node's credential for the live-loading dropdowns. */
    private async connectionFor(nodeData: INodeData, options?: ICommonObject): Promise<GoodMemConnection | null> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options ?? {})
        const baseUrl = getCredentialParam('goodMemBaseUrl', credentialData, nodeData)
        const apiKey = getCredentialParam('goodMemApiKey', credentialData, nodeData)
        const verifySsl = parseVerifySsl(getCredentialParam('goodMemVerifySsl', credentialData, nodeData))
        if (!baseUrl || !apiKey) return null
        return new GoodMemConnection({ baseUrl, apiKey, verifySsl })
    }

    loadMethods: Record<string, (_nodeData: INodeData, _options?: ICommonObject) => Promise<INodeOptionsValue[]>> = {
        listEmbedders: async (nodeData, options) => {
            try {
                const connection = await this.connectionFor(nodeData, options)
                if (!connection) {
                    return [{ label: 'Credentials Required', name: '', description: 'Connect a GoodMem API credential to load embedders.' }]
                }
                const embedders = await connection.listEmbedders()
                if (!embedders.length) {
                    return [{ label: 'No embedders found', name: '', description: 'No embedders are configured on this GoodMem server.' }]
                }
                return embedders.map((e: any) => {
                    const id = e.embedderId ?? e.id ?? ''
                    const name = e.displayName ?? e.name ?? id
                    const provider = e.providerType ?? e.provider ?? ''
                    return { label: provider ? `${name} (${provider})` : name, name: id, description: id }
                })
            } catch (error) {
                return [
                    {
                        label: 'Error Loading Embedders',
                        name: '',
                        description: error instanceof Error ? error.message : String(error)
                    }
                ]
            }
        },
        listSpaces: async (nodeData, options) => {
            try {
                const connection = await this.connectionFor(nodeData, options)
                if (!connection) {
                    return [{ label: 'Credentials Required', name: '', description: 'Connect a GoodMem API credential to load spaces.' }]
                }
                const spaces = await connection.listSpaces()
                if (!spaces.length) {
                    return [{ label: 'No spaces found', name: '', description: 'No spaces exist on this GoodMem server yet.' }]
                }
                return spaces.map((s: any) => ({
                    label: s.name ?? s.spaceId ?? '',
                    name: s.spaceId ?? s.id ?? '',
                    description: s.spaceId ?? ''
                }))
            } catch (error) {
                return [{ label: 'Error Loading Spaces', name: '', description: error instanceof Error ? error.message : String(error) }]
            }
        },
        listRerankers: async (nodeData, options) => {
            try {
                const connection = await this.connectionFor(nodeData, options)
                if (!connection) {
                    return [{ label: 'Credentials Required', name: '', description: 'Connect a GoodMem API credential to load rerankers.' }]
                }
                const rerankers: any[] = []
                for await (const reranker of (await (connection.client as any).rerankers.list({})) as any) {
                    rerankers.push(reranker)
                }
                if (!rerankers.length) {
                    return [{ label: 'No rerankers found', name: '', description: 'Searches will use vector scores only.' }]
                }
                return rerankers.map((r: any) => ({
                    label: r.displayName ?? r.name ?? r.rerankerId ?? '',
                    name: r.rerankerId ?? r.id ?? '',
                    description: r.rerankerId ?? ''
                }))
            } catch (error) {
                return [{ label: 'Error Loading Rerankers', name: '', description: error instanceof Error ? error.message : String(error) }]
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const baseUrl = getCredentialParam('goodMemBaseUrl', credentialData, nodeData)
        const apiKey = getCredentialParam('goodMemApiKey', credentialData, nodeData)
        const verifySsl = parseVerifySsl(getCredentialParam('goodMemVerifySsl', credentialData, nodeData))

        if (!baseUrl) throw new Error('GoodMem Base URL is required. Set it on the GoodMem API credential.')
        if (!apiKey) throw new Error('GoodMem API Key is required. Set it on the GoodMem API credential.')

        const selected = convertMultiOptionsToStringArray(nodeData.inputs?.actions)
        const known = GOODMEM_ACTIONS as readonly string[]
        let actions: string[]
        if (selected.length === 0) {
            actions = [...DEFAULT_ACTIONS]
        } else {
            actions = selected.filter((a) => known.includes(a))
            if (actions.length === 0) {
                throw new Error(`No valid GoodMem actions selected. Choose at least one of: ${known.join(', ')}.`)
            }
        }

        const uploadDir = (nodeData.inputs?.uploadDir as string) || undefined
        if (actions.includes('uploadFile') && !uploadDir) {
            throw new Error(
                'The Upload File action needs an Upload Directory. Set one on the GoodMem node, or remove Upload File from Actions.'
            )
        }

        const enabledDestructive = DESTRUCTIVE_ACTIONS.filter((a) => actions.includes(a))
        if (enabledDestructive.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
                `[GoodMem] This node exposes destructive tools to the agent: ${enabledDestructive.join(', ')}. ` +
                    'The model can delete or rename data in the connected GoodMem instance.'
            )
        }

        return createGoodMemTools({
            baseUrl,
            apiKey,
            verifySsl,
            actions,
            uploadDir,
            defaultSpaceId: (nodeData.inputs?.defaultSpaceId as string) || undefined,
            defaultEmbedderId: (nodeData.inputs?.defaultEmbedderId as string) || undefined,
            rerankerId: (nodeData.inputs?.rerankerId as string) || undefined,
            metadataFilter: parseFilterInput(nodeData.inputs?.metadataFilter),
            minScore: optionalNumber(nodeData.inputs?.minScore),
            maxListItems: optionalNumber(nodeData.inputs?.maxListItems)
        })
    }
}

module.exports = { nodeClass: GoodMem_Tools }
