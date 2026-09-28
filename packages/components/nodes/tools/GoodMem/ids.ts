/**
 * The one check every GoodMem id passes before it is sent anywhere.
 *
 * Memory, space, embedder and reranker ids are UUIDs, and several of them are
 * interpolated into a URL path (`/v1/memories/{id}`, `/v1/spaces/{id}/memories`).
 * The SDK percent-encodes the id, but it leaves `.` alone and the URL is then
 * resolved, so an id of `..` turns `DELETE /v1/memories/..` into
 * `DELETE /v1/`; and what the server does with an encoded `..%2Fspaces%2F<id>`
 * is not something this node controls. Neither side can be relied on, so an id
 * that is not a canonical UUID is refused here, before any request is made.
 *
 * Every id-taking method in `client.ts` calls `requireUuid` immediately before
 * the SDK call, whether the id came from the model, from the developer or from
 * node configuration. The model-facing schemas in `core.ts` declare the same
 * pattern so the model is told up front, but this check is the guard.
 */

/** A canonical 8-4-4-4-12 hex UUID and nothing else: no whitespace, no query, no fragment. */
export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** What a caller is told when an id is refused. Names the field and what it must be. */
export function uuidRequirement(field: string): string {
    return `${field} must be a GoodMem UUID (8-4-4-4-12 hex digits, e.g. 01a0d44b-748d-72eb-b54e-c3ea2d956927)`
}

/** Thrown when an id is not a canonical UUID. No request has been made when this is raised. */
export class GoodMemIdError extends Error {
    readonly field: string
    constructor(field: string, value: unknown) {
        const shown = typeof value === 'string' ? JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value) : String(value)
        super(`${uuidRequirement(field)}; got ${shown}. Refused before any request was sent.`)
        this.name = 'GoodMemIdError'
        this.field = field
    }
}

/**
 * Return `value` as a lowercase canonical UUID, or throw.
 *
 * @param field the name the caller knows the id by (a tool argument such as
 * `memory_id`, or a node setting such as `Default Space`), used in the error.
 * @throws {GoodMemIdError} if `value` is not a string holding exactly one UUID.
 */
export function requireUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new GoodMemIdError(field, value)
    }
    return value.toLowerCase()
}
