import { expect, it } from "vitest";
import { SyncService } from "worker/services/sync";
import { ZoteroAPIService } from "worker/services/zotero";
import { LibraryService } from "worker/services/library";
import { DEFAULT_SETTINGS } from "settings/types";
import {
    normalizeAnnotationSettings,
    resolveAnnotationMeaning,
} from "utils/annotation-profiles";
import {
    createAnnotationHarness,
    makeAnnotationJson,
    API_KEY,
    USER_ID,
} from "../fakes/annotation-harness";
import { createFakeZoteroServer } from "../fakes/zotero-server";

it("category tags and arbitrary colors use the existing Zotero HTTP round trip", async () => {
    const h = await createAnnotationHarness();
    const attachment = await h.seedAttachment("ATTACH01");
    const server = createFakeZoteroServer({ apiKey: API_KEY, userID: USER_ID });
    server.install();
    try {
        const library = server.library(USER_ID);
        library.addItem({ key: "PAPER001" });
        library.addItem({
            key: "ATTACH01",
            data: {
                itemType: "attachment",
                parentItem: "PAPER001",
                contentType: "application/pdf",
                linkMode: "imported_file",
                filename: "paper.pdf",
            },
        });
        const settings = {
            ...DEFAULT_SETTINGS,
            zoteroapikey: API_KEY,
            librariesConfig: { [USER_ID]: { mode: "bidirectional" as const } },
        };
        const sync = new SyncService(
            new ZoteroAPIService(API_KEY),
            settings,
            h.host,
            new LibraryService(settings, h.host),
            { sleep: () => Promise.resolve() },
        );
        await sync.startSync();
        const annotation = makeAnnotationJson("ANNOTAT1", {
            color: "#123456",
            tags: [{ name: "Methodology" }, { name: "unrelated" }],
        });
        await h.service.saveAnnotations(attachment, h.keyInfo, [annotation]);
        server.clearRequests();
        await sync.startSync();
        const posted = server.requests
            .filter((r) => r.method === "POST")
            .flatMap((r) => r.body as Array<Record<string, unknown>>)
            .find((r) => r.key === "ANNOTAT1")!;
        expect(posted).toMatchObject({
            annotationColor: "#123456",
            tags: [{ tag: "Methodology" }, { tag: "unrelated" }],
        });
        expect(
            Object.keys(posted).some((key) =>
                /profile|category|resolved|palette/i.test(key),
            ),
        ).toBe(false);
        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toMatchObject({
            color: "#123456",
            tags: [{ name: "Methodology" }, { name: "unrelated" }],
        });
        const deletedProfileSettings = normalizeAnnotationSettings({
            annotationCategoryTags: ["Methodology"],
        });
        expect(
            resolveAnnotationMeaning(back!, deletedProfileSettings)
                .resolvedLabel,
        ).toBe("Methodology");
        expect((await h.getRow("ANNOTAT1"))!.syncStatus).toBe("synced");
    } finally {
        server.restore();
    }
});
