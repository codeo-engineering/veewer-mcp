/**
 * The scope vocabulary (23002-1145), identical to the backend's `Core/Security/OAuth/ApiScopes`.
 *
 * `models:read` is the minimum -- the backend never issues a token or a key without it -- and the
 * only one the read tools need; `models:write` (rename, move, upload) and `models:delete` gate
 * the write tools. Kept in its own module so the stdio entry, which never touches OAuth, does not
 * pull `jose` in just to learn the names.
 */
export const SCOPE_READ = "models:read";
export const SCOPE_WRITE = "models:write";
export const SCOPE_DELETE = "models:delete";
export const SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_DELETE] as const;

/** The token's `scope` claim (space-separated, as the backend writes it) as a list; unknown words kept. */
export function parseScopes(claim: unknown): string[] {
  if (typeof claim !== "string") return [];
  return claim.split(/\s+/).filter(Boolean);
}

/**
 * Whether a tool needing `scope` may be registered for this caller. `undefined` granted scopes
 * means "not known" -- an API key (its scopes live only in the backend) or the stdio entry -- and
 * every tool is registered; a scope the key lacks then comes back as the backend's own 403.
 */
export function isToolAllowed(grantedScopes: string[] | undefined, scope: string): boolean {
  return grantedScopes === undefined || grantedScopes.includes(scope);
}
