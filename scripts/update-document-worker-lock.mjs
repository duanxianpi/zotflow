import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { deriveEnhancementContract } from "./enhancement-contract.mjs";

const LOCK_URL_PREFIX =
    "https://zotero-download.s3.amazonaws.com/ci/document-worker";
const commit = process.argv[2];

if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(
        "Usage: node scripts/update-document-worker-lock.mjs <40-character commit>",
    );
}

const lockUrl = new URL("../document-worker.lock.json", import.meta.url);
const lock = JSON.parse(await readFile(lockUrl, "utf8"));
const archiveUrl = `${LOCK_URL_PREFIX}/${commit}.zip`;
const response = await fetch(archiveUrl);

if (!response.ok) {
    throw new Error(
        `Document Worker download failed: ${response.status} ${response.statusText}`,
    );
}

const archive = Buffer.from(await response.arrayBuffer());
lock.documentWorker = {
    commit,
    archiveUrl,
    archiveSize: archive.byteLength,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
};

lock.enhancementPack = deriveEnhancementContract(archive, lock.enhancementPack);

await writeFile(lockUrl, `${JSON.stringify(lock, null, 4)}\n`, "utf8");
console.log(
    `Updated document-worker.lock.json to ${commit} (${archive.byteLength} bytes)`,
);
