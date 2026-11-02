import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { kv, Text, text } from '@oh-my-pi/pi-tui';
import type { Theme } from '@oh-my-pi/pi-tui/theme';
import type { NativeToolView } from '@oh-my-pi/pi-tui/tools/renderer';

type MacVerb = 'see' | 'query' | 'handoff' | 'press' | 'click' | 'type' | 'key';
type ResultKind = 'see' | 'query' | 'handoff' | 'receipt' | 'error';
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
    'Does not activate the app or move the physical pointer. Never retry an action whose receipt says acted=yes or unknown before checking mac_see or mac_query.';

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
    if (verb === 'see')
        return values.window_id === undefined ? '' : `window ${display(values.window_id)}`;
    if (verb === 'handoff') return string(values.reason)?.replaceAll('_', ' ') ?? '';
    if (verb === 'click') {
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

async function invoke(
    api: ExtensionAPI,
    request: DriverRequest,
    signal: AbortSignal | undefined,
): Promise<Envelope> {
    if (request.expect?.state === 'equals' && request.expect.value === undefined) {
        throw new Error('An equals expectation requires value.');
    }
    const execution = await api.exec(python, [driver, JSON.stringify(request)], { signal });
    if (execution.killed || signal?.aborted) {
        const action = ['press', 'click', 'type', 'key'].includes(request.verb);
        throw new Error(
            action
                ? 'Mac input was interrupted. Whether input was sent is unknown. Run mac_see or mac_query before retrying.'
                : 'Mac observation was interrupted.',
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(execution.stdout);
    } catch {
        throw new Error(
            `Mac harness exited ${execution.code} without a valid result. ${execution.stderr.trim() || execution.stdout.trim()}`,
        );
    }
    const envelope = object(parsed);
    if (envelope?.ok === false && object(envelope.error)) return { ok: false, data: envelope };
    const data = object(envelope?.result);
    if (execution.code !== 0 || envelope?.ok !== true || !data) {
        throw new Error(
            `Mac harness exited ${execution.code} without a successful result. ${execution.stderr.trim() || execution.stdout.trim()}`,
        );
    }
    return { ok: true, data };
}

async function result(
    api: ExtensionAPI,
    request: DriverRequest,
    signal: AbortSignal | undefined,
): Promise<AgentToolResult<MacDetails>> {
    const envelope = await invoke(api, request, signal);
    const { data } = envelope;
    let kind: ResultKind = 'error';
    if (envelope.ok) {
        kind =
            request.verb === 'see' || request.verb === 'query' || request.verb === 'handoff'
                ? request.verb
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
                api,
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
                api,
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
                api,
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
        description: `Click a mac_query element match, or screenshot pixels using x, y, and the PNG path returned by mac_see. A menu, popover, or panel needs its own window_id. ${actionNote}`,
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
                (args.x === undefined || args.y === undefined || !args.screenshot)
            ) {
                throw new Error(
                    'Provide a mac_query element match, or x and y together with the screenshot path from mac_see.',
                );
            }
            return result(
                api,
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
                api,
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
                api,
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
                api,
                { verb: 'handoff', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });
}
