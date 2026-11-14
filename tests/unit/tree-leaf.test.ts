import { describe, expect, test, vi } from "vitest";
import type { View, Workspace, WorkspaceLeaf } from "obsidian";
import { restoreTreeLeaf } from "ui/tree-view/restore-leaf";

const type = "zotflow-tree-view";
const liveView = {} as View;
const isTreeView = (view: View) => view === liveView;

function leaf(kind: "live" | "unknown" | "deferred" | "empty") {
    let currentType = kind === "empty" ? "empty" : type;
    const target = {
        view: kind === "live" ? liveView : ({} as View),
        isDeferred: kind === "deferred",
        getViewState: () => ({ type: currentType, state: { saved: true } }),
        loadIfDeferred: vi.fn(async () => {
            target.isDeferred = false;
            target.view = liveView;
        }),
        setViewState: vi.fn(async (state: { type: string }) => {
            // Obsidian does not replace an UnknownView for a same-type state.
            if (state.type !== currentType) {
                target.view = state.type === type ? liveView : ({} as View);
            }
            currentType = state.type;
        }),
        detach: vi.fn(),
    };
    return target;
}

function workspace(leaves: ReturnType<typeof leaf>[]) {
    const created = leaf("empty");
    return {
        created,
        iterateAllLeaves: (visit: (leaf: WorkspaceLeaf) => void) => {
            for (const entry of leaves)
                visit(entry as unknown as WorkspaceLeaf);
        },
        getLeftLeaf: vi.fn(() => created),
    };
}

async function restore(w: ReturnType<typeof workspace>) {
    return restoreTreeLeaf(w as unknown as Workspace, type, isTreeView);
}

describe("tree sidebar restoration", () => {
    test("repairs an unknown saved tab in place and removes old ghosts", async () => {
        const saved = leaf("unknown");
        const duplicate = leaf("unknown");
        const w = workspace([saved, duplicate]);
        expect(await restore(w)).toBe(saved);
        expect(saved.view).toBe(liveView);
        expect(saved.setViewState.mock.calls).toEqual([
            [{ type: "empty" }],
            [{ type, state: { saved: true } }],
        ]);
        expect(duplicate.detach).toHaveBeenCalledOnce();
        expect(w.getLeftLeaf).not.toHaveBeenCalled();
    });

    test("loads a deferred tab without creating or resetting it", async () => {
        const saved = leaf("deferred");
        const w = workspace([saved]);
        await restore(w);
        expect(saved.loadIfDeferred).toHaveBeenCalledOnce();
        expect(saved.setViewState).not.toHaveBeenCalled();
        expect(w.getLeftLeaf).not.toHaveBeenCalled();
    });

    test("keeps the working tree rather than an earlier ghost", async () => {
        const ghost = leaf("unknown");
        const live = leaf("live");
        const w = workspace([ghost, live]);
        expect(await restore(w)).toBe(live);
        expect(ghost.detach).toHaveBeenCalledOnce();
        expect(live.setViewState).not.toHaveBeenCalled();
        expect(live.detach).not.toHaveBeenCalled();
    });

    test("creates a tree only when no saved tree exists", async () => {
        const w = workspace([leaf("empty")]);
        expect(await restore(w)).toBe(w.created);
        expect(w.getLeftLeaf).toHaveBeenCalledOnce();
        expect(w.created.view).toBe(liveView);
    });

    test("keeps old tabs if opening the replacement fails", async () => {
        const saved = leaf("unknown");
        const duplicate = leaf("unknown");
        saved.setViewState.mockRejectedValueOnce(new Error("open failed"));
        await expect(restore(workspace([saved, duplicate]))).rejects.toThrow(
            "open failed",
        );
        expect(duplicate.detach).not.toHaveBeenCalled();
    });
});
