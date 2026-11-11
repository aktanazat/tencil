import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { kv, Text, text } from '@oh-my-pi/pi-tui';
import type { Theme } from '@oh-my-pi/pi-tui/theme';
import type { NativeToolView } from '@oh-my-pi/pi-tui/tools/renderer';

type MacVerb =
    | 'see'
    | 'state'
    | 'query'
    | 'handoff'
    | 'press'
    | 'click'
    | 'type'
    | 'key'
    | 'script'
    | 'route'
    | 'menus'
    | 'menu'
    | 'sdef'
    | 'paste'
    | 'open_files'
    | 'steps'
    | 'data'
    | 'shortcut';
type ResultKind =
    | 'see'
    | 'state'
    | 'query'
    | 'handoff'
    | 'receipt'
    | 'script'
    | 'route'
    | 'menus'
    | 'sdef'
    | 'steps'
    | 'data'
    | 'shortcut'
    | 'error';
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
// Data reads and shortcuts belong to no app; they share one driver lane.
const DATA_LANE = 'mac data';
const RECEIPT_VERBS: readonly MacVerb[] = [
    'press',
    'click',
    'type',
    'key',
    'menu',
    'paste',
    'open_files',
];

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
    if (verb === 'menus' || verb === 'menu') return string(values.text) ?? '';
    if (verb === 'sdef') return '';
    if (verb === 'paste' || verb === 'open_files') {
        const value = string(values.text);
        const files = Array.isArray(values.files) ? values.files.length : 0;
        if (value !== undefined) return `${value.length} characters`;
        return files ? `${files} files` : 'rich text';
    }
    if (verb === 'script') return string(values.language) ?? 'AppleScript';
    if (verb === 'steps') return Array.isArray(values.steps) ? `${values.steps.length} steps` : '';
    if (verb === 'data') return string(values.action) ?? '';
    if (verb === 'shortcut') return string(values.name) ?? '';
    if (verb === 'route')
        return [values.action, values.name].filter(value => typeof value === 'string').join(' ');
    if (verb === 'see' || verb === 'state')
        return values.window_id === undefined
            ? (string(values.query) ?? '')
            : `window ${display(values.window_id)}`;
    if (verb === 'handoff') return string(values.reason)?.replaceAll('_', ' ') ?? '';
    if (typeof values.state_id === 'number') return `[${values.state_id}]`;
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

function replayNote(app: string, run: Record<string, unknown>): string {
    const steps = Array.isArray(run.steps_run) ? run.steps_run.map(object) : [];
    if (run.status === 'done') {
        const seconds =
            typeof run.duration_s === 'number' ? ` in ${run.duration_s.toFixed(2)}s` : '';
        return `Replayed ${steps.length} steps${seconds}; the goal holds.`;
    }
    if (run.status === 'already') return 'The goal already holds, so nothing ran.';
    const error = object(run.error) ?? {};
    const reason = string(error.message) ?? display(error.code);
    if (run.status !== 'diverged') {
        return `The route did not run: ${reason}. mac_route list shows the routes saved for ${app}.`;
    }
    const at = string(run.at) ?? '';
    const index = /^steps\[(\d+)\]$/.exec(at)?.[1];
    const step = index === undefined ? undefined : steps[Number(index)];
    const request =
        object(
            index === undefined ? object(object(run.check)?.request)?.condition : step?.request,
        ) ??
        object(object(error.details)?.query) ??
        {};
    const label = [request.title, request.description, request.identifier].find(
        value => typeof value === 'string' && value.length > 0,
    );
    const place =
        index !== undefined
            ? `step ${Number(index) + 1} did not confirm (it acted: ${display(step?.acted ?? 'no')}), after the steps before it ran`
            : at === 'entry'
              ? `${app} is not where the route starts, so no step ran`
              : at === 'goal'
                ? steps.length
                    ? 'every step ran, but the goal does not hold'
                    : 'the goal could not be checked, so no step ran'
                : `${app} is not the app the route was recorded in, so no step ran`;
    return `Replay stopped: ${place}. ${reason}. Read ${app} with mac_state${label ? ` (query "${display(label)}")` : ''} before acting, and replay only from the route's start.`;
}

function routeNote(app: string, data: Record<string, unknown>): string {
    if (typeof data.watching === 'string') {
        return `Watching ${data.watching}: ask the person to do the task by hand in ${app} at an easy pace and press Control-Option-Command-Period when done; the route is saved then. Call mac_route stop for the result; calling it earlier ends the watch at once.`;
    }
    const watch = object(data.watch);
    if (watch) {
        const steps = Array.isArray(watch.steps) ? watch.steps.length : 0;
        return watch.status === 'saved'
            ? `Saved ${display(watch.name)} with ${steps} steps; mac_route run replays it in one call.`
            : `Not saved: ${string(object(watch.error)?.message) ?? display(watch.stopped_by)}`;
    }
    if (typeof data.recording === 'string') {
        return `Recording ${data.recording}: your mac_press and mac_key calls on ${app} are saved as its steps, each with its expect, until mac_route save.`;
    }
    if (typeof data.saved === 'string') {
        return `Saved ${data.saved} with ${display(data.steps)} steps; mac_route run replays it in one call.`;
    }
    if (typeof data.cancelled === 'string') {
        return `Dropped the recording ${data.cancelled}; nothing was saved.`;
    }
    if (Array.isArray(data.routes)) {
        const lines = data.routes.map(route => {
            const item = object(route) ?? {};
            const inputs =
                Array.isArray(item.inputs) && item.inputs.length
                    ? `, inputs ${item.inputs.join(', ')}`
                    : '';
            return `${display(item.name)}: ${display(item.steps)} steps${inputs}`;
        });
        return lines.length ? lines.join('\n') : `No routes saved for ${app}.`;
    }
    const run = object(data.run) ?? {};
    if (run.status === 'handoff') {
        const index = /^steps\[(\d+)\]$/.exec(string(run.at) ?? '')?.[1];
        const step = index === undefined ? '' : ` at step ${Number(index) + 1}`;
        return `Replay stopped${step} for the person: ${string(data.prompt) ?? 'they must finish this step by hand'}`;
    }
    return replayNote(app, run);
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
    if (kind === 'state' || kind === 'script') {
        const lines = (string(kind === 'state' ? data.text : data.output) ?? '').split('\n');
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
    if (kind === 'menus') {
        const matches = Array.isArray(data.matches) ? data.matches.map(object) : [];
        const lines = matches.map(
            item =>
                `${display(item?.path)}${item?.shortcut ? ` (${display(item.shortcut)})` : ''}${item?.enabled === false ? ' · disabled' : ''}`,
        );
        return {
            meta: [`${matches.length} items`],
            facts: [],
            message: lines.length ? lines.join('\n') : 'No menu item matches.',
            tone: 'neutral',
        };
    }
    if (kind === 'sdef') {
        const count = (key: string) => {
            const value = data[key];
            return Array.isArray(value) ? value.length : Object.keys(object(value) ?? {}).length;
        };
        return {
            meta: [`${count('commands')} commands`, `${count('classes')} classes`],
            facts: [],
            tone: 'neutral',
        };
    }
    if (kind === 'steps') {
        const run = object(data.steps);
        const stopped = run?.status !== 'done';
        return {
            meta: [
                stopped
                    ? `stopped at step ${display(run?.stopped_at)}`
                    : `${display(run?.steps)} steps`,
            ],
            facts: [],
            message: string(data.summary),
            tone: stopped ? 'error' : 'success',
        };
    }
    if (kind === 'data' || kind === 'shortcut') {
        const found = data.data;
        return {
            meta: Array.isArray(found) ? [`${found.length} items`] : [],
            facts: [],
            tone: 'neutral',
        };
    }
    if (kind === 'route') {
        const run = object(data.run);
        return {
            meta: run ? [display(run.status)] : [],
            facts: [],
            message: routeNote(details.app, data),
            tone:
                run?.status === 'handoff'
                    ? 'warning'
                    : (run && run.status !== 'done' && run.status !== 'already') ||
                        object(data.watch)?.status === 'unsaved'
                      ? 'error'
                      : 'neutral',
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

type Reply = { line: string; value: unknown } | { exited: string } | { aborted: true };

function parse(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

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
                this.settle({ line, value: parse(line) });
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
                // An open route recording lives in this process; idling out would drop it.
                const hold = object(reply.value)?.hold;
                this.idle = setTimeout(
                    () => this.stop(),
                    typeof hold === 'number' ? Math.max(IDLE_MS, hold * 1000) : IDLE_MS,
                );
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
    const { args } = request;
    if (
        request.verb === 'click' &&
        !args.element &&
        args.state_id === undefined &&
        (args.x === undefined || args.y === undefined || !args.screenshot)
    ) {
        throw new Error(
            'Provide a mac_state id, a mac_query element match, or x and y together with the screenshot path from mac_see.',
        );
    }
    const reply = await driverFor(request.app).request(JSON.stringify(request), signal);
    if ('aborted' in reply || signal?.aborted) {
        const action = ['script', 'route', 'steps', 'shortcut', ...RECEIPT_VERBS].includes(
            request.verb,
        );
        throw new Error(
            action
                ? 'Mac input was interrupted. Whether input was sent is unknown. Run mac_state or mac_see before retrying.'
                : 'Mac observation was interrupted.',
        );
    }
    if ('exited' in reply) throw new Error(`Mac harness exited without a result. ${reply.exited}`);
    const envelope = object(reply.value);
    if (envelope?.ok === false && object(envelope.error)) {
        return { ok: false, data: { ok: false, error: envelope.error, receipt: envelope.receipt } };
    }
    const data = object(envelope?.result);
    if (envelope?.ok !== true || !data) {
        throw new Error(`Mac harness answered without a valid result. ${reply.line}`);
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
        kind = RECEIPT_VERBS.includes(request.verb) ? 'receipt' : (request.verb as ResultKind);
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
    if (kind === 'script') {
        const output = string(data.output) ?? '';
        return {
            content: [
                { type: 'text', text: output.length ? output : 'The script printed nothing.' },
            ],
            details,
        };
    }
    if (kind === 'menus' || kind === 'sdef') {
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details };
    }
    if (kind === 'data' || kind === 'shortcut') {
        return { content: [{ type: 'text', text: JSON.stringify(data.data) }], details };
    }
    if (kind === 'steps') {
        return {
            content: [{ type: 'text', text: string(data.summary) ?? JSON.stringify(data) }],
            details,
            isError: object(data.steps)?.status !== 'done',
        };
    }
    if (kind === 'route') {
        const run = object(data.run);
        const stopped = run !== undefined && run.status !== 'done' && run.status !== 'already';
        const unsaved = object(data.watch)?.status === 'unsaved';
        const steps = Array.isArray(data.steps) ? data.steps.join('\n') : '';
        return {
            content: [
                {
                    type: 'text',
                    text: [
                        routeNote(request.app, data),
                        stopped
                            ? JSON.stringify(run)
                            : unsaved
                              ? JSON.stringify(data.watch)
                              : steps,
                    ]
                        .filter(Boolean)
                        .join('\n'),
                },
            ],
            details,
            isError: stopped || unsaved,
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

interface Batch {
    pending: number;
    issued: number;
    stopAfter: number;
    failed: string;
    ran: string[];
}

// A failed call stops the calls the same agent queued behind it for that
// app, as a computer-use batch stops at its first failed action. A call
// issued after the failure runs.
const batches = new Map<string, Batch>();

// While the person does a task by hand, an agent's input anywhere would land in or
// disturb it; the driver alone cannot see another spelling of the app.
const watching = new Map<string, string>();
const WATCH_REFUSED = new Set<string>([...RECEIPT_VERBS, 'script', 'steps', 'shortcut']);

function failure(result: AgentToolResult<MacDetails>): string | undefined {
    const data = result.details?.data ?? {};
    const receipt = object(data.receipt);
    if (!result.isError && receipt?.outcome !== 'failed') return undefined;
    if (object(data.run)?.status === 'handoff') return 'handoff';
    return (
        string(object(data.error ?? object(data.run)?.error ?? object(data.steps)?.error)?.code) ??
        'error'
    );
}

function notRun(request: DriverRequest, batch: Batch): AgentToolResult<MacDetails> {
    const message = `Not run: ${batch.failed} earlier in this turn, so this ${request.verb} for ${request.app} was skipped. Ran in order: ${batch.ran.join('; ')}. Read ${request.app} with mac_state before acting again.`;
    return {
        content: [{ type: 'text', text: message }],
        details: { kind: 'error', app: request.app, data: { error: { code: 'not_run', message } } },
        isError: true,
    };
}

async function queued(
    request: DriverRequest,
    signal: AbortSignal | undefined,
): Promise<AgentToolResult<MacDetails>> {
    const action = string(request.args.action);
    const watched = watching.get(request.agent_id);
    if (
        watched !== undefined &&
        (WATCH_REFUSED.has(request.verb) ||
            (request.verb === 'route' && action !== 'list' && action !== 'stop'))
    ) {
        const message = `The person is doing a task by hand in ${watched}; mac_route stop on ${watched} ends the watch first.`;
        return {
            content: [{ type: 'text', text: message }],
            details: {
                kind: 'error',
                app: request.app,
                data: { error: { code: 'watching', message } },
            },
            isError: true,
        };
    }
    const key = `${request.agent_id}\n${request.app}`;
    const batch = batches.get(key) ?? { pending: 0, issued: 0, stopAfter: 0, failed: '', ran: [] };
    batches.set(key, batch);
    batch.pending += 1;
    const index = ++batch.issued;
    const call = [request.verb, subject(request.verb, request.args)].filter(Boolean).join(' ');
    const settle = (status: string, failed: boolean) => {
        batch.ran.push(`${call} ${status}`);
        if (!failed) return;
        batch.failed = `${call} ${status}`;
        batch.stopAfter = batch.issued;
    };
    try {
        return await inLane(request.app, async () => {
            if (index <= batch.stopAfter && request.verb !== 'data') return notRun(request, batch);
            let answer: AgentToolResult<MacDetails>;
            try {
                answer = await result(request, signal);
            } catch (error) {
                settle('failed', true);
                throw error;
            }
            const code = failure(answer);
            settle(
                code === undefined
                    ? (string(object(answer.details?.data.receipt)?.outcome) ?? 'ok')
                    : `failed (${code})`,
                code !== undefined,
            );
            if (request.verb === 'route' && action === 'stop') watching.delete(request.agent_id);
            if (typeof answer.details?.data.watching === 'string') {
                watching.set(request.agent_id, request.app);
            }
            return answer;
        });
    } finally {
        batch.pending -= 1;
        if (batch.pending === 0) batches.delete(key);
    }
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
    const condition = z.object({
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
    });
    const expect = condition
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
            return queued(
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
            'Read one native Mac app window as compact text, one control per line like [12] button "Save", without activating it. Prefer this to mac_see: it costs a fraction of a screenshot, and later reads print only what changed since your last one. Act on a line by passing its id as state_id to mac_press, or to mac_click for controls without a press. Use query to print only lines mentioning a word, from the whole window. Calls for one app run in the order you issue them, so one turn can hold several actions and end with mac_state; when one fails, the calls after it in that turn are not run. Take mac_see only when the text lacks what you need (images, layout, canvas apps). Use Safari tools for web pages.',
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
            return queued(
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
            return queued(
                { verb: 'query', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_press',
        label: 'Press control',
        description: `Press a control by its mac_state id (state_id), or one control uniquely matched by selectors. Prefer state_id: it skips the search and works in background windows, while a name mac_state prints may be a title or a description. While a mac_route recording is open, the press is saved as a step and needs expect. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            ...selectors,
            state_id: z
                .number()
                .int()
                .nonnegative()
                .describe(
                    "An id from the last mac_state of this app's window; use no selector with it.",
                )
                .optional(),
            window_id: windowId.describe(
                'With state_id: the window_id of the mac_state the id came from, when that was not the focused window.',
            ),
            timeout,
            expect,
        }),
        ...presentation('Press control', 'press'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            return queued(
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
            return queued(
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
            return queued(
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
        description: `Send one key or shortcut to a native app. Join modifiers with + or -, such as cmd+n or cmd+shift+t; named keys include return and escape. Use mac_type for text, not mac_key. While a mac_route recording is open, the key is saved as a step and needs expect. ${actionNote}`,
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
            return queued(
                { verb: 'key', app: targetApp, agent_id: macAgentId(ctx), args, expect: condition },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_script',
        label: 'Run script',
        description:
            'Run AppleScript or JavaScript for Automation and return what it printed. For an app mac_state calls scriptable, one script that reads or changes its data usually replaces a series of clicks, and it returns the data itself. Name the app inside the script, as in tell application "Finder"; app orders this call with your other calls for that app. A script still running after timeout seconds (default 15), as when it waits on a dialog or a permission prompt, is stopped.',
        approval: 'exec',
        parameters: z.object({
            app,
            source: z.string().min(1).describe('The script.'),
            language: z
                .enum(['AppleScript', 'JavaScript'])
                .describe('Default AppleScript.')
                .optional(),
            timeout: z
                .number()
                .positive()
                .describe('Seconds before the script is stopped, default 15.')
                .optional(),
        }),
        ...presentation('Run script', 'script'),
        async execute(_toolCallId, { app: targetApp, ...args }, signal, _onUpdate, ctx) {
            return queued(
                { verb: 'script', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_route',
        label: 'Saved route',
        description:
            "Save presses and keys in one app as a named route while you do a task once, then replay it later in one call. record starts a recording: give name, entry (true now) and goal (true once done, not now), each naming a control by role and one exact title, description or identifier. Until save, your mac_press and mac_key calls on this app are saved as steps and each needs such an expect; mac_click, mac_type, mac_script, mac_steps and mac_shortcut calls on it are refused. save checks the goal and writes the route, cancel drops it, and a recording closes after 10 minutes. watch takes the same name, entry and goal and learns the route while the person does the task by hand; the route is saved as soon as the person finishes if its goal holds, stop ends the watch and returns the result, and your input calls and routes on every app are refused until stop. Text typed into a password field is never saved: replay stops there and hands that step to the person. run replays a saved route and stops at the first step that does not confirm; list shows this app's routes.",
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            action: z.enum(['record', 'save', 'cancel', 'run', 'list', 'watch', 'stop']),
            name: z
                .string()
                .regex(/^[a-z0-9-]{1,64}$/)
                .describe(
                    'Route name for record, watch and run: lowercase letters, digits and hyphens.',
                )
                .optional(),
            entry: condition
                .describe('record or watch: true now, before the first step.')
                .optional(),
            goal: condition
                .describe('record or watch: true once the route is done, and false now.')
                .optional(),
            inputs: z
                .record(z.string(), z.string())
                .describe('run: text for each input the route lists; never secrets.')
                .optional(),
            timeout: z
                .number()
                .positive()
                .max(3600)
                .describe(
                    'run: seconds for the whole replay, default 30; watch: seconds the person has, default 300.',
                )
                .optional(),
        }),
        ...presentation('Saved route', 'route'),
        async execute(_toolCallId, { app: targetApp, ...args }, signal, _onUpdate, ctx) {
            return queued(
                { verb: 'route', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_menus',
        label: 'Search menus',
        description:
            "Find menu bar items of a native Mac app by words, at any depth, without opening a menu. Returns each item's path, whether it is enabled, and its shortcut. The first read of an app's menus takes up to a few seconds and is kept until the app updates. mac_menu chooses the best match.",
        approval: 'read',
        parameters: z.object({
            app,
            text: z.string().min(1).describe('Words of the item title or its menu path.'),
            limit: z.number().int().positive().describe('Maximum items, default 10.').optional(),
        }),
        ...presentation('Search menus', 'menus'),
        async execute(_toolCallId, { app: targetApp, ...args }, signal, _onUpdate, ctx) {
            return queued(
                { verb: 'menus', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_menu',
        label: 'Choose menu item',
        description: `Choose the menu item of a native Mac app that best matches text, at any depth, as mac_menus ranks it: by its shortcut when it has one and the app is in front, else by pressing it. Refuses when two items tie or the best match opens a submenu. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            text: z.string().min(1).describe('Words of the item title or its menu path.'),
            timeout,
            expect,
        }),
        ...presentation('Choose menu item', 'menu'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            return queued(
                {
                    verb: 'menu',
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
        name: 'mac_sdef',
        label: 'Scripting dictionary',
        description:
            'List the AppleScript commands, classes and enumerations a Mac app takes, read from its bundle without launching it. Read it before writing a mac_script for an app you have not scripted. Fails for an app with no dictionary.',
        approval: 'read',
        parameters: z.object({ app }),
        ...presentation('Scripting dictionary', 'sdef'),
        async execute(_toolCallId, { app: targetApp }, signal, _onUpdate, ctx) {
            return queued(
                { verb: 'sdef', app: targetApp, agent_id: macAgentId(ctx), args: {} },
                signal,
            );
        },
    });

    const files = z.array(z.string().min(1)).min(1).describe('Absolute paths of existing files.');

    api.registerTool({
        name: 'mac_paste',
        label: 'Paste in app',
        description: `Paste into the focused control of a native Mac app through the clipboard, then put the clipboard back as it was. Faster than mac_type for long text, and the only way to paste a rich table (html with tsv) or files. Give text, html, rtf, tsv or files. Works only while the app is in front; otherwise it refuses before touching the clipboard. The receipt's observed.input.pasteboard.restored says whether the clipboard went back. Never paste secrets. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            text: z.string().describe('Plain text.').optional(),
            html: z.string().describe('HTML, as a table or styled text.').optional(),
            rtf: z.string().describe('RTF source.').optional(),
            tsv: z.string().describe('Tab-separated rows for spreadsheets.').optional(),
            files: files.optional(),
            window_id: windowId,
            timeout,
            expect,
        }),
        ...presentation('Paste in app', 'paste'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            if (
                [args.text, args.html, args.rtf, args.tsv, args.files].every(v => v === undefined)
            ) {
                throw new Error('Give text, html, rtf, tsv or files to paste.');
            }
            return queued(
                {
                    verb: 'paste',
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
        name: 'mac_open_files',
        label: 'Open files',
        description: `Open files in a running native Mac app, as dropping them on its Dock icon does, without bringing it forward, then wait until its windows show them. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({
            app,
            files,
            timeout: z
                .number()
                .positive()
                .describe('Seconds to wait for the windows, default 10.')
                .optional(),
            expect,
        }),
        ...presentation('Open files', 'open_files'),
        async execute(
            _toolCallId,
            { app: targetApp, expect: condition, ...args },
            signal,
            _onUpdate,
            ctx,
        ) {
            return queued(
                {
                    verb: 'open_files',
                    app: targetApp,
                    agent_id: macAgentId(ctx),
                    args,
                    expect: condition,
                },
                signal,
            );
        },
    });

    const stateId = z
        .number()
        .int()
        .nonnegative()
        .describe("An id from the last mac_state of this app's window, read before this call.")
        .optional();
    const step = z.union([
        z.object({
            op: z.literal('press'),
            ...selectors,
            state_id: stateId,
            window_id: windowId,
            timeout,
            expect,
        }),
        z.object({
            op: z.literal('click'),
            x: z.number().optional(),
            y: z.number().optional(),
            screenshot: z.string().min(1).optional(),
            element: z.record(z.unknown()).optional(),
            state_id: stateId,
            window_id: windowId,
            button: z.enum(['left', 'right', 'middle']).optional(),
            clicks: z.number().int().min(1).max(3).optional(),
            timeout,
            expect,
        }),
        z.object({
            op: z.literal('type'),
            text: z.string().max(4096),
            window_id: windowId,
            timeout,
            expect,
        }),
        z.object({
            op: z.literal('key'),
            key: z.string().min(1),
            window_id: windowId,
            timeout,
            expect,
        }),
        z.object({ op: z.literal('menu'), text: z.string().min(1), timeout, expect }),
        z.object({
            op: z.literal('paste'),
            text: z.string().optional(),
            html: z.string().optional(),
            rtf: z.string().optional(),
            tsv: z.string().optional(),
            files: files.optional(),
            window_id: windowId,
            timeout,
            expect,
        }),
        z.object({ op: z.literal('open_files'), files, timeout, expect }),
        z.object({
            op: z.literal('expect'),
            expect: condition.describe('Wait until this holds before the next step.'),
        }),
    ]);

    api.registerTool({
        name: 'mac_steps',
        label: 'Run steps',
        description: `Send several actions to one native Mac app as one call, in order: each step is op (press, click, type, key, menu, paste, open_files or expect) with the arguments of that op's own mac tool, and an optional expect checked after it. Stops at the first step that fails and sends nothing after it; nothing is retried. Returns what changed in the app's focused window, and on a stop the step, the error, and picture files before and after it to open with read. state_id values come from one mac_state read before the call, so a control that appears mid-run is named by its label instead. Not while a mac_route recording is open. ${actionNote}`,
        approval: 'write',
        approvalCacheTargets: approvalTargets,
        parameters: z.object({ app, steps: z.array(step).min(1) }),
        ...presentation('Run steps', 'steps'),
        async execute(_toolCallId, { app: targetApp, steps }, signal, _onUpdate, ctx) {
            return queued(
                { verb: 'steps', app: targetApp, agent_id: macAgentId(ctx), args: { steps } },
                signal,
            );
        },
    });

    const path = z.string().min(1).describe('A file path; ~ is expanded.');
    const query = z.union([
        z.object({
            action: z.literal('find_files'),
            query: z.string().describe('Raw Spotlight query syntax.').optional(),
            name: z.string().describe('Part of the file name.').optional(),
            kind: z.string().describe('A content type, such as com.adobe.pdf.').optional(),
            content: z.string().describe('Text inside the file.').optional(),
            onlyin: z.array(z.string().min(1)).describe('Folders to search.').optional(),
            limit: z.number().int().positive().describe('Default 1000.').optional(),
            timeout: z.number().positive().describe('Seconds, default 10.').optional(),
        }),
        z.object({ action: z.literal('file_info'), path }),
        z.object({ action: z.literal('shortcuts') }),
        z.object({
            action: z.literal('read_defaults'),
            domain: z.string().min(1).describe('A bundle id or domain; -g is the global one.'),
            key: z.string().optional(),
            current_host: z.boolean().optional(),
        }),
        z.object({
            action: z.literal('query_sqlite'),
            path,
            sql: z.string().min(1).describe('One read statement; writes are refused.'),
            params: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
            immutable: z
                .boolean()
                .describe('Read a store no app has open without its lock.')
                .optional(),
        }),
        z.object({
            action: z.literal('wait_file'),
            path,
            contains: z.string().describe('Text the file must hold.').optional(),
            since: z.number().describe('Epoch seconds the file must be written after.').optional(),
            timeout: z.number().positive().describe('Seconds, default 10.').optional(),
        }),
    ]);

    api.registerTool({
        name: 'mac_data',
        label: 'Read Mac data',
        description:
            "Read Mac data straight from the system instead of an app's window: find_files searches Spotlight; file_info gives a file's kind, where it was downloaded from, and dates; shortcuts lists the user's Shortcuts; read_defaults reads an app's settings; query_sqlite runs one read on an app's database; wait_file waits until a save really reached disk. Reads only, and touches no app. A sandboxed app's settings fail as unsupported_op: read them from its window.",
        approval: 'read',
        parameters: z.object({ request: query }),
        ...presentation('Read Mac data', 'data'),
        async execute(_toolCallId, { request }, signal, _onUpdate, ctx) {
            return queued(
                {
                    verb: 'data',
                    app: DATA_LANE,
                    agent_id: macAgentId(ctx),
                    args: object(request) ?? {},
                },
                signal,
            );
        },
    });

    api.registerTool({
        name: 'mac_shortcut',
        label: 'Run shortcut',
        description:
            "Run one of the user's Shortcuts by name with no Shortcuts window, optionally on input files, and return what it wrote. A shortcut can act on any app or send messages: run only one the user named or mac_data shortcuts listed for this task. When it acts on an app, name it: app orders this call with your other calls for that app. When it needs a file mac_data wait_file is waiting for, call it only after that wait returns.",
        approval: 'exec',
        parameters: z.object({
            name: z.string().min(1),
            app: app.optional(),
            input: z.array(z.string().min(1)).describe('Input file paths.').optional(),
            output: z
                .string()
                .min(1)
                .describe('Where its result goes; else it comes back as stdout.')
                .optional(),
            output_type: z.string().describe('A content type for the output.').optional(),
            timeout: z.number().positive().describe('Seconds, default 60.').optional(),
        }),
        ...presentation('Run shortcut', 'shortcut'),
        async execute(_toolCallId, { name, app: targetApp, ...rest }, signal, _onUpdate, ctx) {
            return queued(
                {
                    verb: 'shortcut',
                    app: targetApp ?? DATA_LANE,
                    agent_id: macAgentId(ctx),
                    args: { name, ...rest },
                },
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
            return queued(
                { verb: 'handoff', app: targetApp, agent_id: macAgentId(ctx), args },
                signal,
            );
        },
    });
}
