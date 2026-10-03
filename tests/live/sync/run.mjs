// Run the live sync tests against the test Obsidian and the test group.
//
//   npm run live:sync                    every file, in order
//   npm run live:sync -- pull conflicts  just these (file names without .live.mjs)
//
// Needs the instance running (npm run live:obsidian -- launch), a build of
// the current code (npm run build:plugin), zoteroApiKey and a "groups/<id>"
// fixtureLibrary in .obsidian-test/config.json. Files run one at a time:
// they share one Obsidian and one library, and every test starts with a
// reset of both.
//
// Results: spec output on stdout, JUnit XML and the server facts each test
// recorded (facts.jsonl) under .obsidian-test/live-sync/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_DIR } from "../../../scripts/obsidian-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ORDER = ["server", "pull", "push", "conflicts", "faults", "concurrency", "upgrade"];
const available = readdirSync(here)
    .filter((f) => f.endsWith(".live.mjs"))
    .map((f) => f.slice(0, -".live.mjs".length))
    .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

const wanted = process.argv.slice(2);
for (const name of wanted) {
    if (!available.includes(name)) {
        console.error(`No ${name}.live.mjs; available: ${available.join(", ")}`);
        process.exit(1);
    }
}
const names = wanted.length > 0 ? wanted : available;

const out = join(LOCAL_DIR, "live-sync");
mkdirSync(out, { recursive: true });
const facts = join(out, "facts.jsonl");
if (existsSync(facts)) rmSync(facts);

const result = spawnSync(
    process.execPath,
    [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=junit",
        `--test-reporter-destination=${join(out, "results.xml")}`,
        ...names.map((n) => join(here, `${n}.live.mjs`)),
    ],
    { stdio: "inherit" },
);
process.exit(result.status ?? 1);
