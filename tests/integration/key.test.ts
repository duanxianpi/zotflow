import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KeyService } from "worker/services/key";
import { ZoteroAPIService } from "worker/services/zotero";

import { db, resetDb } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import {
    createFakeZoteroServer,
    type FakeZoteroServer,
} from "../fakes/zotero-server";

const SAVED_KEY = "SAVED-KEY";
const CANDIDATE_KEY = "CANDIDATE-KEY";
const USER_ID = 42;

describe("KeyService", () => {
    let server: FakeZoteroServer;

    beforeEach(async () => {
        await resetDb();
        server = createFakeZoteroServer({
            apiKey: CANDIDATE_KEY,
            userID: USER_ID,
            username: "candidate-user",
            joinedGroups: [777],
        });
        server.install();
    });

    afterEach(() => {
        server.restore();
    });

    it("uses the candidate key for the complete verification flow without replacing the saved client", async () => {
        const zotero = new ZoteroAPIService(SAVED_KEY);
        const service = new KeyService(zotero, createFakeParentHost());

        const result = await service.verifyAndPersistKey(CANDIDATE_KEY);

        expect(result.username).toBe("candidate-user");
        expect(server.requestsFor("/keys/current")[0]?.headers.get("Zotero-API-Key"))
            .toBe(CANDIDATE_KEY);
        expect(server.requestsFor(`/users/${USER_ID}/groups`)[0]?.headers.get("Zotero-API-Key"))
            .toBe(CANDIDATE_KEY);
        expect(await db.keys.get(CANDIDATE_KEY)).toMatchObject({
            key: CANDIDATE_KEY,
            userID: USER_ID,
            joinedGroups: [777],
        });
        expect(await db.groups.get(777)).toMatchObject({
            id: 777,
            name: "Group 777",
        });

        server.clearRequests();
        await expect(zotero.getGroups(USER_ID)).rejects.toMatchObject({
            code: "AUTH_INVALID",
        });
        expect(server.requestsFor(`/users/${USER_ID}/groups`)[0]?.headers.get("Zotero-API-Key"))
            .toBe(SAVED_KEY);
    });

    it("does not persist key metadata when group discovery fails", async () => {
        const zotero = new ZoteroAPIService(SAVED_KEY);
        const service = new KeyService(zotero, createFakeParentHost());
        server.failNext({ status: 500, pathIncludes: "/groups" });

        await expect(
            service.verifyAndPersistKey(CANDIDATE_KEY),
        ).rejects.toMatchObject({ code: "NETWORK_ERROR" });

        expect(await db.keys.count()).toBe(0);
        expect(await db.groups.count()).toBe(0);
        expect(await db.libraries.count()).toBe(0);
    });
});
