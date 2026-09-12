import api from "zotero-api-client";
import { errorStatus, ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { ZoteroGroup, ZoteroKey } from "types/zotero";
import type { ApiChain } from "zotero-api-client";

type ApiFactory = typeof api;

const createApiClient: ApiFactory =
    typeof api === "function"
        ? api
        : (api as unknown as { default: ApiFactory }).default;

/** Wrapper around `zotero-api-client` for Zotero Web API communication. */
export class ZoteroAPIService {
    private _client: ApiChain;

    constructor(apiKey?: string) {
        if (apiKey) {
            this._client = createApiClient(apiKey);
        } else {
            // Placeholder, expected to be updated via updateCredentials
            this._client = createApiClient("");
        }
    }

    updateCredentials(apiKey: string) {
        this._client = createApiClient(apiKey);
    }

    /**
     * Validate the API key and return key details.
     * This ensures the key is valid and retrieves the associated user ID and permissions.
     */
    async verifyKey(apiKey: string): Promise<ZoteroKey> {
        if (!apiKey) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "ZoteroAPIService",
                "API Key is required for verification",
            );
        }

        try {
            const response = await createApiClient(apiKey)
                .verifyKeyAccess()
                .get();
            return response.getData() as ZoteroKey;
        } catch (e) {
            const status = errorStatus(e);

            if (status === 403 || status === 401) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.AUTH_INVALID,
                    "ZoteroAPIService",
                    `Key verification failed: ${status}`,
                    { api_key: apiKey },
                );
            }
            if (status === 429) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.API_LIMIT,
                    "ZoteroAPIService",
                    "Rate limit exceeded during verification",
                );
            }

            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "ZoteroAPIService",
                "Verification failed",
                { api_key: apiKey },
            );
        }
    }

    /**
     * Fetch User Groups
     */
    async getGroups(
        userID: number,
        apiKey?: string,
    ): Promise<ZoteroGroup[]> {
        try {
            const client =
                apiKey === undefined ? this._client : createApiClient(apiKey);
            const response = await client
                .library("user", userID)
                .groups()
                .get();
            return response.getData() as ZoteroGroup[];
        } catch (e) {
            const status = errorStatus(e);
            if (status === 403 || status === 401) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.AUTH_INVALID,
                    "ZoteroAPIService",
                    `Fetch Groups 403: Invalid Permissions`,
                );
            }

            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.NETWORK_ERROR,
                "ZoteroAPIService",
                "Failed to fetch groups",
            );
        }
    }

    /**
     * Get the API client instance.
     * This is used to make API requests to Zotero.
     */
    public get client() {
        return this._client;
    }
}
