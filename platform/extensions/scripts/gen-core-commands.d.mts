// Types for gen-core-commands.mjs, for the specs that import it.

/** The wire's JSON Schema (`crates/paged-wire/schema/mutation.schema.json`). */
export declare const SCHEMA: string;
/** The generated file, `packages/plugin-sdk/src/core-commands.generated.ts`. */
export declare const TARGET: string;
/** The generated file's text for the JSON text of the wire schema. */
export declare function generate(schemaText: string): string;
