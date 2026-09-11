/**
 * VEEWER public API'sinin ince istemcisi (23002-1120).
 *
 * Burada is mantigi YOK: sunucu ne donuyorsa o iletiliyor. Bir kural iki yerde durursa
 * (backend ve burada) er ya da gec ayrisir ve MCP kullanicisi web arayuzunden farkli bir
 * cevap gorur.
 */

const DEFAULT_BASE_URL = "https://server.veewer.com/api/v1/public";

/**
 * The lowest supported Node version. The line is where `fetch` became global: before 18 every
 * call below fails with "fetch is not defined" -- but the server starts fine and lists its tools,
 * so it looks like "the tools are there and none of them work". The package.json `engines` field
 * does NOT prevent this, npm only prints a warning.
 *
 * The check lives here rather than in an entry point because this is the file that has the
 * constraint, and there are now two entry points that would each have to remember it.
 */
const MINIMUM_NODE_MAJOR = 18;

/**
 * The complaint to print when the runtime is too old, or null when it is fine. This reports
 * rather than exits: killing the process is an entry point's decision, and a module that other
 * code merely imports must not be able to take the process down.
 */
export function unsupportedNodeMessage(): string | null {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major >= MINIMUM_NODE_MAJOR) return null;

  return (
    `VEEWER MCP needs Node.js ${MINIMUM_NODE_MAJOR} or newer, but this one is ${process.versions.node}. ` +
    "Update Node (20 LTS or newer is recommended) and start the server again."
  );
}

/**
 * How long to wait for the VEEWER API before giving up. Without a deadline a stalled backend
 * holds the request open until whatever sits in front of the server cuts it -- around 230 seconds
 * on Azure App Service -- and on a small instance those held requests are the scarcest resource
 * there is. This is a client-side resource decision, not a copy of any backend rule.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export class VeewerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VeewerApiError";
  }
}

/**
 * Exactly one credential: a per-user API key (sent as `x-api-key`) or an OAuth access token
 * (sent as `Authorization: Bearer`, 23002-1140). The backend's public API accepts both and
 * mints the same identity from either; which header carries it is the only difference here.
 */
export interface VeewerClientOptions {
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
}

export class VeewerClient {
  private readonly authHeaders: Record<string, string>;
  private readonly baseUrl: string;

  constructor(options: VeewerClientOptions) {
    if (options.accessToken) {
      this.authHeaders = { authorization: `Bearer ${options.accessToken}` };
    } else if (options.apiKey) {
      this.authHeaders = { "x-api-key": options.apiKey };
    } else {
      throw new Error("VeewerClient needs an apiKey or an accessToken.");
    }

    // Sondaki egik cizgi kirpiliyor: adres yollari basta egik cizgiyle birlesiyor, aksi halde
    // istek cift egik cizgiyle gider.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && `${value}`.length > 0) {
        url.searchParams.set(key, `${value}`);
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          ...this.authHeaders,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new VeewerApiError(
          `VEEWER did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`,
          504,
        );
      }

      throw error;
    }

    if (!response.ok) {
      // Sunucunun mesaji varsa o gosteriliyor: "401" demek yerine "anahtar iptal edilmis"
      // demek, kullaniciyi dogru yere gonderen tek sey.
      const body = await response.text();
      let message = body;

      try {
        const parsed = JSON.parse(body);
        // The OAuth scheme answers in RFC 6749 shape (error_description); the API key scheme
        // and every other endpoint use `message`.
        message = parsed?.message ?? parsed?.error_description ?? body;
      } catch {
        // Govde JSON degilse ham metin kullanilir.
      }

      if (!message) {
        // Only when the API said nothing. A 429 gets named because a bare status reads as a
        // fault, but no waiting time is quoted: there are two windows per key and another per
        // IP, they live in the backend's configuration, and a number guessed here would be
        // wrong the day one of them changes.
        message =
          response.status === 429
            ? "Rate limit reached for this API key."
            : `Request failed with status ${response.status}`;
      }

      throw new VeewerApiError(message, response.status);
    }

    return (await response.json()) as T;
  }
}

export interface VeewerModel {
  id: string;
  name: string | null;
  folderId: string | null;
  status: "active" | "processing" | "failed";
  failureReason: string | null;
  hasAr: boolean;
  /** Upload format, upper case ("RVT"); the same names as VeewerAccount.creditCosts. */
  format: string | null;
  /** Storage the model takes against the quota, in bytes (converted output, not the source file); 0 while processing. */
  storageBytes: number;
  hasThumbnail: boolean;
  viewCount: number;
  uploadedAt: string | null;
}

export interface VeewerModelList {
  items: VeewerModel[];
  nextCursor: string | null;
}

export interface VeewerFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface VeewerEmbed {
  modelId: string;
  viewerUrl: string;
  shareUrl: string;
  iframeCode: string;
  arUrl: string | null;
}

export interface VeewerAccount {
  planName: string | null;
  isFree: boolean;
  totalCredit: number;
  availableCredit: number;
  usedCredit: number;
  usedStorage: string | null;
  totalStorage: string | null;
  usedStorageBytes: number;
  /** null means the quota could not be read, not that it is unlimited; 0 is a real zero. */
  totalStorageBytes: number | null;
  /** Credits one upload of each format costs; the list an agent divides availableCredit by. */
  creditCosts: VeewerCreditCost[];
}

export interface VeewerCreditCost {
  format: string;
  credits: number;
}
