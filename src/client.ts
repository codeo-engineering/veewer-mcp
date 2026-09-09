/**
 * VEEWER public API'sinin ince istemcisi (23002-1120).
 *
 * Burada is mantigi YOK: sunucu ne donuyorsa o iletiliyor. Bir kural iki yerde durursa
 * (backend ve burada) er ya da gec ayrisir ve MCP kullanicisi web arayuzunden farkli bir
 * cevap gorur.
 */

const DEFAULT_BASE_URL = "https://server.veewer.com/api/v1/public";

export class VeewerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VeewerApiError";
  }
}

export interface VeewerClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class VeewerClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: VeewerClientOptions) {
    this.apiKey = options.apiKey;
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

    const response = await fetch(url, {
      headers: {
        "x-api-key": this.apiKey,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      // Sunucunun mesaji varsa o gosteriliyor: "401" demek yerine "anahtar iptal edilmis"
      // demek, kullaniciyi dogru yere gonderen tek sey.
      const body = await response.text();
      let message = body;

      try {
        const parsed = JSON.parse(body);
        message = parsed?.message ?? body;
      } catch {
        // Govde JSON degilse ham metin kullanilir.
      }

      if (response.status === 429) {
        message = "Rate limit reached for this API key. Wait a minute and try again.";
      }

      throw new VeewerApiError(message || `Request failed with status ${response.status}`, response.status);
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
}
