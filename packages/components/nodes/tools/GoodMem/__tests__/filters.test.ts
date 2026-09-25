/**
 * Metadata filters.
 *
 * The escaping and casting rules asserted here were probed against a live
 * GoodMem server (server-v1.0.320): `\'` escapes, `''` does not, and a cast
 * that does not match the stored type is accepted and matches nothing.
 */

import {
    GoodMemFilterError,
    allOf,
    anyOf,
    compare,
    equals,
    escapeLiteral,
    fromMapping,
    notEquals,
    oneOf,
    parseFilterInput
} from '../filters'

describe('literal escaping', () => {
    it("escapes an apostrophe as \\' rather than doubling it", () => {
        expect(escapeLiteral("O'Brien")).toBe("'O\\'Brien'")
        expect(escapeLiteral("O'Brien")).not.toContain("''")
    })

    it('escapes backslashes before quotes so the escape cannot be broken out of', () => {
        expect(escapeLiteral('back\\slash')).toBe("'back\\\\slash'")
    })

    it('refuses control characters the server rejects inside a literal', () => {
        expect(() => escapeLiteral('two\nlines')).toThrow(GoodMemFilterError)
        expect(() => escapeLiteral('tab\there')).toThrow(/control characters/)
    })

    it('contains a filter-injection attempt inside one quoted literal', () => {
        const expression = equals('owner', "x' OR '1'='1")

        expect(expression).toBe("CAST(val('$.owner') AS TEXT) = 'x\\' OR \\'1\\'=\\'1'")
        // The payload's quotes are all escaped, so nothing after `x` can be
        // read as filter syntax.
        expect(expression.match(/(?<!\\)'/g)).toHaveLength(4)
    })
})

describe('type casts', () => {
    it('casts a string to TEXT', () => {
        expect(equals('category', 'hobby')).toBe("CAST(val('$.category') AS TEXT) = 'hobby'")
    })

    it('casts a number to NUMERIC without quoting it', () => {
        expect(equals('score', 12.5)).toBe("CAST(val('$.score') AS NUMERIC) = 12.5")
    })

    it('casts a boolean to BOOLEAN, which TEXT would silently fail to match', () => {
        expect(equals('archived', false)).toBe("CAST(val('$.archived') AS BOOLEAN) = false")
        expect(equals('archived', true)).not.toContain('TEXT')
    })

    it('refuses values it cannot cast', () => {
        expect(() => equals('field', { nested: true } as unknown)).toThrow(/Unsupported filter value type/)
        expect(() => equals('field', Number.NaN)).toThrow(/finite/)
    })

    it('refuses a field name that is not a plain path', () => {
        expect(() => equals("bad') OR ('1'='1", 'x')).toThrow(/Unsupported metadata field name/)
    })
})

describe('composition', () => {
    it('builds inequality and ordering comparisons', () => {
        expect(notEquals('state', 'closed')).toBe("CAST(val('$.state') AS TEXT) != 'closed'")
        expect(compare('age', '>=', 18)).toBe("CAST(val('$.age') AS NUMERIC) >= 18")
        expect(() => compare('age', '>' as any, Number.POSITIVE_INFINITY)).toThrow(/finite numbers/)
    })

    it('builds an IN filter and refuses mixed types', () => {
        expect(oneOf('tier', ['gold', 'silver'])).toBe("CAST(val('$.tier') AS TEXT) IN ('gold', 'silver')")
        expect(() => oneOf('tier', ['gold', 7])).toThrow(/same type/)
        expect(() => oneOf('tier', [])).toThrow(/at least one value/)
    })

    it('combines expressions and drops empty ones', () => {
        expect(allOf("a = '1'", null, "b = '2'")).toBe("(a = '1') AND (b = '2')")
        expect(anyOf("a = '1'", undefined)).toBe("a = '1'")
        expect(allOf(null, undefined)).toBe('')
    })

    it('builds a stable AND from a mapping', () => {
        expect(fromMapping({ b: 2, a: 'one' })).toBe("(CAST(val('$.a') AS TEXT) = 'one') AND (CAST(val('$.b') AS NUMERIC) = 2)")
        expect(fromMapping({})).toBe('')
        expect(fromMapping(undefined)).toBe('')
    })
})

describe("the node's Metadata Filter input", () => {
    it('accepts a JSON object as typed into the form', () => {
        expect(parseFilterInput('{"category":"support","archived":false}')).toEqual({ category: 'support', archived: false })
    })

    it('treats an empty input as no filter', () => {
        expect(parseFilterInput('')).toEqual({})
        expect(parseFilterInput(undefined)).toEqual({})
        expect(parseFilterInput(null)).toEqual({})
    })

    it('explains itself when the input is not a JSON object', () => {
        expect(() => parseFilterInput('not json')).toThrow(/must be a JSON object/)
        expect(() => parseFilterInput('[1,2]')).toThrow(/must be a JSON object/)
        expect(() => parseFilterInput('{"nested":{"a":1}}')).toThrow(/string, number or boolean/)
    })
})
