/**
 * The adapter loaded the way Pi Pocket loads it: a drop-in in a test app's data folder, turned on, with a scripted
 * model (nothing reaches a provider). Needs a Pi Pocket checkout: `PI_POCKET_CHECKOUT=/path/to/pi-pocket npm test`.
 */
import "./env.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const repo = resolve(import.meta.dirname, "..");
const ADAPTER = "billion-context-pi-pocket-adapter.ts";
const bcpDir = join(repo, "node_modules", "billion-context-pi");
const pocketDir = process.env.PI_POCKET_CHECKOUT;
const skip =
    pocketDir === undefined
        ? "set PI_POCKET_CHECKOUT to a Pi Pocket checkout"
        : existsSync(join(pocketDir, "test", "helpers.ts"))
          ? false
          : `no Pi Pocket checkout at ${pocketDir}`;

let h: any;
let app: any;
let dataDir = "";
let dropin = "";
let lastRequest: readonly any[] = [];
let mod: any;
const CHECKPOINT_KEY = "pocketBcpCheckpoint";

/** A drop-in folder with the adapter, its settings, and Pi Pocket's packages, as Pi Pocket makes it. */
function dropInFolder(folder: string, settings: Record<string, string>): string {
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(repo, ADAPTER), join(folder, ADAPTER));
    writeFileSync(join(folder, "billion-context-pi-pocket-adapter.json"), JSON.stringify(settings));
    return join(folder, ADAPTER);
}

if (skip === false) {
    h = await import(join(pocketDir!, "test", "helpers.ts"));
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(
        join(pocketDir!, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")
    );
    const { work, root, lastText, scriptedModel, openApp, owner, cleanUp } = h;
    dataDir = join(root, "data-bcp");
    dropin = dropInFolder(join(dataDir, "extensions"), { billionContextPi: bcpDir });
    writeFileSync(join(work, "A.log"), "OLD_LOG_A: original diagnostics\n".repeat(200));
    writeFileSync(join(work, "B.log"), "OLD_LOG_B: later diagnostics\n".repeat(200));

    const model = scriptedModel((request: any) => {
        lastRequest = request.messages;
        const { role, text } = lastText(request);
        const call = (name: string, args: any) =>
            fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
        if (role === "user" && /read ([AB])/.test(text)) {
            return call("read", { path: join(work, `${/read ([AB])/.exec(text)![1]}.log`) });
        }
        if (role === "user" && /fold ([AB])/.test(text)) {
            const letter = /fold ([AB])/.exec(text)![1];
            const result = request.messages.find(
                (m: any) => m.role === "toolResult" && JSON.stringify(m.content).includes(`OLD_LOG_${letter}`),
            );
            assert.ok(result, "the old read result is there before it is folded");
            const ref = JSON.stringify(result.content).match(/m\d{5}/)?.[0];
            assert.ok(ref, "billion-context-pi tagged the old read result");
            const args = {
                content: [
                    {
                        startId: ref,
                        endId: ref,
                        summary: `SUMMARY_${letter}: the finding from the original log, with all important details kept.`,
                    },
                ],
            };
            if (text.includes("nested")) {
                const fail = text.includes("nested-error") ? '\nthrow new Error("fails after compressing");' : "";
                return call("codemode", { code: `text(await tools.compress(${JSON.stringify(args)}));${fail}` });
            }
            return call("compress", args);
        }
        if (role === "user" && text.includes("unfold")) {
            return call("decompress", { blockId: "b1", inline: true });
        }
        return fauxAssistantMessage([fauxText(role === "toolResult" ? "Completed." : "Continued.")]);
    });
    app = await openApp(model, dataDir);
    await app.setExtensionEnabled(owner(app), ADAPTER, true);
    mod = await import(pathToFileURL(dropin).href);
    after(async () => {
        await app.close();
        cleanUp();
    });
}

const stateFile = (id: unknown) => join(dataDir, "billion-context-pi", `${id}.jsonl.acp.json`);
const state = (id: unknown) => JSON.parse(readFileSync(stateFile(id), "utf8"));
const tail = async (conversation: any) => (await conversation.entries({}, 1, undefined, h.context)).items[0].id;
const textOf = (messages: readonly any[]) => messages.map((m) => JSON.stringify(m.content)).join("\n");
const continueFork = async (parent: any, at: any) => {
    const fork = await parent.fork(at, { ownership: { kind: "ownerless" } }, h.context);
    await (await fork.submit({ type: "input", content: [{ type: "text", text: "continue" }] }, h.context)).wait(
        h.context,
    );
    return fork;
};
/** A second instance of the drop-in, as a reload makes, and its request hook. */
const reloadedGeneration = async () => {
    const reloaded = await import(`${pathToFileURL(dropin).href}?reload=${Date.now()}`);
    const extension = reloaded.default({ dataDir, notice() {} });
    return extension.hooks.find((hk: any) => hk.handlers.beforeRequest).handlers;
};
const fakeApi = (conversationId: string) => ({
    conversationId,
    models: { getModel: () => ({ id: "faux-1", provider: "faux", contextWindow: 128000 }) },
    snapshot: async () => ({ cwd: h.work, model: { provider: "faux", modelId: "faux-1" } }),
});

test("installs billion-context-pi's tools and prompt under the default name", { skip }, async () => {
    const extension = mod.default({ dataDir, notice() {} });
    assert.equal(extension.name, "billion-context-pi");
    assert.deepEqual(
        extension.tools.map((t: any) => t.name).sort(),
        ["acp_cache", "acp_status", "compress", "decompress", "search_context"],
    );
    assert.deepEqual(
        extension.sections.map((s: any) => s.key),
        ["billion_context"],
    );
});

test("forks recover only the compression made before their fork point", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    const parent = (await app.harness.conversation(id, context))!;
    await say(app, id, "read A");
    const beforeCompression = await tail(parent);
    await say(app, id, "fold A");
    const afterA = await tail(parent);
    assert.equal(state(id).blocks.length, 1);
    const system = lastRequest.filter((m: any) => m.role === "system");
    assert.ok(
        system.some((m: any) => /compress/.test(m.sections?.billion_context ?? "")),
        "billion-context-pi's prompt reaches the model",
    );
    const history = (await parent.context(context)).messages;
    const withCheckpoint = history.find((m: any) => m.role === "toolResult" && m.details?.[CHECKPOINT_KEY]) as any;
    assert.ok(withCheckpoint, "the compress result carries a checkpoint");
    assert.ok(!textOf(history).includes(CHECKPOINT_KEY), "the checkpoint is not model-visible");
    const checkpoint = withCheckpoint.details[CHECKPOINT_KEY];
    assert.equal(checkpoint.version, 2);
    assert.ok(JSON.stringify(checkpoint).length < 300, "the checkpoint does not copy the old log");

    await say(app, id, "read B");
    await say(app, id, "fold B");
    assert.equal(state(id).blocks.length, 2);

    const forkBefore = await continueFork(parent, beforeCompression);
    assert.equal(state(forkBefore.id).blocks.length, 0);
    assert.match(textOf(lastRequest), /OLD_LOG_A/);
    assert.doesNotMatch(textOf(lastRequest), /SUMMARY_A|SUMMARY_B/);

    const forkAfterA = await continueFork(parent, afterA);
    assert.equal(state(forkAfterA.id).blocks.length, 1);
    assert.match(textOf(lastRequest), /SUMMARY_A/);
    assert.doesNotMatch(textOf(lastRequest), /OLD_LOG_A|SUMMARY_B|OLD_LOG_B/);
    assert.equal(state(id).blocks.length, 2, "the parent's state is untouched");

    // A reload keeps the fork's own state instead of restoring an older inherited checkpoint over it.
    const generation = await reloadedGeneration();
    await generation.beforeRequest(
        { messages: (await forkAfterA.context(context)).messages },
        { conversationId: forkAfterA.id, models: fakeApi("").models, snapshot: app.harness.snapshot.bind(app.harness) },
        context,
    );
    assert.equal(state(forkAfterA.id).blocks.length, 1);
    await (await forkAfterA.submit({ type: "input", content: [{ type: "text", text: "unfold" }] }, context)).wait(
        context,
    );
    const decompressed = (await forkAfterA.context(context)).messages.findLast(
        (m: any) => m.role === "toolResult" && m.toolName === "decompress",
    ) as any;
    assert.notEqual(decompressed.isError, true);
    assert.match(textOf([decompressed]), /OLD_LOG_A/, "an inherited block can be decompressed");
});

test("histories without checkpoints replay their compress calls", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    const parent = (await app.harness.conversation(id, context))!;
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const messages = (await parent.context(context)).messages.map((m: any) => {
        if (m.role !== "toolResult" || !m.details?.[CHECKPOINT_KEY]) return m;
        const { [CHECKPOINT_KEY]: _checkpoint, ...details } = m.details;
        return { ...m, details };
    });
    const generation = await reloadedGeneration();
    const output = await generation.beforeRequest({ messages }, fakeApi("no-checkpoints"), context);
    assert.equal(state("no-checkpoints").blocks.length, 1);
    assert.match(textOf(output.messages), /SUMMARY_A/);
    assert.doesNotMatch(textOf(output.messages), /OLD_LOG_A/);
});

test("compression from codemode survives forks, even when the script fails afterwards", { skip }, async () => {
    const { context, newSession, say } = h;
    for (const kind of ["nested", "nested-error"]) {
        const id = await newSession(app);
        const parent = (await app.harness.conversation(id, context))!;
        await say(app, id, "read A");
        await say(app, id, `${kind} fold A`);
        assert.equal(state(id).blocks.length, 1);
        const result = (await parent.context(context)).messages.findLast(
            (m: any) => m.role === "toolResult" && m.toolName === "codemode",
        ) as any;
        assert.ok(result.details?.[CHECKPOINT_KEY], "the codemode result carries the checkpoint");
        assert.equal(result.isError === true, kind === "nested-error");
        const fork = await continueFork(parent, await tail(parent));
        assert.equal(state(fork.id).blocks.length, 1);
        assert.match(textOf(lastRequest), /SUMMARY_A/);
        assert.doesNotMatch(textOf(lastRequest), /OLD_LOG_A/);
    }
});

test("branch entry IDs match billion-context-pi's own", { skip }, async () => {
    const messages = [
        { role: "user", content: "one", timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "one" }], timestamp: 2 },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "hidden" },
                { type: "text", text: "two" },
            ],
            timestamp: 3,
        },
    ];
    // Loaded after the adapter, so its imports of Pi's packages resolve to Pi Pocket's.
    const { createRuntime } = await import(pathToFileURL(join(bcpDir, "dist", "index.js")).href);
    const ctx = {
        model: { contextWindow: 128000 },
        sessionManager: { getSessionId: () => "ids", getSessionFile: () => undefined, getBranch: () => [] },
    };
    const result = await createRuntime().stateFor(ctx, messages);
    assert.deepEqual(
        mod.branchEntries(messages).map((e: any) => e.id),
        result.entries.map((e: any) => e.id),
    );
});

test("settings: the state folder and extension name are configurable", { skip }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "bcp-pocket-adapter-settings-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { billionContextPi: bcpDir, stateDir: "bcp", extensionName: "bcp-adapter" });
    const configured = await import(pathToFileURL(file).href);
    const extension = configured.default({ dataDir: folder, notice() {} });
    assert.equal(extension.name, "bcp-adapter");
    assert.ok(existsSync(join(folder, "bcp")));
});

test("a missing billion-context-pi says how to install it", { skip }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "bcp-pocket-adapter-missing-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { billionContextPi: join(folder, "nowhere") });
    await assert.rejects(import(pathToFileURL(file).href), /pi install npm:billion-context-pi/);
});
