// A stand-in for the Playwright page the live sync tests use, for Obsidian on
// an iPad or iPhone (ZF_LIVE_TARGET=ios). It speaks the WebKit Inspector
// Protocol through ios_webkit_debug_proxy:
//
//   brew install ios-webkit-debug-proxy
//   ios_webkit_debug_proxy -c <udid>:9222      (ZF_IOS_PROXY, default localhost:9222)
//
// The device needs Settings → Safari → Advanced → Web Inspector, Obsidian in
// the foreground, and no Safari Web Inspector attached to the same page: the
// device hands a page to one inspector at a time.
//
// Only `page.evaluate` and `page.waitForFunction` are provided, which is all
// the sync tests outside source-notes and upgrade use.

import { clearTimeout, setTimeout } from "node:timers";

const PROXY = process.env.ZF_IOS_PROXY ?? "localhost:9222";

/** Connect to the Obsidian page on the device: `{ page, disconnect }`. */
export async function webkitSession() {
    let list;
    try {
        list = await (await fetch(`http://${PROXY}/json`)).json();
    } catch {
        throw new Error(`No ios_webkit_debug_proxy on ${PROXY}`);
    }
    const target = list.find((p) => p.url.startsWith("capacitor://"));
    if (!target) throw new Error("No Obsidian page on the device: is Obsidian in the foreground?");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
        ws.onopen = ok;
        ws.onerror = () => fail(new Error("Could not connect to the Obsidian page"));
    });

    // Since iOS 13 every command goes to the page's target, announced by
    // Target.targetCreated right after connecting.
    let targetId;
    let nextId = 0;
    const pending = new Map();
    const targetReady = new Promise((ok, fail) => {
        const timer = setTimeout(
            () => fail(new Error("The device did not answer: is another inspector attached to Obsidian?")),
            10000,
        );
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.method === "Target.targetCreated" && !targetId) {
                targetId = m.params.targetInfo.targetId;
                clearTimeout(timer);
                ok();
            } else if (m.method === "Target.dispatchMessageFromTarget") {
                const inner = JSON.parse(m.params.message);
                const settle = pending.get(inner.id);
                if (!settle) return;
                pending.delete(inner.id);
                settle(inner);
            }
        };
    });
    ws.onclose = () => {
        for (const settle of pending.values()) settle({ error: { message: "Connection to the device closed" } });
        pending.clear();
    };
    await targetReady;

    function send(method, params) {
        const id = ++nextId;
        const message = JSON.stringify({ id, method, params });
        return new Promise((ok, fail) => {
            pending.set(id, (reply) => (reply.error ? fail(new Error(reply.error.message)) : ok(reply.result)));
            ws.send(JSON.stringify({ id: ++nextId, method: "Target.sendMessageToTarget", params: { targetId, message } }));
        });
    }

    /** Evaluate an expression; a promise is awaited. Returns the JSON value. */
    async function run(expression) {
        let res = await send("Runtime.evaluate", { expression, returnByValue: false });
        if (!res.wasThrown && res.result.type === "object" && res.result.className === "Promise") {
            res = await send("Runtime.awaitPromise", { promiseObjectId: res.result.objectId, returnByValue: true });
        } else if (!res.wasThrown && res.result.objectId) {
            // A plain object: fetch it by value.
            res = await send("Runtime.callFunctionOn", {
                objectId: res.result.objectId,
                functionDeclaration: "function () { return this; }",
                returnByValue: true,
            });
        }
        if (res.wasThrown) {
            throw new Error(res.result.description ?? String(res.result.value ?? "Evaluation failed"));
        }
        return res.result.value;
    }

    const asExpression = (fn, arg) =>
        typeof fn === "function" ? `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})` : fn;

    const page = {
        evaluate: (fn, arg) => run(asExpression(fn, arg)),
        async waitForFunction(fn, arg, { timeout = 30000, polling = 100 } = {}) {
            const deadline = Date.now() + timeout;
            for (;;) {
                const value = await run(asExpression(fn, arg ?? undefined));
                if (value) return { jsonValue: async () => value };
                if (Date.now() > deadline) throw new Error(`waitForFunction timed out after ${timeout}ms`);
                await new Promise((ok) => setTimeout(ok, polling));
            }
        },
    };
    return { page, disconnect: async () => ws.close() };
}
