/**
 * OAuth resource-server side of the hosted MCP server (23002-1140).
 *
 * The MCP authorization spec makes this server an OAuth 2.1 resource server: it advertises its
 * authorization server through Protected Resource Metadata (RFC 9728), challenges with a 401
 * that names that document, and validates every bearer token it receives -- signature, issuer,
 * expiry and, above all, audience: a token minted for some other resource MUST be refused even
 * when it comes from the same authorization server.
 *
 * Validation is local, against the authorization server's JWKS (design decision D2): no call to
 * the backend per request, the key set is fetched once and cached by `jose`. The claims checked
 * here are exactly the ones the backend's own `OAuthTokenService` checks, so the two sides
 * cannot disagree about what a valid token is. `purpose=mcp` is the backend's marker that
 * separates these tokens from its session JWTs; a token without it is not ours to accept.
 *
 * Everything is switched on by `VEEWER_OAUTH_ISSUER`. Without it the server behaves exactly as
 * before (API key only, no challenge header): the backend it points at may not have OAuth
 * enabled, and a challenge that names a 404 would send every client on a dead-end discovery.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const SCOPE = "models:read";

export interface OAuthConfig {
  /** The authorization server's issuer, e.g. https://server.veewer.com (the backend origin). */
  issuer: string;
  /** This server's canonical URL, the token audience, e.g. https://mcp.veewer.com/mcp. */
  resource: string;
}

/**
 * Reads the configuration from the environment. `resource` is the URL users type into their
 * client, path included -- Claude requires the metadata's `resource` to match it exactly.
 */
export function readOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig | null {
  const issuer = env.VEEWER_OAUTH_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer) return null;

  const resource = env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!resource) {
    throw new Error("VEEWER_OAUTH_ISSUER is set but MCP_PUBLIC_URL is not; the resource URL is required.");
  }

  for (const [name, value] of [["VEEWER_OAUTH_ISSUER", issuer], ["MCP_PUBLIC_URL", resource]]) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} is not an absolute URL: ${value}`);
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error(`${name} must be https: ${value}`);
    }
  }

  return { issuer, resource };
}

/** RFC 9728 document. `authorization_servers[0]` is what Claude uses; it does not fall back. */
export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "VEEWER",
    resource_documentation: "https://veewer.com/mcp",
  };
}

/**
 * Where the metadata document lives: RFC 9728 §3.1 puts a resource with a path at
 * `/.well-known/oauth-protected-resource<path>`; the path-less form is served too. Both are
 * derived from the resource URL so the three places that name it cannot drift.
 */
export function metadataPaths(config: OAuthConfig): { withPath: string; root: string } {
  const url = new URL(config.resource);
  const root = "/.well-known/oauth-protected-resource";
  return { root, withPath: url.pathname === "/" ? root : root + url.pathname };
}

/** The 401 challenge (RFC 6750 §3), with the metadata pointer Claude discovers from. */
export function challengeHeader(config: OAuthConfig, error?: "invalid_token"): string {
  const url = new URL(config.resource);
  const parts = [
    error ? `error="${error}"` : null,
    `resource_metadata="${url.origin}${metadataPaths(config).withPath}"`,
    `scope="${SCOPE}"`,
  ].filter(Boolean);

  return `Bearer ${parts.join(", ")}`;
}

export class TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: OAuthConfig) {
    this.jwks = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`), {
      // A key the set does not know triggers one refetch, but not more often than this: a flood
      // of forged `kid`s must not turn into a flood of requests at the backend.
      cooldownDuration: 30_000,
      cacheMaxAge: 60 * 60 * 1000,
    });
  }

  /**
   * Returns the payload of a valid token, or null. Every refusal is a 401 upstream; the reason
   * goes to the log, never to the caller (a forger learns nothing from "wrong audience").
   */
  async verify(token: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.resource,
        algorithms: ["RS256"],
        clockTolerance: 30,
      });

      if (payload.purpose !== "mcp" || typeof payload.uid !== "string" || !payload.uid) {
        console.error("bearer refused: not an MCP access token");
        return null;
      }

      return payload;
    } catch (error) {
      console.error(`bearer refused: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
