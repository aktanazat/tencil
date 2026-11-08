import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { kv, Text, text } from '@oh-my-pi/pi-tui';
import type { Theme } from '@oh-my-pi/pi-tui/theme';
import type { NativeToolView } from '@oh-my-pi/pi-tui/tools/renderer';

type MacVerb = 'see' | 'state' | 'query' | 'handoff' | 'press' | 'click' | 'type' | 'key';
type ResultKind = 'see' | 'state' | 'query' | 'handoff' | 'receipt' | 'error';
type Tone = 'neutral' | 'success' | 'warning' | 'error';

interface MacDetails {
    kind: ResultKind;
    app: string;
    data: Record<string, unknown>;
    mediaPath?: string;
}

interface DriverRequest {
    verb: MacVerb;
    app: string;
    agent_id: string;
    args: Record<string, unknown>;
    expect?: Record<string, unknown>;
}

interface Envelope {
    ok: boolean;
    data: Record<string, unknown>;
}

interface Summary {
    meta: string[];
    facts: [string, string][];
    message?: string;
    tone: Tone;
}

const driver = fileURLToPath(new URL('./mac-driver.py', import.meta.url));
const python = join(homedir(), '.local/share/uv/tools/macos-harness/bin/python');
const actionNote =
    'Does not activate the app or move the physical pointer. Never retry an action whose receipt says acted=yes or unknown before checking mac_state, mac_see or mac_query.';

function object(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function display(value: unknown): string {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function target(args: unknown): string {
    return string(object(args)?.app) ?? '';
}

function approvalTargets(args: unknown): readonly string[] | undefined {
    const app = string(object(args)?.app);
    return app ? [app] : undefined;
}

function macAgentId(ctx: ExtensionContext): string {
    return `${ctx.agent.id.slice(0, 27)}:${ctx.sessionManager.getSessionId()}`;
}

function subject(verb: MacVerb, args: unknown): string {
    const values = object(args) ?? {};
    if (verb === 'type') {
        const value = string(values.text);
        return value === undefined ? '' : `${value.length} characters`;
    }
    if (verb === 'key') return string(values.key) ?? '';
    if (verb === 'see' || verb === 'state')
        return values.window_id === undefined
            ? (string(values.query) ?? '')
            : `window ${display(values.window_id)}`;
    if (verb === 'handoff') return string(values.reason)?.replaceAll('_', ' ') ?? '';
    if (verb === 'click') {
        if (typeof values.state_id === 'number') return `[${values.state_id}]`;
        const element = object(values.element);
        return element
            ? [element.role, element.title, element.description]
                  .filter(value => typeof value === 'string' && value)
                  .join(' · ')
            : values.x !== undefined && values.y !== undefined
              ? `${display(values.x)}, ${display(values.y)}`
              : '';
    }
    return ['text', 'role', 'title', 'identifier', 'description']
        .map(key => string(values[key]))
        .filter(value => value !== undefined && value.length > 0)
        .join(' · ');
}

function receiptFacts(receipt: Record<string, unknown>): [string, string][] {
    const facts: [string, string][] = ['outcome', 'acted', 'changed', 'verified'].map(key => [
        key,
        display(receipt[key]),
    ]);
    if (typeof receipt.duration_s === 'number')
        facts.push(['duration', `${receipt.duration_s.toFixed(2)}s`]);
    return facts;
}

function summarize(result: AgentToolResult<MacDetails>): Summary {
    const details = result.details;
    if (!details) {
        return {
            meta: [],
            facts: [],
            message: result.content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('\n'),
            tone: result.isError ? 'error' : 'neutral',
        };
    }
    const { data, kind } = details;
    if (kind === 'error') {
        const error = object(data.error) ?? {};
        const receipt = object(data.receipt);
        return {
            meta: [string(error.code) ?? 'failed'],
            facts: [...(receipt ? receiptFacts(receipt) : []), ['error', display(error.code)]],
            message: string(error.message) ?? JSON.stringify(error),
            tone: 'error',
        };
    }
    if (kind === 'receipt') {
        const receipt = object(data.receipt) ?? {};
        return {
            meta: [display(receipt.outcome), `acted ${display(receipt.acted)}`],
            facts: receiptFacts(receipt),
            message:
                receipt.acted === 'unknown'
                    ? 'Input may have been sent. Check the app before retrying.'
                    : undefined,
            tone: receipt.acted === 'unknown' ? 'warning' : 'success',
        };
    }
    if (kind === 'see') {
        const focus = object(data.focus) ?? {};
        const warnings = [string(data.warning), string(data.note)].filter(
            value => value !== undefined,
        );
        if (data.on_screen === false)
            warnings.push('Off-screen window: this image shows what the app last drew.');
        return {
            meta: [`${display(data.width)} × ${display(data.height)}`, string(data.title) ?? ''],
            facts: [
                ['window', `${display(data.title)} (${display(data.window_id)})`],
                ['process', display(data.pid)],
                ['on screen', display(data.on_screen)],
                ['frontmost', display(focus.target_is_frontmost)],
                ['screenshot', display(data.path)],
            ],
            message: warnings.length ? warnings.join('\n') : undefined,
            tone: warnings.length ? 'warning' : 'neutral',
        };
    }
    if (kind === 'state') {
        const lines = (string(data.text) ?? '').split('\n');
        return {
            meta: [data.complete === false ? 'partial read' : `${lines.length} lines`],
            facts: [],
            message: lines.slice(0, 12).join('\n') + (lines.length > 12 ? '\n…' : ''),
            tone: data.complete === false ? 'warning' : 'neutral',
        };
    }
    if (kind === 'query') {
        const matches = Array.isArray(data.matches) ? data.matches : [];
        const lines = matches.map((match, index) => {
            const item = object(match) ?? {};
            return `${index + 1}. ${[item.role, item.title, item.description, item.value]
                .filter(value => value !== undefined && value !== null && value !== '')
                .map(display)
                .join(' · ')}`;
        });
        if (data.complete === false) lines.push('Search stopped before reading the whole app.');
        return {
            meta: [
                `${matches.length} matches`,
                data.complete === false ? 'partial search' : 'complete search',
            ],
            facts: [['visited', display(data.visited)]],
            message: lines.length ? lines.join('\n') : 'No matches.',
            tone: data.complete === false ? 'warning' : 'neutral',
        };
    }
    return {
        meta: ['needs you'],
        facts: [],
        message: string(data.prompt),
        tone: 'warning',
    };
}

function presentation(label: string, verb: MacVerb) {
    return {
        describeCall(args: unknown): NativeToolView {
            const detail = subject(verb, args);
            return {
                tool: {
                    title: label,
                    target: target(args),
                    targetKind: 'text',
                    meta: detail ? [detail] : [],
                },
            };
        },
        describeResult(
            result: AgentToolResult<MacDetails>,
            _options: unknown,
            args?: unknown,
        ): NativeToolView {
            const summary = summarize(result);
            const detail = subject(verb, args);
            const facts = kv(summary.facts);
            const body = facts ? [facts] : [];
            if (summary.message) body.push(text(summary.message));
            return {
                tool: {
                    title: label,
                    target: result.details?.app ?? target(args),
                    targetKind: 'text',
                    meta: [...(detail ? [detail] : []), ...summary.meta],
                },
                body,
                tone: summary.tone,
            };
        },
        renderCall(args: unknown, _options: unknown, theme: Theme): Text {
            const detail = subject(verb, args);
            return new Text(
                `${theme.fg('toolTitle', theme.bold(label))} ${theme.fg('accent', target(args))}${detail ? ` ${theme.fg('muted', detail)}` : ''}`,
                0,
                0,
            );
        },
        renderResult(result: AgentToolResult<MacDetails>, _options: unknown, theme: Theme): Text {
            const summary = summarize(result);
            const color = summary.tone === 'neutral' ? 'toolOutput' : summary.tone;
            const lines = [
                summary.meta.join(' · '),
                ...summary.facts.map(([key, value]) => `${key}: ${value}`),
                summary.message,
            ].filter(line => line !== undefined && line.length > 0);
            return new Text(theme.fg(color, lines.join('\n')), 0, 0);
        },
    };
}

// OMP runs a turn's tool calls concurrently; a read issued after a click in
// the same turn must see the click, so calls for one app run in issue order.
const lanes = new Map<string, Promise<unknown>>();

function inLane<T>(app: string, run: () => Promise<T>): Promise<T> {
    const next = (lanes.get(app) ?? Promise.resolve()).then(run, run);
    const settled = next.then(
        () => undefined,
        () => undefined,
    );
    lanes.set(app, settled);
    void settled.then(() => {
        if (lanes.get(app) === settled) lanes.delete(app);
    });
    return next;
}

const IDLE_MS = 60_000;

type Reply = { line: string } | { exited: string } | { aborted: true };

// One warm python per app answers that app's calls in order, so a call
// skips the import, the MacOS setup and the pointer helper's restart.
class Driver {
    private readonly child: ChildProcessWithoutNullStreams;
    private buffer = '';
    private stderr = '';
    private waiting?: (reply: Reply) => void;
    private idle?: NodeJS.Timeout;

    constructor(private readonly forget: () => void) {
        this.child = spawn(python, [driver], { stdio: 'pipe' });
        this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            this.buffer += chunk;
            for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
                const line = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end + 1);
                this.settle({ line });
            }
        });
        this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            this.stderr = (this.stderr + chunk).slice(-4000);
        });
        this.child.stdin.on('error', () => undefined);
        this.child.on('error', error => {
            this.retire();
            this.settle({ exited: error.message });
        });
        this.child.on('close', () => {
            this.retire();
            this.settle({ exited: this.stderr.trim() });
        });
        this.child.unref();
    }

    request(line: string, signal: AbortSignal | undefined): Promise<Reply> {
        clearTimeout(this.idle);
        const { promise, resolve } = Promise.withResolvers<Reply>();
        const abort = () => {
            this.stop();
            resolve({ aborted: true });
        };
        if (signal?.aborted) {
            abort();
            return promise;
        }
        signal?.addEventListener('abort', abort, { once: true });
        this.waiting = reply => {
            signal?.removeEventListener('abort', abort);
            if ('line' in reply) {
                this.idle = setTimeout(() => this.stop(), IDLE_MS);
                this.idle.unref();
            }
            resolve(reply);
        };
        this.child.stdin.write(`${line}\n`);
        return promise;
    }

    private settle(reply: Reply): void {
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting?.(reply);
    }

    private retire(): void {
        clearTimeout(this.idle);
        this.forget();
    }

    private stop(): void {
        this.retire();
        this.waiting = undefined;
        this.child.kill('SIGTERM');
        setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
    }
}

const drivers = new Map<string, Driver>();

function driverFor(app: string): Driver {
    let found = drivers.get(app);
    if (!found) {
        const created: Driver = new Driver(() => {
            if (drivers.get(app) === created) drivers.delete(app);
        });
        found = created;
        drivers.set(app, created);
    }
    return found;
}

async function invoke(request: DriverRequest, signal: AbortSignal | undefined): Promise<Envelope> {
    if (request.expect?.state === 'equals' && request.expect.value === undefined) {
        throw new Error('An equals expectation requires value.');
    }
    const reply = await inLane(request.app, () =>
        driverFor(request.app).request(JSON.stringify(request), signal),
    );
    if ('aborted' in reply || signal?.aborted) {
        const action = ['press', 'click', 'type', 'key'].includes(request.verb);
        throw new Error(
            action
                ? 'Mac input was interrupted. Whether input was sent is unknown. Run mac_state or mac_see before retrying.'
                : 'Mac observation was interrupted.',
        );
    }
    if ('exited' in reply) throw new Error(`Mac harness exited without a result. ${reply.exited}`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(reply.line);
    } catch {
        throw new Error(`Mac harness answered without a valid result. ${reply.line}`);
    }
    const envelope = object(parsed);
    if (envelope?.ok === false && object(envelope.error)) return { ok: false, data: envelope };
    const data = object(envelope?.result);
    if (envelope?.ok !== true || !data) {
        throw new Error(`Mac harness answered without a successful result. ${reply.line}`);
    }
    return { ok: true, data };
}

async function result(
    request: DriverRequest,
    signal: AbortSignal | undefined,
): Promise<AgentToolResult<MacDetails>> {
    const envelope = await invoke(request, signal);
    const { data } = envelope;
    let kind: ResultKind = 'error';
    if (envelope.ok) {
        kind = ['see', 'state', 'query', 'handoff'].includes(request.verb)
            ? (request.verb as ResultKind)
            : 'receipt';
    }
    const details: MacDetails = { kind, app: request.app, data };
    if (kind === 'see') {
        const path = string(data.path);
        if (!path) throw new Error('Mac harness returned a screenshot without its PNG path.');
        const image = await readFile(path);
        details.mediaPath = path;
        return {
            content: [
                {
                    type: 'text',
                    text: `Window capture. Use this PNG path as screenshot for pixel clicks.\n${JSON.stringify(data)}`,
                },
                { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
            ],
            details,
        };
    }
    if (kind === 'state') {
        return { content: [{ type: 'text', text: string(data.text) ?? '' }], details };
    }
    const summary =
        kind === 'handoff'
            ? string(data.prompt)
            : kind === 'receipt'
              ? string(data.summary)
              : undefined;
    return {
        content: [
            { type: 'text', text: `${summary ? `${summary}\n` : ''}${JSON.stringify(data)}` },
        ],
        details,
        isError: !envelope.ok,
    };
}

export function registerMacHarness(api: ExtensionAPI): void {
    const z = api.zod;
    const app = z
        .string()
        .min(1)
        .describe('Explicit running app name, bundle id, path, or decimal process id.');
    const windowId = z
        .number()
        .int()
        .positive()
        .describe('Window id belonging to the target app.')
        .optional();
    const timeout = z
        .number()
        .positive()
        .describe('Harness operation deadline in seconds.')
        .optional();
    const selectors = {
        text: z.string().describe('Text matched against the element labels.').optional(),
        role: z.string().describe('Accessibility role, such as AXButton.').optional(),
        title: z.string().describe('Element title.').optional(),
        identifier: z.string().describe('Accessibility identifier.').optional(),
        description: z.string().describe('Accessibility description.').optional(),
    };
    const expect = z
        .object({
            state: z.enum(['present', 'gone', 'equals']),
            ...selectors,
            value: z
                .union([z.string(), z.number(), z.boolean()])
                .describe('Required for equals.')
                .optional(),
            attribute: z
                .string()
                .describe('Attribute compared by equals; defaults to AXValue.')
                .optional(),
        })
        .describe('Optional condition verified in the target app after input.')
        .optional();

    api.registerTool({
        name: 'mac_see',
        label: 'See app',
        description:
            'Capture a native Mac app window without activating it. Returns the actual PNG image, window state, and the screenshot path used by mac_click. An off-screen window shows only what the app last drew. Use Safari tools for web pages.',
        approval: 'read',
        parameters: z.object({
            app,
            window_index: z
                .number()
                .int()
                .nonnegative()
                .describe('Window index, default 0; do not combine a nonzero index with window_id.')
                .optional(),
            window_id: windowId,
            crop: z
                .object({
                    x: z.number(),
                    y: z.number(),
                    width: z.number().positive(),
                    height: z.number().positive(),
                })
                .describe('Crop in window points, not screenshot pixels.')
                .optional(),
            zoom: z
                .number()
                .positive()
                .describe('Pixels per window point, still bounded to 1280 × 1280.')
                .optional(),
        }),
        ...presentation('See app', 'see'),
        async execute(_toolCallId, { app: targetApp, crop, ...args }, signal, _onUpdate, ctx) {
            return result(
                {
                    verb: 'see',
                    app: targetApp,
                    agent_id: macAgentId(ctx),
                    args: {
                        ...args,
                        crop: crop ? [crop.x, crop.y, crop.width, crop.height] : undefined,
                    },
                },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_state',
        label: 'Read app',
        description:
            'Read one native Mac app window as compact text, one control per line like [12] button "Save", without activating it. Prefer this to mac_see: it costs a fraction of a screenshot, and later reads print only what changed since your last one. Pass an id to mac_click as state_id. Use query to print only lines mentioning a word, from the whole window. Calls for one app run in the order you issue them, so one turn can hold several actions and end with mac_state. Take mac_see only when the text lacks what you need (images, layout, canvas apps). Use Safari tools for web pages.',
        approval: 'read',
        parameters: z.object({
            app,
            query: z
                .string()
                .min(1)
                .describe('Only lines mentioning this text, with their ancestors.')
                .optional(),
            window_id: windowId,
            diff: z
                .boolean()
                .describe('Default true; false prints the whole window, as after context loss.')
                .optional(),
        }),
        ...presentation('Read app', 'state'),
        async execute(_toolCallId, { app: targetApp, ...args }, signal, _onUpdate, ctx) {
            return result(
                { verb: 'state', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_query',
        label: 'Find controls',
        description:
            'Read native Accessibility controls in one explicit Mac app without activating it. Returns element matches reusable as mac_click.element. complete=false means the search did not read the whole app. Use Safari tools for web pages.',
        approval: 'read',
        parameters: z.object({
            app,
            ...selectors,
            limit: z.number().int().positive().describe('Maximum matches, default 20.').optional(),
            visible_only: z.boolean().describe('Only visible controls, default true.').optional(),
        }),
        ...presentation('Find controls', 'query'),
        async execute(_toolCallId, { app: targetApp, ...args }, signal, _onUpdate, ctx) {
            return result(
                { verb: 'query', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_press',
        label: 'Press control',
        description: `Press one uniquely matched native Accessibility control. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({ app, ...selectors, timeout, expect }),
        ...presentation('Press control', 'press'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            return result(
                {
                    verb: 'press',
                    app: targetApp,
                    agent_id: macAgentId(ctx),
                    args,
                    expect: condition,
                },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_click',
        label: 'Click app',
        description: `Click a mac_state id (state_id), a mac_query element match, or screenshot pixels using x, y, and the PNG path returned by mac_see. A menu, popover, or panel needs its own window_id. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            x: z.number().describe('X coordinate in the screenshot image.').optional(),
            y: z.number().describe('Y coordinate in the screenshot image.').optional(),
            screenshot: z
                .string()
                .min(1)
                .describe('PNG path from mac_see; required for x/y clicks.')
                .optional(),
            element: z
                .record(z.unknown())
                .describe('An entire match returned by mac_query.')
                .optional(),
            state_id: z
                .number()
                .int()
                .nonnegative()
                .describe('An id from the last mac_state of this app.')
                .optional(),
            window_id: windowId,
            button: z.enum(['left', 'right', 'middle']).optional(),
            clicks: z.number().int().min(1).max(3).optional(),
            timeout,
            expect,
        }),
        ...presentation('Click app', 'click'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            if (
                !args.element &&
                args.state_id === undefined &&
                (args.x === undefined || args.y === undefined || !args.screenshot)
            ) {
                throw new Error(
                    'Provide a mac_state id, a mac_query element match, or x and y together with the screenshot path from mac_see.',
                );
            }
            return result(
                {
                    verb: 'click',
                    app: targetApp,
                    agent_id: macAgentId(ctx),
                    args,
                    expect: condition,
                },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_type',
        label: 'Type in app',
        description: `Type non-secret text into the target app's focused control. Never put passwords, passkeys, one-time codes, or other secrets in this tool's arguments. Follow skill://macos-harness for credential input and human-only handoff. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            text: z.string().max(4096),
            window_id: windowId,
            timeout,
            expect,
        }),
        ...presentation('Type in app', 'type'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            return result(
                {
                    verb: 'type',
                    app: targetApp,
                    agent_id: macAgentId(ctx),
                    args,
                    expect: condition,
                },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_key',
        label: 'Send key',
        description: `Send one key or shortcut to a native app. Join modifiers with + or -, such as cmd+n or cmd+shift+t; named keys include return and escape. Use mac_type for text, not mac_key. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({ app, key: z.string().min(1), window_id: windowId, timeout, expect }),
        ...presentation('Send key', 'key'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            return result(
                { verb: 'key', app: targetApp, agent_id: macAgentId(ctx), args, expect: condition },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_handoff',
        label: 'Ask for sign-in',
        description:
            'Return the human-only handoff for native app authentication or account recovery. Does not type, activate, or attempt to pass the boundary. Show the returned prompt to the user and stop automation at that boundary.',
        approval: 'read',
        parameters: z.object({
            app,
            reason: z.enum(['authentication_required', 'account_recovery_required']),
        }),
        ...presentation('Ask for sign-in', 'handoff'),
        async execute(_toolCallId, { app: targetApp, ...args }, signal, _onUpdate, ctx) {
            return result(
                { verb: 'handoff', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });
}
