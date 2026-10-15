/**
 * Runs billion-context-pi in Pi Pocket: model-driven context compression (compress, decompress, search_context) that
 * survives forks.
 *
 * billion-context-pi (https://pi.dev/packages/billion-context-pi) is a pi extension: it is written for pi's extension
 * API (`pi.on`, `pi.registerTool`, a session manager). This drop-in gives it that API on top of Pi Durable, for the
 * parts that work without a terminal, and drops the rest:
 *
 * - `context` (the messages of each request) -> `beforeRequest` of the generation task
 * - `before_agent_start` (its system prompt text) -> a prompt section
 * - `registerTool` -> Pi Durable tools
 * - `tool_call` / `tool_result` -> `beforeTool` / `afterTool`
 * - `message_end` -> `afterResponse`
 * - `session_before_compact` -> `beforeCompact` (it declines Pi Durable's compaction: it does its own)
 * - `session_start` -> once per conversation per load, before its first request or tool call
 * - commands, shortcuts, renderers, `input`, `agent_settled`, `appendEntry`, `sendUserMessage`: not available, ignored
 *
 * billion-context-pi runs as a declared "fork host" (PI_ACP_FORK_HOST=1): it reads the messages of each request
 * instead of pi's session file, and keeps its compression state in `<stateDir>/<conversation>.jsonl.acp.json`.
 *
 * Forks: after each compression, an immutable checkpoint of that state is saved in `<stateDir>/checkpoints/`, and
 * its ID goes into the tool result's details (never model-visible). A fork restores the newest checkpoint in the
 * history it inherited, so it starts with exactly the compression made before its fork point. Histories without
 * checkpoints fall back to billion-context-pi's own replay of the compress calls they contain.
 *
 * Settings: `billion-context-pi-pocket-adapter.json` next to this file, all optional (see the README).
 */
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    AgentDoc,
    CompactionTask,
    defineExtension,
    defineTool,
    GenerationTask,
    hook,
    section,
    ToolTask,
} from "@earendil-works/pi-durable";

// ---- settings ----

const SETTINGS_FILE = "billion-context-pi-pocket-adapter.json";
/** billion-context-pi versions this adapter is tested with. Others run, with a warning. */
const TESTED_BCP_VERSIONS = ["0.1.83"];
/** In tool-result details. Histories made by earlier versions of this adapter carry it: keep it. */
export const CHECKPOINT_KEY = "pocketBcpCheckpoint";

interface Settings {
    /** billion-context-pi's package folder. Default: where `pi install npm:billion-context-pi` puts it. */
    billionContextPi?: string;
    /** Compression state. Relative to Pi Pocket's data folder. Default: "billion-context-pi". */
    stateDir?: string;
    /** The Pi Durable extension's name. Conversations store it: keep it once chosen. Default: "billion-context-pi". */
    extensionName?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(here, SETTINGS_FILE);

function readSettings(): Settings {
    if (!existsSync(settingsPath)) return {};
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${settingsPath} must hold a JSON object`);
    }
    for (const key of ["billionContextPi", "stateDir", "extensionName"]) {
        if (parsed[key] !== undefined && (typeof parsed[key] !== "string" || parsed[key] === "")) {
            throw new Error(`${settingsPath}: "${key}" must be a non-empty string`);
        }
    }
    return parsed;
}

const settings = readSettings();
const extensionName = settings.extensionName ?? "billion-context-pi";

// ---- billion-context-pi ----

const bcpDir = resolve(
    here,
    settings.billionContextPi ?? join(getAgentDir(), "npm", "node_modules", "billion-context-pi"),
);
const bcpPackagePath = join(bcpDir, "package.json");
if (!existsSync(bcpPackagePath)) {
    throw new Error(
        `billion-context-pi is not installed at ${bcpDir}. Install it with \`pi install npm:billion-context-pi\`, ` +
            `or set "billionContextPi" in ${settingsPath} to its package folder.`,
    );
}
const bcpPackage = JSON.parse(readFileSync(bcpPackagePath, "utf8"));
if (bcpPackage.name !== "billion-context-pi") {
    throw new Error(`${bcpDir} is not billion-context-pi (its package is "${bcpPackage.name}")`);
}
export const BCP_VERSION: string = bcpPackage.version;
const bcpEntry: string = bcpPackage.exports?.["."]?.import ?? bcpPackage.main ?? "dist/index.js";

/**
 * billion-context-pi imports the packages pi provides to its extensions (`@earendil-works/pi-coding-agent` and the
 * rest) without installing them. Resolve those from this folder instead: its `node_modules` links to Pi Pocket's,
 * so billion-context-pi gets the very modules the server runs. Registered once per process; a reload only moves it.
 */
const HOST_PACKAGES = /^(?:@earendil-works\/(?:pi-ai|pi-agent-core|pi-coding-agent|pi-tui)|typebox)(?:\/|$)/;
const redirect = Symbol.for("billion-context-pi-pocket-adapter.resolve");
type Redirect = { from: string; to: string };
const store = globalThis as typeof globalThis & { [redirect]?: { current: Redirect } };
if (store[redirect] === undefined) {
    const state = { current: { from: "", to: "" } };
    store[redirect] = state;
    registerHooks({
        resolve(specifier, context, next) {
            const { from, to } = state.current;
            if (from !== "" && context.parentURL?.startsWith(from) === true && HOST_PACKAGES.test(specifier)) {
                return next(specifier, { ...context, parentURL: to });
            }
            return next(specifier, context);
        },
    });
}
store[redirect]!.current = {
    from: pathToFileURL(realpathSync(bcpDir)).href + "/",
    to: pathToFileURL(join(here, SETTINGS_FILE)).href,
};

// Read by billion-context-pi as it loads and on every event: set before it loads. These are process-wide.
process.env.PI_ACP_FORK_HOST = "1";
// Checkpoints are made for one version: a server must not npm-install a newer one under itself.
process.env.ACP_AUTO_UPDATE = "0";
const bcp = await import(pathToFileURL(join(bcpDir, bcpEntry)).href);
const factory = bcp.default as (pi: unknown) => unknown;
const deriveChildState = bcp.deriveChildState as ((state: any) => any) | undefined;
if (typeof factory !== "function" || typeof deriveChildState !== "function") {
    throw new Error(`billion-context-pi ${BCP_VERSION} at ${bcpDir} lacks the API this adapter needs`);
}

// ---- fork checkpoints ----

// Must match billion-context-pi's messageIdentity/stableLiveId: saved state already uses these IDs.
const REF_SOURCE = "(?:<acp\\s[^>]*>m\\d{5}</acp>|\\[m\\d{1,5}\\])";
const LEADING_REF = new RegExp(`^${REF_SOURCE}\\s?\\n?`);
const TRAILING_REF = new RegExp(`\\n*${REF_SOURCE}\\s*$`);
const stripRef = (text: string) => text.replace(LEADING_REF, "").replace(TRAILING_REF, "");

function normalize(value: any, message = false): any {
    if (Array.isArray(value)) {
        return value.flatMap((item) => {
            if (item?.type === "text" && typeof item.text === "string") {
                const stripped = stripRef(item.text);
                if (item.text !== stripped && stripped === "") return [];
            }
            return [normalize(item)];
        });
    }
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        if (message && key === "timestamp") continue;
        const item = value[key];
        if (message && key === "content" && typeof item === "string") {
            out[key] = [{ text: stripRef(item), type: "text" }];
        } else if (key === "text" && typeof item === "string" && value.type === "text") {
            out[key] = stripRef(item);
        } else {
            out[key] = normalize(item);
        }
    }
    return out;
}

/** The untransformed, fork-bounded request history as session entries, with billion-context-pi's stable IDs. */
export function branchEntries(messages: readonly any[]): any[] {
    const ranks = new Map<string, number>();
    return messages.map((message) => {
        const identity = JSON.stringify(normalize(message, true));
        const rank = ranks.get(identity) ?? 0;
        ranks.set(identity, rank + 1);
        const id = `live-${createHash("sha256").update(`${identity}\0${rank}`).digest("hex").slice(0, 16)}`;
        return { type: "message", id, parentId: null, timestamp: String(message.timestamp ?? 0), message };
    });
}

function readState(file: string): any | undefined {
    try {
        const state = JSON.parse(readFileSync(`${file}.acp.json`, "utf8"));
        if (Array.isArray(state?.blocks)) return state;
    } catch (error: any) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return undefined;
}

/** Immutable, content-addressed objects keep checkpoints out of already-large chat histories. */
function objectPath(file: string, id: string): string | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined;
    return join(dirname(file), "checkpoints", `${id}.json`);
}

function saveObject(file: string, value: unknown): string {
    const content = JSON.stringify(value);
    const id = createHash("sha256").update(content).digest("hex");
    const target = objectPath(file, id)!;
    if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(temporary, content, { mode: 0o600 });
        renameSync(temporary, target);
    }
    return id;
}

function loadObject(file: string, id: unknown): any | undefined {
    if (typeof id !== "string") return undefined;
    const target = objectPath(file, id);
    if (target === undefined) return undefined;
    try {
        const content = readFileSync(target, "utf8");
        if (createHash("sha256").update(content).digest("hex") !== id) return undefined;
        return JSON.parse(content);
    } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        return undefined;
    }
}

/** The checkpoint for a compress call (or a codemode script that made one): only IDs, no copies of old messages. */
function checkpointFor(file: string, conversationId: string, callId: string): any | undefined {
    const state = readState(file);
    const made = state?.blocks.some(
        (block: any) => block.compressCallId === callId || block.compressCallId?.startsWith(`${callId}/`),
    );
    if (!made) return undefined;
    // Deduplicate block bodies across checkpoints, and leave out origins (which repeat whole messages).
    const { liveRefOrigins: _origins, derivedFrom: _parent, blocks, ...snapshot } = state;
    const blockIds = blocks.map((block: any) => saveObject(file, block));
    const stateId = saveObject(file, { ...snapshot, blockIds });
    return { version: 2, bcpVersion: BCP_VERSION, conversationId, stateId };
}

/** Restore the newest checkpoint in a fork's inherited history; never replace state the fork already has. */
function restoreCheckpoint(file: string, messages: readonly any[]): string | undefined {
    if ((readState(file)?.blocks.length ?? 0) > 0) return undefined;
    // Only checkpoints present at the fork cutoff can be selected.
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== "toolResult") continue;
        const checkpoint = message.details?.[CHECKPOINT_KEY];
        if (checkpoint?.bcpVersion !== BCP_VERSION) continue;
        let source: any;
        if (checkpoint.version === 2) {
            const manifest = loadObject(file, checkpoint.stateId);
            if (!Array.isArray(manifest?.blockIds)) continue;
            const blocks = manifest.blockIds.map((id: unknown) => loadObject(file, id));
            if (blocks.some((block: any) => typeof block?.blockId !== "string")) continue;
            const { blockIds: _ids, ...state } = manifest;
            source = { ...state, blocks };
        } else if (checkpoint.version === 1) {
            // The whole state inline, as the first version of this adapter saved it.
            source = checkpoint.state;
        } else {
            continue;
        }
        if (
            !Array.isArray(source?.blocks) ||
            source.blocks.length === 0 ||
            !source.messageRefs?.byRaw ||
            !source.messageRefs?.byRef
        ) {
            continue;
        }
        const restored = {
            ...deriveChildState!(source),
            schemaVersion: source.schemaVersion,
            producer: source.producer,
            derivedFrom: { parentSessionId: String(checkpoint.conversationId), derivedAt: Date.now() },
            liveRefOrigins: [],
        };
        const target = `${file}.acp.json`;
        const temporary = `${target}.fork-${process.pid}`;
        writeFileSync(temporary, JSON.stringify(restored), { mode: 0o600 });
        renameSync(temporary, target);
        return String(checkpoint.conversationId);
    }
    return undefined;
}

// ---- the adapter ----

type Level = "info" | "warning" | "error";
/** The part of Pi Pocket's host this uses. */
type Host = { dataDir: string; notice(level: Level, message: string, conversationId?: string): void };
type Handler = (event: any, ctx: any) => unknown;
type PiTool = {
    name: string;
    description: string;
    parameters: any;
    annotations?: Record<string, unknown>;
    execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: any): Promise<any>;
};

/**
 * Tools that only change what the model sees of the conversation, never files, commands, or anything outside it, so
 * Pocket's plan mode may run them. The delegate tools start subagents and stay blocked there.
 */
const CONTEXT_ONLY = new Set(["compress", "decompress", "search_context", "acp_status", "acp_cache"]);

/** The tool's own annotations, marked read-only when it only changes the model's view (Pocket's plan mode reads it). */
function annotationsOf(tool: PiTool): { annotations?: Record<string, unknown> } {
    if (!CONTEXT_ONLY.has(tool.name)) {
        return tool.annotations === undefined ? {} : { annotations: tool.annotations };
    }
    return { annotations: { ...tool.annotations, readOnlyHint: true } };
}

/** A value that survives JSON (Pi Durable stores details as JSON). */
function json(value: unknown): any {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

/** Pi Pocket calls this synchronously: everything asynchronous happens at import or in the hooks. */
export default function createBillionContextPiAdapter(host: Host) {
    const stateDir = isAbsolute(settings.stateDir ?? "")
        ? settings.stateDir!
        : join(host.dataDir, settings.stateDir ?? "billion-context-pi");
    mkdirSync(stateDir, { recursive: true });
    if (!TESTED_BCP_VERSIONS.includes(BCP_VERSION)) {
        host.notice(
            "warning",
            `${extensionName}: billion-context-pi ${BCP_VERSION} is untested with this adapter (tested: ${TESTED_BCP_VERSIONS.join(", ")}).`,
        );
    }

    const handlers = new Map<string, Handler[]>();
    const tools: PiTool[] = [];
    const ignored = new Set<string>();
    const pi: Record<string, unknown> = {
        on(event: string, handler: Handler) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        registerTool(tool: PiTool) {
            if (!tools.some((t) => t.name === tool.name)) tools.push(tool);
        },
        events: { on: () => () => {}, emit: () => {} },
    };
    const api = new Proxy(pi, {
        get(target, key) {
            if (typeof key !== "string") return undefined;
            if (key in target) return target[key];
            // registerCommand, registerShortcut, registerEntryRenderer, appendEntry, sendUserMessage, ...
            return () => {
                if (ignored.has(key)) return;
                ignored.add(key);
                console.log(`[${extensionName}] pi API "${key}" is not available in Pi Pocket: ignored`);
            };
        },
        // billion-context-pi checks `typeof pi.appendEntry === "function"` and the like: report only what works.
        has: (target, key) => key in target,
    });

    factory(api);

    // ---- per-conversation pi context ----

    const started = new Map<string, Promise<void>>();
    const branches = new Map<string, any[]>();
    const prepared = new Set<string>();

    function sessionFile(conversationId: string): string {
        const file = join(stateDir, `${conversationId}.jsonl`);
        if (!existsSync(file)) writeFileSync(file, "");
        return file;
    }

    /** `conversationId` is Pi Durable's own ID: passed unchanged to Pi Durable, as a string to billion-context-pi. */
    async function modelOf(read: any, models: any, conversationId: unknown, context: unknown) {
        const agent = await read.snapshot(AgentDoc, conversationId, context);
        const ref = agent?.model as { provider: string; modelId: string } | undefined;
        const cwd = agent?.cwd as string | undefined;
        return { cwd, model: ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId) };
    }

    function ctxFor(conversationId: string, model: unknown, cwd: string | undefined) {
        const file = sessionFile(conversationId);
        const branch = () => branches.get(conversationId) ?? [];
        const notify = (message: string, level?: string) =>
            host.notice(
                level === "error" ? "error" : level === "warning" ? "warning" : "info",
                String(message),
                conversationId,
            );
        return {
            cwd: cwd ?? process.cwd(),
            model,
            mode: "rpc",
            hasUI: false,
            ui: new Proxy({ notify } as Record<string, unknown>, {
                get: (target, key) => (typeof key === "string" && key in target ? target[key] : () => undefined),
            }),
            sessionManager: {
                getSessionId: () => conversationId,
                getSessionFile: () => file,
                getCwd: () => cwd ?? process.cwd(),
                // The request's own history, already bounded by Pi Durable's fork cutoff.
                getBranch: branch,
                getEntries: branch,
                getEntry: (id: string) => branch().find((entry) => entry.id === id),
                getHeader: () => undefined,
                getLeafId: () => branch().at(-1)?.id ?? null,
            },
            getSystemPrompt: () => "",
            abort: () => {},
            isIdle: () => false,
        };
    }

    async function fire(event: string, payload: Record<string, unknown>, ctx: unknown): Promise<unknown[]> {
        const results: unknown[] = [];
        for (const handler of handlers.get(event) ?? []) {
            results.push(await handler({ type: event, ...payload }, ctx));
        }
        return results;
    }

    /** `session_start` once per conversation for this load of the module (a restart or reload starts again). */
    function start(conversationId: string, ctx: unknown): Promise<void> {
        let done = started.get(conversationId);
        if (done === undefined) {
            done = fire("session_start", { reason: "startup" }, ctx).then(() => undefined);
            started.set(conversationId, done);
        }
        return done;
    }

    async function contextFor(hookApi: any, context: unknown) {
        const { model, cwd } = await modelOf(hookApi, hookApi.models, hookApi.conversationId, context);
        const ctx = ctxFor(String(hookApi.conversationId), model, cwd);
        await start(String(hookApi.conversationId), ctx);
        return ctx;
    }

    // ---- tools ----

    const durableTools = tools.map((tool) =>
        defineTool({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...annotationsOf(tool),
            // compress changes saved state: a repeat after a restart must come back as interrupted, not run twice.
            replay: tool.name === "compress" ? "unsafe" : "safe",
            execute: async (args: unknown, toolApi: any, context: any) => {
                const ctx = await contextFor(toolApi, context);
                const result = await tool.execute(toolApi.callId, args, undefined, undefined, ctx);
                return {
                    content: result?.content ?? [{ type: "text" as const, text: "" }],
                    ...(result?.isError === true ? { isError: true } : {}),
                    ...(result?.details !== undefined ? { details: json(result.details) } : {}),
                };
            },
        }),
    );

    // ---- system prompt ----

    const prompt = section(
        "billion_context",
        async (input: any) => {
            const ref = input.agent?.model as { provider: string; modelId: string } | undefined;
            const model = ref === undefined ? undefined : { provider: ref.provider, id: ref.modelId };
            const ctx = ctxFor(String(input.conversationId), model, input.agent?.cwd);
            await start(String(input.conversationId), ctx);
            let text = "";
            for (const result of await fire("before_agent_start", { systemPrompt: "", prompt: "" }, ctx)) {
                const next = (result as { systemPrompt?: string } | undefined)?.systemPrompt;
                if (typeof next === "string") text = next;
            }
            text = text.replace(/^\s+/, "");
            return text === "" ? undefined : text;
        },
        { tag: false },
    );

    // ---- hooks ----

    const generation = hook(GenerationTask, {
        beforeRequest: async (request: any, hookApi: any, context: any) => {
            const sid = String(hookApi.conversationId);
            // Captured before billion-context-pi changes the request: already bounded by Pi Durable's fork cutoff.
            branches.set(sid, branchEntries(request.messages));
            if (!prepared.has(sid)) {
                try {
                    const source = restoreCheckpoint(sessionFile(sid), request.messages);
                    if (source !== undefined) {
                        // session_start makes billion-context-pi read the restored state.
                        started.delete(sid);
                        host.notice("info", `Restored compression inherited from session ${source}.`, sid);
                    }
                } catch (error) {
                    host.notice(
                        "warning",
                        `Could not restore inherited compression; replaying its compress calls instead: ${String(error)}`,
                        sid,
                    );
                }
                prepared.add(sid);
            }
            const ctx = await contextFor(hookApi, context);
            let messages = [...request.messages];
            for (const result of await fire("context", { messages }, ctx)) {
                const next = (result as { messages?: unknown[] } | undefined)?.messages;
                if (Array.isArray(next)) messages = next;
            }
            return { messages };
        },
        afterResponse: async (message: any, hookApi: any, context: any) => {
            await fire("message_end", { message }, await contextFor(hookApi, context));
        },
    } as any);

    const toolHooks = hook(ToolTask, {
        beforeTool: async (call: any, hookApi: any, context: any) => {
            if (!handlers.has("tool_call")) return undefined;
            const ctx = await contextFor(hookApi, context);
            const input = json(call.arguments) ?? {};
            const before = JSON.stringify(input);
            for (const result of await fire("tool_call", { toolName: call.name, toolCallId: call.id, input }, ctx)) {
                const r = result as { block?: boolean; reason?: string } | undefined;
                if (r?.block === true) return { block: r.reason ?? "Blocked by billion-context-pi." };
            }
            return JSON.stringify(input) === before ? undefined : { arguments: input };
        },
        afterTool: async (call: any, result: any, hookApi: any, context: any) => {
            const sid = String(hookApi.conversationId);
            const ctx = await contextFor(hookApi, context);
            let next = result;
            const outcomes = await fire(
                "tool_result",
                {
                    toolName: call.name,
                    toolCallId: call.id,
                    input: call.arguments,
                    content: result.content ?? [],
                    details: result.details,
                    isError: result.isError === true,
                },
                ctx,
            );
            for (const outcome of outcomes) {
                const o = outcome as { content?: unknown; details?: unknown; isError?: boolean } | undefined;
                if (o === undefined) continue;
                next = {
                    ...next,
                    ...(o.content !== undefined ? { content: o.content } : {}),
                    ...(o.details !== undefined ? { details: json(o.details) } : {}),
                    ...(o.isError !== undefined ? { isError: o.isError } : {}),
                };
            }
            // Codemode drops a nested compress's details, so its outer result carries the checkpoint too.
            if (call.name === "compress" || call.name === "codemode") {
                try {
                    const checkpoint = checkpointFor(sessionFile(sid), sid, call.id);
                    if (checkpoint !== undefined && (call.name !== "compress" || next.isError !== true)) {
                        next = { ...next, details: { ...next.details, [CHECKPOINT_KEY]: checkpoint } };
                    }
                } catch (error) {
                    // The compression is already made: a checkpoint failure must not fail the tool call.
                    host.notice("warning", `Could not save the fork checkpoint: ${String(error)}`, sid);
                }
            }
            return next;
        },
    } as any);

    const compaction = hook(CompactionTask, {
        beforeCompact: async (input: any, hookApi: any, context: any) => {
            const ctx = await contextFor(hookApi, context);
            for (const result of await fire("session_before_compact", { reason: input.reason }, ctx)) {
                if ((result as { cancel?: boolean } | undefined)?.cancel === true) return { decline: true as const };
            }
            return undefined;
        },
    } as any);

    return defineExtension({
        name: extensionName,
        tools: durableTools as any,
        sections: [prompt],
        hooks: [generation, toolHooks, compaction],
    });
}
