// Seed a Zotero library with the live-test fixture set (fixture-library.mjs)
// and reset it after tests have changed it. Only fixture-owned objects are
// created, updated or deleted; see zotero-fixtures-lib.mjs for what "owned"
// means. A dedicated test group is still recommended: tests sync, and a sync
// touches the whole library.
//
//   npm run live:fixtures -- libraries        libraries the key can write to
//   npm run live:fixtures -- plan             what apply would change (read-only)
//   npm run live:fixtures -- apply            make the library match the spec
//   npm run live:fixtures -- purge --yes      delete every fixture-owned object
//   npm run live:fixtures -- keys [id...]     fixture id → Zotero key
//
// Needs ZOTFLOW_TEST_API_KEY and the target library, as ZOTFLOW_TEST_LIBRARY
// or "fixtureLibrary" in .obsidian-test/config.json ("groups/<id>").

import spec from "./fixture-library.mjs";
import { CONFIG_PATH, loadConfig } from "./obsidian-harness.mjs";
import {
    ZoteroClient,
    applyPlan,
    buildDesired,
    describePlan,
    fixtureKey,
    plan,
    planIsEmpty,
    purgePlan,
} from "./zotero-fixtures-lib.mjs";

function client({ needLibrary = true } = {}) {
    const config = loadConfig();
    if (!config.apiKey) throw new Error("Set ZOTFLOW_TEST_API_KEY");
    if (needLibrary && !config.fixtureLibrary) {
        throw new Error(
            `Set ZOTFLOW_TEST_LIBRARY or "fixtureLibrary" in ${CONFIG_PATH} (e.g. "groups/123456"); "npm run live:fixtures -- libraries" lists the options`,
        );
    }
    if (needLibrary && config.fixtureLibrary.startsWith("users/")) {
        console.warn(
            "warning: targeting a personal library. Fixture objects are kept apart from your items, but a dedicated test group is safer.",
        );
    }
    return new ZoteroClient({
        apiKey: config.apiKey,
        library: config.fixtureLibrary ?? "users/0",
    });
}

function print(p) {
    const lines = describePlan(p);
    console.log(lines.length > 0 ? lines.join("\n") : "Library matches the fixture spec.");
}

const [command, ...args] = process.argv.slice(2);
const commands = {
    async libraries() {
        for (const l of await client({ needLibrary: false }).writableLibraries()) {
            console.log(`${l.library}\t${l.name}`);
        }
    },
    async plan() {
        const c = client();
        print(plan(buildDesired(spec), await c.snapshot()));
    },
    async apply() {
        const c = client();
        const desired = buildDesired(spec);
        const p = plan(desired, await c.snapshot());
        print(p);
        if (planIsEmpty(p)) return;
        await applyPlan(c, p, (line) => console.log(`  ${line}`));
        const after = plan(desired, await c.snapshot());
        if (!planIsEmpty(after)) {
            print(after);
            throw new Error("Library still differs from the spec after apply");
        }
        console.log("Done; library matches the fixture spec.");
    },
    async purge() {
        if (!args.includes("--yes")) {
            throw new Error('purge deletes every fixture-owned object; rerun with "--yes"');
        }
        const c = client();
        const p = purgePlan(buildDesired(spec), await c.snapshot());
        print(p);
        await applyPlan(c, p, (line) => console.log(`  ${line}`));
    },
    keys() {
        const desired = buildDesired(spec);
        const wanted = new Set(args);
        for (const [key, id] of desired.ids) {
            if (wanted.size === 0 || wanted.has(id) || wanted.has(id.replace(/^collection:/, ""))) {
                console.log(`${key}\t${id}`);
            }
        }
        for (const id of wanted) {
            if (![...desired.ids.values()].some((v) => v === id || v === `collection:${id}`)) {
                console.log(`${fixtureKey(id)}\t${id} (not in spec)`);
            }
        }
    },
};

if (!commands[command]) {
    console.log(`Commands: ${Object.keys(commands).join(", ")}`);
    process.exit(command ? 1 : 0);
}
try {
    await commands[command]();
} catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
}
