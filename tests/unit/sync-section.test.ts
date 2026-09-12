import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    verifyAndPersistKey: vi.fn(),
    getKeyInfo: vi.fn(),
    notify: vi.fn(),
    logError: vi.fn(),
}));

vi.mock("bridge", () => ({
    workerBridge: {
        key: {
            verifyAndPersistKey: mocks.verifyAndPersistKey,
            getKeyInfo: mocks.getKeyInfo,
        },
    },
}));

vi.mock("services/services", () => ({
    services: {
        notificationService: { notify: mocks.notify },
        logService: {
            error: mocks.logError,
            warn: vi.fn(),
        },
    },
}));

vi.mock("obsidian", () => ({
    ButtonComponent: class {},
    setIcon: vi.fn(),
}));

import { SyncSection } from "settings/sections/sync-section";
import { DEFAULT_SETTINGS } from "settings/types";

import type ZotFlow from "main";
import type { ButtonComponent } from "obsidian";

interface SyncSectionInternals {
    apiKeyDraft: string | undefined;
    handleVerifyOrRefresh(
        button: ButtonComponent,
        mode: "verify" | "refresh",
    ): Promise<void>;
}

function createButton(): ButtonComponent {
    const button = {
        buttonEl: { innerText: "Verify Key" },
        setButtonText: vi.fn(),
        setDisabled: vi.fn(),
    };
    return button as unknown as ButtonComponent;
}

describe("SyncSection API key draft", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getKeyInfo.mockResolvedValue(undefined);
    });

    it("does not put the candidate key in settings until verification finishes", async () => {
        let resolveVerification: (
            value: { username: string },
        ) => void = () => undefined;
        mocks.verifyAndPersistKey.mockReturnValue(
            new Promise((resolve) => {
                resolveVerification = resolve;
            }),
        );
        const settings = {
            ...DEFAULT_SETTINGS,
            librariesConfig: {},
            zoteroapikey: "",
        };
        const saveSettings = vi.fn(async () => undefined);
        const plugin = { settings, saveSettings } as unknown as ZotFlow;
        const section = new SyncSection(plugin, vi.fn());
        const internals = section as unknown as SyncSectionInternals;
        internals.apiKeyDraft = "CANDIDATE-KEY";

        const verification = internals.handleVerifyOrRefresh(
            createButton(),
            "verify",
        );

        expect(settings.zoteroapikey).toBe("");
        expect(saveSettings).not.toHaveBeenCalled();

        resolveVerification({ username: "candidate-user" });
        await verification;

        expect(mocks.verifyAndPersistKey).toHaveBeenCalledWith(
            "CANDIDATE-KEY",
        );
        expect(settings.zoteroapikey).toBe("CANDIDATE-KEY");
        expect(saveSettings).toHaveBeenCalledOnce();
    });

    it("keeps a rejected candidate out of settings", async () => {
        mocks.verifyAndPersistKey.mockRejectedValue(new Error("invalid key"));
        const settings = {
            ...DEFAULT_SETTINGS,
            librariesConfig: {},
            zoteroapikey: "",
        };
        const saveSettings = vi.fn(async () => undefined);
        const plugin = { settings, saveSettings } as unknown as ZotFlow;
        const section = new SyncSection(plugin, vi.fn());
        const internals = section as unknown as SyncSectionInternals;
        internals.apiKeyDraft = "INVALID-KEY";

        await internals.handleVerifyOrRefresh(createButton(), "verify");

        expect(settings.zoteroapikey).toBe("");
        expect(saveSettings).not.toHaveBeenCalled();
    });
});
