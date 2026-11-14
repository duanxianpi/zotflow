import type { View, Workspace, WorkspaceLeaf } from "obsidian";

/** Restore saved placeholders as well as live views after a plugin reload. */
export async function restoreTreeLeaf(
    workspace: Workspace,
    viewType: string,
    isTreeView: (view: View) => boolean,
): Promise<WorkspaceLeaf | null> {
    const leaves: WorkspaceLeaf[] = [];
    workspace.iterateAllLeaves((leaf) => {
        // An unavailable plugin view can report a different runtime type while
        // retaining its original type in the persisted workspace state.
        if (leaf.getViewState().type === viewType) leaves.push(leaf);
    });
    const leaf =
        leaves.find((candidate) => isTreeView(candidate.view)) ??
        leaves[0] ??
        workspace.getLeftLeaf(false);
    if (!leaf) return null;

    if (leaf.isDeferred) await leaf.loadIfDeferred();
    if (!isTreeView(leaf.view)) {
        const saved = leaf.getViewState();
        // setViewState with the same type leaves an UnknownView in place.
        // Switch away first so Obsidian invokes the registered view factory.
        await leaf.setViewState({ type: "empty" });
        await leaf.setViewState({
            type: viewType,
            state: saved.type === viewType ? saved.state : {},
        });
    }
    // Remove accumulated placeholders only after the replacement opens.
    for (const duplicate of leaves) {
        if (duplicate !== leaf) duplicate.detach();
    }
    return leaf;
}
