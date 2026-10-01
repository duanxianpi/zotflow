import type { Plugin } from "obsidian";
import type { WorkerBridge } from "bridge";
import type { ParentHost } from "bridge/parent-host";

/** Vault localStorage key that turns the hooks on. */
export const TEST_HOOKS_FLAG = "zotflow-test-hooks";

/** What the live test harness reaches through `window.__zotflowTest`. */
export interface ZotFlowTestHooks {
    bridge: WorkerBridge;
    /**
     * The instance the worker sends every request through. Tests replace
     * its `request` method to drop answers or fail requests; nothing else
     * in the plugin does.
     */
    parentHost: ParentHost;
}

declare global {
    interface Window {
        __zotflowTest?: ZotFlowTestHooks;
    }
}

/**
 * Exposes the worker bridge to the live test harness (`npm run live:sync`).
 *
 * Off unless the vault's localStorage holds `zotflow-test-hooks = "1"`, which
 * only the harness sets, in its own isolated Obsidian profile. Removed when
 * the plugin unloads.
 */
export function installTestHooks(plugin: Plugin, hooks: ZotFlowTestHooks): void {
    if (plugin.app.loadLocalStorage(TEST_HOOKS_FLAG) !== "1") return;
    window.__zotflowTest = hooks;
    plugin.register(() => {
        delete window.__zotflowTest;
    });
}
