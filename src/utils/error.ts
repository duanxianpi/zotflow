/**
 * Error Code Enum
 */
export enum ZotFlowErrorCode {
    NETWORK_ERROR = "NETWORK_ERROR",
    AUTH_INVALID = "AUTH_INVALID",
    CONFIG_MISSING = "CONFIG_MISSING",
    API_LIMIT = "API_LIMIT",
    RESOURCE_MISSING = "RESOURCE_MISSING",
    INVALID_ITEM = "INVALID_ITEM",
    ATTACHMENT_TOO_LARGE = "ATTACHMENT_TOO_LARGE",
    DB_WRITE_FAILED = "DB_WRITE_FAILED",
    DB_OPEN_FAILED = "DB_OPEN_FAILED",
    FILE_WRITE_FAILED = "FILE_WRITE_FAILED",
    FILE_OPEN_FAILED = "FILE_OPEN_FAILED",
    PARSE_ERROR = "PARSE_ERROR",
    TIMEOUT = "TIMEOUT",
    UNKNOWN = "UNKNOWN",
    TEMPLATE_RENDER_ERROR = "TEMPLATE_RENDER_ERROR",
}

/**
 * Best-effort human-readable text for a value caught by `catch`.
 *
 * A `catch` binding is `unknown`, and `throw` accepts anything — so reaching
 * straight for `.message` is only correct for the values that happen to be
 * `Error`s. For anything else this falls back to `String()`, which at least
 * prints the value instead of the word "undefined".
 */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * HTTP status carried by a rejection from the Zotero API client, which types
 * its errors as `any`. Falls back to a top-level `code`, then to 0 — callers
 * compare against specific statuses (401/403/412), so a non-numeric transport
 * code has to read as "no HTTP status" rather than match one.
 */
export function errorStatus(error: unknown): number {
    const e = error as { response?: { status?: unknown }; code?: unknown };
    const status = e?.response?.status ?? e?.code;
    return typeof status === "number" ? status : 0;
}

/**
 * Structured detail attached to an error. Every call site passes an object
 * literal — `{ api_key }`, `{ cause, path }` — and `wrap` spreads it, so this
 * is deliberately an object type rather than `unknown`.
 */
export type ErrorData = Record<string, unknown>;

/**
 * Error Object Interface
 */
export interface IZotFlowError {
    code: ZotFlowErrorCode;
    context: string;
    message: string;
    data?: ErrorData;
}

/**
 * ZotFlow Custom Error Class
 */
export class ZotFlowError extends Error implements IZotFlowError {
    public code: ZotFlowErrorCode;
    public context: string;
    public data?: ErrorData;

    constructor(
        code: ZotFlowErrorCode,
        context: string,
        message: string,
        data?: ErrorData,
    ) {
        super(message);
        this.name = "ZotFlowError";
        this.code = code;
        this.context = context;
        this.data = data;

        Object.setPrototypeOf(this, ZotFlowError.prototype);
    }

    /**
     * Static helper method: Determine if an arbitrary error object is a ZotFlowError
     */
    static isZotFlowError(error: unknown): error is IZotFlowError {
        if (typeof error !== "object" || error === null || !("code" in error)) {
            return false;
        }
        // Widened rather than asserted to `ZotFlowErrorCode`: the whole point
        // of the check is that we do not yet know the property is one.
        const codes: unknown[] = Object.values(ZotFlowErrorCode);
        return codes.includes(error.code);
    }

    /**
     * Wrap an arbitrary error into a ZotFlowError
     */
    static wrap(
        error: unknown,
        code: ZotFlowErrorCode,
        context: string,
        message: string,
        data?: ErrorData,
    ): ZotFlowError {
        if (error instanceof ZotFlowError) {
            return error;
        }

        const fullMessage = `${message}: ${errorMessage(error)}`;

        return new ZotFlowError(code, context, fullMessage, {
            cause: error,
            ...data,
        });
    }
}
