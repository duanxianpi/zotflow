// scripts/generate-types-from-file.ts
import * as fs from "fs";
import * as path from "path";
import { format, resolveConfig } from "prettier";

const __dirname = path.resolve();

// Zotero Schema URL
const SCHEMA_URL = "https://api.zotero.org/schema";

const SCHEMA_PATH = path.join(__dirname, "./schema.json");

/**
 * Generation reads the committed schema.json so output is reproducible.
 * Pass --fetch to refresh schema.json from the Zotero API first.
 * Usage: npm run generate-zotero-item-schema [-- --fetch]
 */
async function loadSchema() {
    if (process.argv.includes("--fetch")) {
        const response = await fetch(SCHEMA_URL);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch schema: ${response.status} ${response.statusText}`,
            );
        }
        const schema = await response.json();
        // Localized labels are unused here and make up most of the payload.
        schema.locales = {};
        fs.writeFileSync(
            SCHEMA_PATH,
            JSON.stringify(schema, null, "\t") + "\n",
        );
        console.log(`Fetched Zotero schema v${schema.version}`);
        return schema;
    }
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

async function generate() {
    const schema = await loadSchema();

    let output = `
/**
 * AUTO-GENERATED ZOTERO TYPES
 * Source: schema.json (v${schema.version})
 */

interface BaseZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  parentItem?: string;
  title?: string;
  collections?: string[];
  dateAdded: string;
  dateModified: string;
  tags: Array<{ tag: string; type?: number }>;
  relations: { [key: string]: string | string[] };
  deleted: boolean;
}
`;

    const typeNames = [];
    const itemTypes = [];
    const primaryCreatorTypes = {};
    // itemType → baseField → type-specific field (e.g. case.title → caseName)
    const baseFieldMap = {};
    // Every field name any item type uses, plus base names (e.g. `authority`)
    // that only exist as a mapping target.
    const allFields = new Set();

    // Iterate over schema.itemTypes
    for (const typeDef of schema.itemTypes) {
        const itemType = typeDef.itemType;
        itemTypes.push(itemType);
        const interfaceName = pascalCase(itemType);
        typeNames.push(interfaceName);

        console.log(`Generating ${interfaceName}...`);

        let fieldsStr = "";

        // Process unique fields for this type
        for (const fieldObj of typeDef.fields) {
            const fieldName = fieldObj.field;
            allFields.add(fieldName);
            if (fieldObj.baseField) {
                allFields.add(fieldObj.baseField);
                baseFieldMap[itemType] ??= {};
                baseFieldMap[itemType][fieldObj.baseField] = fieldName;
            }
            const fieldType = "string"; // Default to string
            fieldsStr += `    ${fieldName}?: ${fieldType};\n`;
        }

        // Process creators
        if (typeDef.creatorTypes && typeDef.creatorTypes.length > 0) {
            const creatorTypeUnion = typeDef.creatorTypes
                .map((c) => `'${c.creatorType}'`)
                .join(" | ");

            fieldsStr += `    creators?: Array<{ creatorType: ${creatorTypeUnion}; firstName?: string; lastName?: string; name?: string; }>;\n`;

            // Find primary creator type
            const primary = typeDef.creatorTypes.find((c) => c.primary);
            if (primary) {
                primaryCreatorTypes[itemType] = primary.creatorType;
            }
        }

        // Generate Interface
        output += `
interface ${interfaceName}Data extends BaseZoteroItemData {
  itemType: '${itemType}';
  ${fieldsStr}
}
`;
    }

    // Generate Primary Creator Type Map
    output += `\n\nexport interface ZoteroPrimaryCreatorTypes {\n`;
    for (const [type, creator] of Object.entries(primaryCreatorTypes)) {
        output += `  ${type}: '${creator}';\n`;
    }
    output += `}\n`;

    // Generate Union Type
    output += `\nexport type ZoteroItemData = ${typeNames.map((t) => t + "Data").join(" | ")};\n`;

    // Generate Item Type Union & Guard
    output += `\nexport interface ZoteroItemDataTypeMap {
    ${itemTypes.map((t) => `'${t}': ${pascalCase(t)}Data`).join(" ;\n")}
  }\n`;

    const typesPath = path.join(__dirname, "./src/types/zotero-item.d.ts");
    const constPath = path.join(__dirname, "./src/types/zotero-item-const.ts");
    const baseFieldsPath = path.join(
        __dirname,
        "./src/types/zotero-base-fields.ts",
    );

    const prettierOptions = {
        ...(await resolveConfig(typesPath, { editorconfig: true })),
        parser: "typescript",
    };

    fs.writeFileSync(typesPath, await format(output, prettierOptions));

    fs.writeFileSync(
        constPath,
        await format(
            `\nexport const Zotero_Item_Types: string[] = [${itemTypes.map((t) => `'${t}'`).join(",")}];\n`,
            prettierOptions,
        ),
    );

    fs.writeFileSync(
        baseFieldsPath,
        await format(
            `/**
 * AUTO-GENERATED by scripts/generate-zotero-item-schema.js — do not edit.
 * Source: Zotero schema v${schema.version}
 *
 * Maps each item type's base fields to the type-specific field that
 * stands in for them (e.g. a case's \`title\` lives in \`caseName\`).
 * Read fields through \`getField()\` in \`utils/zotero-fields\`.
 */
export const ZOTERO_SCHEMA_VERSION = ${schema.version};

export const BASE_FIELD_MAP: Readonly<
    Record<string, Readonly<Record<string, string>>>
> = ${JSON.stringify(baseFieldMap)};

/** Every item field name in the schema, base names included. */
export const ZOTERO_FIELDS = ${JSON.stringify([...allFields].sort())} as const;

export type ZoteroFieldName = (typeof ZOTERO_FIELDS)[number];
`,
            prettierOptions,
        ),
    );

    console.log("✅ Types generated!");
}

function pascalCase(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

generate();
