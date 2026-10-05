import type { TemplatePreviewResult } from "types/template-preview";

/** The output of a preview expected to succeed; a template error fails the test with its message. */
export async function previewOutput(
    result: Promise<TemplatePreviewResult>,
): Promise<string> {
    const r = await result;
    if (!r.ok) {
        throw new Error(
            `Preview failed (${r.error.phase}, line ${r.error.line ?? "?"}): ${r.error.message}`,
        );
    }
    return r.output;
}
