/**
 * What one catalog upload may weigh.
 *
 * ITS OWN MODULE, WITH NO IMPORTS, and that is the entire point. The value is enforced twice — in
 * the import panel so a mistake is caught before a multi-megabyte round trip, and again in the
 * server action, which is the one that actually binds — so it has to be reachable from a client
 * component AND from server code.
 *
 * It briefly lived in `catalog-list.ts`, which imports `@stopgap/catalog`; that pulled the whole
 * server chain into the browser bundle and the build failed on `node:crypto`, several packages
 * down. A constant shared across the server/client boundary belongs somewhere that imports
 * nothing, because anything it imports travels with it.
 */
export const MAX_UPLOAD_BYTES = 8_000_000;
