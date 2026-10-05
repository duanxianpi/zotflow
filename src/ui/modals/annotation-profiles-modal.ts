import { Modal, Setting } from "obsidian";
import { services } from "services/services";
import {
    DEFAULT_ANNOTATION_PROFILE_ID,
    defaultAnnotationProfile,
    normalizeAnnotationSettings,
} from "utils/annotation-profiles";

import type ZotFlow from "main";

/** Edits a draft; only Save registers new category names and updates readers. */
export class AnnotationProfilesModal extends Modal {
    private draft;
    private selected: string;
    private busy = false;

    constructor(
        private plugin: ZotFlow,
        private onSaved: () => void,
    ) {
        super(plugin.app);
        this.draft = normalizeAnnotationSettings(plugin.settings);
        this.selected = this.draft.defaultAnnotationProfileId;
        this.setTitle("Annotation profiles");
    }

    onOpen(): void {
        this.render();
    }

    private render(): void {
        this.contentEl.empty();
        this.modalEl.addClass("zotflow-profiles-modal");
        const profile = this.draft.annotationProfiles.find(
            (p) => p.id === this.selected,
        )!;
        const builtIn = profile.id === DEFAULT_ANNOTATION_PROFILE_ID;
        new Setting(this.contentEl).setName("Profile").addDropdown((select) => {
            for (const p of this.draft.annotationProfiles)
                select.addOption(p.id, p.name);
            select.setValue(profile.id).onChange((id) => {
                this.selected = id;
                this.render();
            });
        });
        new Setting(this.contentEl)
            .setName("Manage profiles")
            .setDesc(
                "Deleting a profile leaves annotations and remembered category names intact.",
            )
            .addButton((button) =>
                button.setButtonText("New").onClick(() => {
                    const next = defaultAnnotationProfile();
                    next.id = crypto.randomUUID();
                    next.name = "New profile";
                    next.palette = next.palette.map((entry) => ({
                        ...entry,
                        id: crypto.randomUUID(),
                    }));
                    this.draft.annotationProfiles.push(next);
                    this.selected = next.id;
                    this.render();
                }),
            )
            .addButton((button) =>
                button.setButtonText("Duplicate").onClick(() => {
                    const next = {
                        ...profile,
                        id: crypto.randomUUID(),
                        name: `${profile.name} copy`,
                        palette: profile.palette.map((entry) => ({
                            ...entry,
                            id: crypto.randomUUID(),
                        })),
                    };
                    this.draft.annotationProfiles.push(next);
                    this.selected = next.id;
                    this.render();
                }),
            )
            .addButton((button) =>
                button
                    .setButtonText("Delete")
                    .setDisabled(builtIn)
                    .onClick(() => {
                        this.draft.annotationProfiles =
                            this.draft.annotationProfiles.filter(
                                (p) => p.id !== profile.id,
                            );
                        this.selected = DEFAULT_ANNOTATION_PROFILE_ID;
                        this.render();
                    }),
            );
        new Setting(this.contentEl)
            .setName("Profile name")
            .setDesc(
                builtIn
                    ? "Duplicate the built-in profile to customize it."
                    : "",
            )
            .addText((text) =>
                text
                    .setValue(profile.name)
                    .setDisabled(builtIn)
                    .onChange((name) => {
                        profile.name = name;
                    }),
            );
        this.contentEl.createEl("p", {
            text: "Labels describe colors. With automatic tagging enabled, a label is also added as an ordinary tag when you create an annotation. Existing annotations are never retagged.",
        });
        for (const [index, entry] of profile.palette.entries()) {
            new Setting(this.contentEl)
                .setName(`Color ${index + 1}`)
                .setClass("zotflow-palette-entry")
                .addColorPicker((picker) =>
                    picker
                        .setValue(entry.color)
                        .setDisabled(builtIn)
                        .onChange((color) => {
                            entry.color = color;
                            this.render();
                        }),
                )
                .addText((text) => {
                    text.setValue(entry.color)
                        .setPlaceholder("#ffd400")
                        .setDisabled(builtIn)
                        .onChange((color) => {
                            entry.color = color;
                        });
                    text.inputEl.setAttribute(
                        "aria-label",
                        `Color ${index + 1} hex value`,
                    );
                })
                .addText((text) => {
                    text.setValue(entry.label)
                        .setPlaceholder("Optional label")
                        .setDisabled(builtIn)
                        .onChange((label) => {
                            entry.label = label;
                        });
                    text.inputEl.setAttribute(
                        "aria-label",
                        `Color ${index + 1} label`,
                    );
                })
                .addButton((button) =>
                    button
                        .setIcon("arrow-up")
                        .setTooltip("Move color up")
                        .setDisabled(builtIn || index === 0)
                        .onClick(() => {
                            profile.palette.splice(index, 1);
                            profile.palette.splice(index - 1, 0, entry);
                            this.render();
                        }),
                )
                .addButton((button) =>
                    button
                        .setIcon("arrow-down")
                        .setTooltip("Move color down")
                        .setDisabled(
                            builtIn || index === profile.palette.length - 1,
                        )
                        .onClick(() => {
                            profile.palette.splice(index, 1);
                            profile.palette.splice(index + 1, 0, entry);
                            this.render();
                        }),
                )
                .addButton((button) =>
                    button
                        .setIcon("trash")
                        .setTooltip("Remove color")
                        .setDisabled(builtIn || profile.palette.length === 1)
                        .onClick(() => {
                            profile.palette.splice(index, 1);
                            this.render();
                        }),
                );
        }
        new Setting(this.contentEl).addButton((button) =>
            button
                .setButtonText("Add color")
                .setDisabled(builtIn)
                .onClick(() => {
                    let value = 0;
                    while (
                        profile.palette.some(
                            (p) =>
                                p.color.toLowerCase() ===
                                `#${value.toString(16).padStart(6, "0")}`,
                        )
                    )
                        value++;
                    profile.palette.push({
                        id: crypto.randomUUID(),
                        color: `#${value.toString(16).padStart(6, "0")}`,
                        label: "",
                    });
                    this.render();
                }),
        );
        new Setting(this.contentEl)
            .addButton((button) =>
                button.setButtonText("Cancel").onClick(() => this.close()),
            )
            .addButton((button) =>
                button
                    .setButtonText("Save")
                    .setCta()
                    .onClick(() => void this.save()),
            );
    }

    private async save(): Promise<void> {
        if (this.busy) return;
        for (const profile of this.draft.annotationProfiles) {
            const colors = profile.palette.map((entry) =>
                entry.color.trim().toLowerCase(),
            );
            if (
                !profile.name.trim() ||
                !colors.length ||
                colors.some((color) => !/^#[0-9a-f]{6}$/.test(color)) ||
                new Set(colors).size !== colors.length
            ) {
                services.notificationService.notify(
                    "warning",
                    "Each profile needs a name and distinct six-digit hex colors.",
                );
                return;
            }
        }
        this.busy = true;
        const previous = this.plugin.settings;
        try {
            // Preserve settings changed outside this modal while the draft was open.
            this.plugin.settings = {
                ...previous,
                ...normalizeAnnotationSettings({
                    ...previous,
                    annotationProfiles: this.draft.annotationProfiles,
                    annotationCategoryTags: [
                        ...previous.annotationCategoryTags,
                        ...this.draft.annotationCategoryTags,
                    ],
                }),
            };
            await this.plugin.saveSettings();
            this.onSaved();
            this.close();
        } catch (error) {
            this.plugin.settings = previous;
            services.logService.error(
                "Failed to save annotation profiles",
                "AnnotationProfilesModal",
                error,
            );
            services.notificationService.notify(
                "error",
                "Could not save annotation profiles.",
            );
        } finally {
            this.busy = false;
        }
    }
}
