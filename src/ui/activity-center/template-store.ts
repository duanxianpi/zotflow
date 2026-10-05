import { workerBridge } from "bridge";
import { services } from "services/services";
import { readTextFile, saveTextFile } from "utils/file";
import {
    citationFormat,
    isCitationContext,
    settingValue,
    TEMPLATE_TARGETS,
} from "ui/activity-center/template-targets";

import type {
    SavedTemplate,
    TemplateContext,
    WriteBackPlan,
} from "ui/activity-center/template-targets";

/** The built-in template a context falls back to while nothing is saved. */
async function builtInTemplate(context: TemplateContext): Promise<string> {
    if (isCitationContext(context)) {
        return workerBridge.libraryTemplate.getFallbackCitationTemplate(
            citationFormat(context),
        );
    }
    switch (context) {
        case "library":
            return workerBridge.libraryTemplate.getBuiltInTemplate();
        case "local":
            return workerBridge.localTemplate.getBuiltInTemplate();
        case "library-path":
            return workerBridge.notePath.getBuiltInPathTemplate("library");
        case "local-path":
            return workerBridge.notePath.getBuiltInPathTemplate("local");
        case "display-title":
            return "";
    }
}

/** Load what is saved for `context`: the setting, or the template file's content. */
export async function loadSavedTemplate(
    context: TemplateContext,
): Promise<SavedTemplate> {
    const target = TEMPLATE_TARGETS[context];
    const value = settingValue(services.settings, target);
    const builtIn = await builtInTemplate(context);
    if (target.kind === "setting") {
        return { context, stored: value, filePath: "", builtIn };
    }
    const filePath = value.trim();
    let stored: string | null = null;
    if (filePath) {
        try {
            stored = await readTextFile(services.app, filePath);
        } catch (e) {
            services.logService.warn(
                `Could not read template file ${filePath}`,
                "TemplateTestView",
                e,
            );
        }
    }
    return { context, stored, filePath, builtIn };
}

/** Carry out a write-back. Throws on failure; the caller reports it. */
export async function applyWriteBack(plan: WriteBackPlan): Promise<void> {
    const settings = services.plugin.settings;
    if (plan.kind === "setting") {
        settings[plan.key] = plan.value;
    } else {
        await saveTextFile(services.app, plan.path, plan.content);
        if (!plan.setsPath) return;
        settings[plan.setsPath] = plan.path;
    }
    await services.saveSettings();
    services.plugin.refreshSettingTab();
}
