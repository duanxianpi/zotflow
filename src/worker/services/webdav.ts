import SparkMD5 from "spark-md5";

import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { proxiedFetch } from "worker/proxied-fetch";

interface WebDavCredentials {
    user: string;
    password: string;
}

interface DigestChallenge {
    realm: string;
    nonce: string;
    qop: "auth" | null;
    opaque: string | null;
    algorithm: "MD5" | "MD5-sess";
    stale: boolean;
    origin: string;
}

interface DigestChallengeInfo {
    realm: string;
    qop: "auth" | null;
    algorithm: "MD5" | "MD5-sess";
    stale: boolean;
}

type ChallengeListener = (challenge: DigestChallengeInfo) => void;

/** Split an HTTP authentication header without splitting commas inside quotes. */
function splitHeaderFields(header: string): string[] {
    const fields: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;

    for (let index = 0; index < header.length; index++) {
        const character = header[index]!;
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quoted && character === "\\") {
            escaped = true;
            continue;
        }
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && character === ",") {
            fields.push(header.slice(start, index).trim());
            start = index + 1;
        }
    }
    fields.push(header.slice(start).trim());
    return fields.filter(Boolean);
}

function parseParameters(fields: string[]): Map<string, string> {
    const parameters = new Map<string, string>();
    const parameterPattern =
        /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|(.+))$/;

    for (const field of fields) {
        const match = parameterPattern.exec(field);
        const name = match?.[1];
        const rawValue = match?.[2] ?? match?.[3];
        if (!name || rawValue === undefined) continue;
        parameters.set(
            name.toLowerCase(),
            rawValue.replace(/\\(["\\])/g, "$1").trim(),
        );
    }
    return parameters;
}

/** Return the first Digest challenge this client can answer. */
function parseDigestChallenge(
    header: string | null,
    url: string,
): DigestChallenge | null {
    if (!header) return null;

    const digestGroups: string[][] = [];
    let current: string[] | null = null;

    for (const field of splitHeaderFields(header)) {
        const scheme = /^([!#$%&'*+.^_`|~\w-]+)\s+(.+)$/.exec(field);
        if (scheme) {
            if (current) digestGroups.push(current);
            current =
                scheme[1]!.toLowerCase() === "digest" ? [scheme[2]!] : null;
        } else if (current) {
            current.push(field);
        }
    }
    if (current) digestGroups.push(current);

    for (const fields of digestGroups) {
        const parameters = parseParameters(fields);
        const realm = parameters.get("realm");
        const nonce = parameters.get("nonce");
        if (!realm || !nonce) continue;

        const rawAlgorithm = parameters.get("algorithm")?.toLowerCase();
        let algorithm: DigestChallenge["algorithm"];
        if (!rawAlgorithm || rawAlgorithm === "md5") {
            algorithm = "MD5";
        } else if (rawAlgorithm === "md5-sess") {
            algorithm = "MD5-sess";
        } else {
            continue;
        }

        const rawQop = parameters.get("qop");
        const qopOptions = rawQop
            ?.split(",")
            .map((option) => option.trim().toLowerCase());
        if (qopOptions && !qopOptions.includes("auth")) continue;

        return {
            realm,
            nonce,
            qop: qopOptions ? "auth" : null,
            opaque: parameters.get("opaque") ?? null,
            algorithm,
            stale: parameters.get("stale")?.toLowerCase() === "true",
            origin: new URL(url).origin,
        };
    }
    return null;
}

function escapeQuoted(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
}

function createCnonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

function basicAuthorization(credentials: WebDavCredentials): string {
    const bytes = new TextEncoder().encode(
        `${credentials.user}:${credentials.password}`,
    );
    return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

function requestHeaders(headers?: HeadersInit): Record<string, string> {
    if (!headers) return {};
    if (headers instanceof Headers) {
        const record: Record<string, string> = {};
        headers.forEach((value, name) => {
            record[name] = value;
        });
        return record;
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return { ...headers };
}

/**
 * Authentication state shared by requests to one configured WebDAV endpoint.
 *
 * Digest nonces are opaque and have no client-side TTL. A cached challenge is
 * reused until the server answers 401 with a replacement, at which point the
 * nonce count is reset and that request is retried exactly once.
 */
class WebDavAuthSession {
    private challenge: DigestChallenge | null = null;
    private nonceCount = 0;

    constructor(private readonly onChallenge?: ChallengeListener) {}

    reset(): void {
        this.challenge = null;
        this.nonceCount = 0;
    }

    async request(
        url: string,
        init: RequestInit,
        credentials: WebDavCredentials,
    ): Promise<Response> {
        let retriedAuthentication = false;

        while (true) {
            const headers = requestHeaders(init.headers);
            for (const name of Object.keys(headers)) {
                if (name.toLowerCase() === "authorization") {
                    delete headers[name];
                }
            }
            headers.Authorization = this.authorization(
                init.method ?? "GET",
                url,
                credentials,
            );

            const response = await proxiedFetch(url, { ...init, headers });
            if (response.status !== 401 || retriedAuthentication) {
                return response;
            }

            const challenge = parseDigestChallenge(
                response.headers.get("www-authenticate"),
                url,
            );
            if (!challenge) return response;

            this.challenge = challenge;
            this.nonceCount = 0;
            retriedAuthentication = true;
            this.onChallenge?.({
                realm: challenge.realm,
                qop: challenge.qop,
                algorithm: challenge.algorithm,
                stale: challenge.stale,
            });
        }
    }

    private authorization(
        method: string,
        url: string,
        credentials: WebDavCredentials,
    ): string {
        const challenge = this.challenge;
        if (!challenge || challenge.origin !== new URL(url).origin) {
            return basicAuthorization(credentials);
        }

        const uri = new URL(url);
        const digestUri = `${uri.pathname}${uri.search}`;
        const nonceCount = (++this.nonceCount).toString(16).padStart(8, "0");
        const cnonce = createCnonce();
        const baseHa1 = SparkMD5.hash(
            `${credentials.user}:${challenge.realm}:${credentials.password}`,
        );
        const ha1 =
            challenge.algorithm === "MD5-sess"
                ? SparkMD5.hash(`${baseHa1}:${challenge.nonce}:${cnonce}`)
                : baseHa1;
        const ha2 = SparkMD5.hash(`${method.toUpperCase()}:${digestUri}`);
        const response = challenge.qop
            ? SparkMD5.hash(
                  `${ha1}:${challenge.nonce}:${nonceCount}:${cnonce}:${challenge.qop}:${ha2}`,
              )
            : SparkMD5.hash(`${ha1}:${challenge.nonce}:${ha2}`);

        const parts = [
            `username="${escapeQuoted(credentials.user)}"`,
            `realm="${escapeQuoted(challenge.realm)}"`,
            `nonce="${escapeQuoted(challenge.nonce)}"`,
            `uri="${escapeQuoted(digestUri)}"`,
            `response="${response}"`,
            `algorithm=${challenge.algorithm}`,
        ];
        if (challenge.opaque !== null) {
            parts.push(`opaque="${escapeQuoted(challenge.opaque)}"`);
        }
        if (challenge.qop) {
            parts.push(
                `qop=${challenge.qop}`,
                `nc=${nonceCount}`,
                `cnonce="${cnonce}"`,
            );
        } else if (challenge.algorithm === "MD5-sess") {
            parts.push(`cnonce="${cnonce}"`);
        }
        return `Digest ${parts.join(", ")}`;
    }
}

/** WebDAV file download service for fetching Zotero attachments from a user-configured server. */
export class WebDavService {
    private readonly authSession: WebDavAuthSession;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
    ) {
        this.authSession = this.createAuthSession();
    }

    updateSettings(settings: ZotFlowSettings) {
        if (
            settings.webDavUrl !== this.settings.webDavUrl ||
            settings.webDavUser !== this.settings.webDavUser ||
            settings.webdavpassword !== this.settings.webdavpassword
        ) {
            this.authSession.reset();
        }
        this.settings = settings;
    }

    private createAuthSession(): WebDavAuthSession {
        return new WebDavAuthSession((challenge) => {
            this.logDigestChallenge(challenge);
        });
    }

    private logDigestChallenge(challenge: DigestChallengeInfo): void {
        this.parentHost.log(
            "debug",
            "WebDAV Digest challenge adopted.",
            "WebDavService",
            challenge,
        );
    }

    /**
     * Download a file from WebDAV.
     * @param remotePath Relative path to the file on the WebDAV server.
     * @returns The file content as an ArrayBuffer.
     */
    async downloadFile(remotePath: string): Promise<ArrayBuffer> {
        const startedAt = Date.now();
        this.parentHost.log(
            "debug",
            "WebDAV download requested.",
            "WebDavService",
            {
                remotePath,
                hasUrl: !!this.settings.webDavUrl,
                hasUser: !!this.settings.webDavUser,
                hasPassword: !!this.settings.webdavpassword,
            },
        );

        if (
            !this.settings.webDavUrl ||
            !this.settings.webDavUser ||
            !this.settings.webdavpassword
        ) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "WebDavService",
                "WebDAV credentials not configured",
            );
        }

        // Make sure the webdav url ends with a slash (Business logic preserved)
        let baseUrl = this.settings.webDavUrl;
        if (!baseUrl.endsWith("/")) {
            baseUrl += "/";
        }
        const fullUrl = baseUrl + remotePath.replace(/^\//, ""); // Ensure single slash join
        this.parentHost.log("debug", "WebDAV URL resolved.", "WebDavService", {
            baseUrl,
            fullUrl,
        });

        const credentials: WebDavCredentials = {
            user: this.settings.webDavUser,
            password: this.settings.webdavpassword,
        };

        try {
            const req = { method: "GET" };

            this.parentHost.log(
                "debug",
                "WebDAV fetch dispatching.",
                "WebDavService",
                {
                    method: req.method,
                    fullUrl,
                },
            );

            const response = await this.authSession.request(
                fullUrl,
                req,
                credentials,
            );
            const responseMs = Date.now() - startedAt;
            this.parentHost.log(
                "debug",
                "WebDAV fetch completed.",
                "WebDavService",
                {
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    elapsedMs: responseMs,
                },
            );

            if (response.ok) {
                const payload = await response.arrayBuffer();
                this.parentHost.log(
                    "debug",
                    "WebDAV payload received.",
                    "WebDavService",
                    {
                        bytes: payload.byteLength,
                        elapsedMs: Date.now() - startedAt,
                    },
                );
                return payload;
            } else {
                // Map HTTP status to ZotFlowError
                if (response.status === 401 || response.status === 403) {
                    this.parentHost.log(
                        "debug",
                        "WebDAV auth rejection received.",
                        "WebDavService",
                        {
                            status: response.status,
                            fullUrl,
                        },
                    );
                    throw new ZotFlowError(
                        ZotFlowErrorCode.AUTH_INVALID,
                        "WebDavService",
                        `WebDAV Auth Failed: ${response.status}`,
                    );
                }
                if (response.status === 404) {
                    this.parentHost.log(
                        "debug",
                        "WebDAV resource not found.",
                        "WebDavService",
                        {
                            status: response.status,
                            fullUrl,
                        },
                    );
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "WebDavService",
                        `WebDAV File Not Found: ${fullUrl}`,
                    );
                }

                this.parentHost.log(
                    "debug",
                    "WebDAV returned unexpected non-success status.",
                    "WebDavService",
                    {
                        status: response.status,
                        statusText: response.statusText,
                        fullUrl,
                    },
                );

                throw new ZotFlowError(
                    ZotFlowErrorCode.NETWORK_ERROR,
                    "WebDavService",
                    `WebDAV download failed with status: ${response.status}`,
                );
            }
        } catch (e) {
            this.parentHost.log(
                "debug",
                "WebDAV download raised exception.",
                "WebDavService",
                {
                    remotePath,
                    fullUrl,
                    elapsedMs: Date.now() - startedAt,
                    errorMessage: e instanceof Error ? e.message : String(e),
                },
            );
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "WebDavService",
                "WebDAV download failed",
            );
        }
    }

    /**
     * Fetch the byte size of a remote WebDAV file via a HEAD request.
     *
     * Used on mobile (Android) to decide whether a payload is small enough to
     * download safely — Obsidian Android's `requestUrl` loads the whole body
     * into memory and can OOM/crash on large files.
     *
     * @param remotePath Relative path to the file on the WebDAV server.
     * @returns The Content-Length in bytes, or `null` if the server did not
     *          report it.
     */
    async getContentLength(remotePath: string): Promise<number | null> {
        if (
            !this.settings.webDavUrl ||
            !this.settings.webDavUser ||
            !this.settings.webdavpassword
        ) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "WebDavService",
                "WebDAV credentials not configured",
            );
        }

        let baseUrl = this.settings.webDavUrl;
        if (!baseUrl.endsWith("/")) {
            baseUrl += "/";
        }
        const fullUrl = baseUrl + remotePath.replace(/^\//, "");

        const credentials: WebDavCredentials = {
            user: this.settings.webDavUser,
            password: this.settings.webdavpassword,
        };

        try {
            const response = await this.authSession.request(
                fullUrl,
                { method: "HEAD" },
                credentials,
            );

            if (!response.ok) {
                this.parentHost.log(
                    "debug",
                    "WebDAV HEAD returned non-success status.",
                    "WebDavService",
                    {
                        status: response.status,
                        fullUrl,
                    },
                );
                if (response.status === 401 || response.status === 403) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.AUTH_INVALID,
                        "WebDavService",
                        `WebDAV Auth Failed: ${response.status}`,
                    );
                }
                throw new ZotFlowError(
                    ZotFlowErrorCode.NETWORK_ERROR,
                    "WebDavService",
                    `WebDAV HEAD failed with status: ${response.status}`,
                );
            }

            const raw = response.headers.get("content-length");
            const bytes = raw ? Number.parseInt(raw, 10) : NaN;
            if (!Number.isFinite(bytes)) {
                this.parentHost.log(
                    "debug",
                    "WebDAV HEAD did not report a usable content-length.",
                    "WebDavService",
                    {
                        fullUrl,
                        rawContentLength: raw,
                    },
                );
                return null;
            }

            this.parentHost.log(
                "debug",
                "WebDAV HEAD content-length resolved.",
                "WebDavService",
                {
                    fullUrl,
                    bytes,
                },
            );
            return bytes;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "WebDavService",
                "WebDAV HEAD request failed",
            );
        }
    }

    async verify(url: string, user: string, pass: string): Promise<boolean> {
        if (!url || !user || !pass) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "WebDavService",
                "Missing WebDAV credentials for verification",
            );
        }

        const credentials: WebDavCredentials = { user, password: pass };
        const authSession = this.createAuthSession();

        try {
            const target = new URL(url);
            if (!target.pathname.endsWith("/")) {
                target.pathname += "/";
            }
            const targetUrl = target.toString();
            const req = {
                method: "PROPFIND",
                headers: {
                    Depth: "0", // Only check the root resource
                },
                throw: false,
            };

            const response = await authSession.request(
                targetUrl,
                req,
                credentials,
            );

            if (response.status >= 200 && response.status < 300) {
                return true;
            } else {
                if (response.status === 401 || response.status === 403) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.AUTH_INVALID,
                        "WebDavService",
                        "WebDAV Verification 401/403",
                    );
                }
                if (response.status === 404) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "WebDavService",
                        "WebDAV Verification 404",
                    );
                }

                throw new ZotFlowError(
                    ZotFlowErrorCode.NETWORK_ERROR,
                    "WebDavService",
                    `WebDAV verification failed with status: ${response.status}`,
                );
            }
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "WebDavService",
                "WebDAV Verification Network Error",
            );
        }
    }
}
