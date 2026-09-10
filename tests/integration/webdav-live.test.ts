/**
 * Opt-in end-to-end check against a real WebDAV endpoint.
 *
 * Example for the native WSL Apache fixture:
 * ZF_WEBDAV_E2E_URL=http://<wsl-ip>:1900/dav/zotero
 * ZF_WEBDAV_E2E_USER=zotflow
 * ZF_WEBDAV_E2E_PASSWORD=zotflow-test
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "settings/types";
import { WebDavService } from "worker/services/webdav";

import { createFakeParentHost } from "../fakes/parent-host";

const url = process.env.ZF_WEBDAV_E2E_URL ?? "";
const user = process.env.ZF_WEBDAV_E2E_USER ?? "";
const password = process.env.ZF_WEBDAV_E2E_PASSWORD ?? "";
const enabled = Boolean(url && user && password);

describe.skipIf(!enabled)("WebDAV live endpoint", () => {
    const host = createFakeParentHost();
    const service = new WebDavService(
        {
            ...DEFAULT_SETTINGS,
            webDavUrl: url,
            webDavUser: user,
            webdavpassword: password,
        },
        host,
    );

    it("verifies, probes, and downloads through the shared auth session", async () => {
        await expect(service.verify(url, user, password)).resolves.toBe(true);
        await expect(service.getContentLength("live-test.bin")).resolves.toBe(
            19,
        );

        // The WSL fixture uses AuthDigestNonceLifetime 10. The next request
        // must recover from Apache's 401 stale=true with a fresh challenge.
        await new Promise((resolve) => setTimeout(resolve, 11_000));

        const payload = await service.downloadFile("live-test.bin");
        expect(new TextDecoder().decode(payload)).toBe("zotflow-digest-live");
        expect(
            host.logs.some(
                (entry) =>
                    entry.message === "WebDAV Digest challenge adopted." &&
                    (entry.details as { stale?: boolean }).stale === true,
            ),
        ).toBe(true);
    }, 20_000);
});
