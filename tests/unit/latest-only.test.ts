import { describe, expect, it } from "vitest";
import { LatestOnly } from "utils/latest-only";

/** A promise resolved from outside, to finish lookups in any order. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

/** Whether `promise` has settled once pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(
        () => (done = true),
        () => (done = true),
    );
    await new Promise((r) => setTimeout(r, 0));
    return done;
}

describe("LatestOnly", () => {
    it("passes a lone result through", async () => {
        const latest = new LatestOnly();
        await expect(latest.run(Promise.resolve(["a"]))).resolves.toEqual(["a"]);
    });

    it("drops an older result that finishes after a newer one", async () => {
        const latest = new LatestOnly();
        const slow = deferred<string>();
        const fast = deferred<string>();
        const older = latest.run(slow.promise); // "type"
        const newer = latest.run(fast.promise); // "type:jo"

        fast.resolve("completions");
        await expect(newer).resolves.toBe("completions");
        slow.resolve("search results");
        expect(await settled(older)).toBe(false);
    });

    it("drops an older result that finishes first, keeps the newest", async () => {
        const latest = new LatestOnly();
        const first = deferred<number>();
        const second = deferred<number>();
        const older = latest.run(first.promise);
        const newer = latest.run(second.promise);

        first.resolve(1);
        expect(await settled(older)).toBe(false);
        second.resolve(2);
        await expect(newer).resolves.toBe(2);
    });

    it("passes on the newest lookup's failure", async () => {
        const latest = new LatestOnly();
        await expect(latest.run(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
});
