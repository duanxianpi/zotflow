import { AnnotationProfilesModal } from "ui/modals/annotation-profiles-modal";
import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

export class AnnotationProfilesSection {
    constructor(
        private plugin: ZotFlow,
        private refresh: () => void,
    ) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                name: "Default annotation profile",
                desc: "Used by new readers and source-note color labels. Switching inside a reader is temporary and affects only that reader.",
                control: {
                    type: "dropdown",
                    key: "defaultAnnotationProfileId",
                    options: Object.fromEntries(
                        this.plugin.settings.annotationProfiles.map((p) => [
                            p.id,
                            p.name,
                        ]),
                    ),
                },
            },
            {
                name: "Annotation profiles",
                desc: "Create, rename, duplicate, and delete profiles; edit and order their colors and labels.",
                render: (setting) => {
                    setting.addButton((button) =>
                        button.setButtonText("Manage profiles").onClick(() => {
                            new AnnotationProfilesModal(
                                this.plugin,
                                this.refresh,
                            ).open();
                        }),
                    );
                },
            },
            {
                name: "Automatically tag new annotations",
                desc: "Add the selected color’s label as an ordinary tag on creation. Matching current or former labels count as categories, even when added manually. Existing tags are preserved; profile edits never retag annotations.",
                control: { type: "toggle", key: "autoTagAnnotations" },
            },
        ];
    }
}
