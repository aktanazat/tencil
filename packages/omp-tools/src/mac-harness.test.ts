import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMacHarness } from './mac-harness.ts';
import { fakeOmp } from './omp-extension.test-support.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('@oh-my-pi/pi-tui', () => ({ kv: vi.fn(), Text: vi.fn(), text: vi.fn() }));

function fakeDriver() {
    const process = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        unref: vi.fn(),
    });
    const requests: unknown[] = [];
    const lines: string[] = [];
    process.stdin.setEncoding('utf8').on('data', (line: string) => {
        lines.push(line);
        requests.push(JSON.parse(line));
    });
    return {
        process,
        requests,
        lines,
        reply(envelope: unknown) {
            process.stdout.write(`${JSON.stringify(envelope)}\n`);
        },
        close() {
            process.emit('close');
            process.stdin.destroy();
            process.stdout.destroy();
            process.stderr.destroy();
        },
    };
}

let omp: ReturnType<typeof fakeOmp>;
const drivers: ReturnType<typeof fakeDriver>[] = [];
const app = 'Example Editor';
const state = { ok: true, result: { text: '[1] button "Save"', complete: true } };
const receipt = {
    ok: true,
    result: { receipt: { outcome: 'done', acted: true }, summary: 'Pressed Save.' },
};

beforeEach(() => {
    vi.mocked(spawn)
        .mockReset()
        .mockImplementation(() => {
            const fake = fakeDriver();
            drivers.push(fake);
            return fake.process as unknown as ReturnType<typeof spawn>;
        });
    omp = fakeOmp();
    registerMacHarness(omp.api);
});

afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
});

async function driverAt(index: number, requests = 1) {
    await vi.waitFor(() => expect(drivers[index]?.requests).toHaveLength(requests));
    return drivers[index]!;
}

describe('Mac harness driver protocol', () => {
    it('writes newline-delimited requests with agent and app identity and handles a split reply', async () => {
        const expectState = { state: 'equals', title: 'Document', value: false };
        const press = omp.run('mac_press', { app, state_id: 1, window_id: 9, expect: expectState });
        const driver = await driverAt(0);
        expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([expect.any(String)]);
        const command = vi.mocked(spawn).mock.calls[0]?.[1] as readonly string[];
        expect(basename(command[0]!)).toBe('mac-driver.py');
        expect(driver.lines[0]).toMatch(/^[^\n]+\n$/);
        expect(driver.requests).toEqual([
            {
                verb: 'press',
                app,
                agent_id: `main-agent:${omp.sessionId}`,
                args: { state_id: 1, window_id: 9 },
                expect: expectState,
            },
        ]);
        let settled = false;
        void press.then(() => {
            settled = true;
        });
        driver.process.stdout.write(JSON.stringify(receipt));
        await Promise.resolve();
        expect(settled).toBe(false);
        driver.process.stdout.write('\n');
        expect(await press).toMatchObject({
            isError: false,
            content: [{ type: 'text', text: expect.stringContaining('Pressed Save.') }],
            details: { kind: 'receipt', app, data: receipt.result },
        });
    });

    it('serializes calls to one app over a warm process without blocking another app', async () => {
        const press = omp.run('mac_press', { app, title: 'Save' });
        const read = omp.run('mac_state', { app });
        const other = omp.run('mac_state', { app: 'Other Editor' });
        const first = await driverAt(0);
        const second = await driverAt(1);
        expect(first.requests).toMatchObject([{ verb: 'press', app }]);
        expect(second.requests).toMatchObject([{ verb: 'state', app: 'Other Editor' }]);
        second.reply(state);
        expect((await other).content).toEqual([{ type: 'text', text: state.result.text }]);
        first.reply(receipt);
        await press;
        await driverAt(0, 2);
        expect(first.requests[1]).toMatchObject({ verb: 'state', app });
        expect(spawn).toHaveBeenCalledTimes(2);
        first.reply(state);
        await read;
    });

    it('preserves the Python error and receipt, skips already-queued actions, and accepts a fresh observation', async () => {
        const first = omp.run('mac_press', { app, title: 'Save' });
        const skipped = omp.run('mac_key', { app, key: 'Escape' });
        const driver = await driverAt(0);
        const error = { code: 'postcondition_failed', message: 'Save did not confirm' };
        const failedReceipt = { outcome: 'failed', acted: true };
        driver.reply({ ok: false, error, receipt: failedReceipt });
        expect(await first).toMatchObject({
            isError: true,
            details: { kind: 'error', data: { ok: false, error, receipt: failedReceipt } },
        });
        expect(await skipped).toMatchObject({
            isError: true,
            details: {
                data: {
                    error: {
                        code: 'not_run',
                        message: expect.stringContaining('postcondition_failed'),
                    },
                },
            },
        });
        expect(driver.requests).toHaveLength(1);
        const recovery = omp.run('mac_state', { app });
        await driverAt(0, 2);
        driver.reply(state);
        expect((await recovery).details).toMatchObject({ kind: 'state' });
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('interrupts uncertain input and uses a new process for recovery', async () => {
        const abort = new AbortController();
        const action = omp.run('mac_press', { app, title: 'Save' }, abort.signal);
        const driver = await driverAt(0);
        const interrupted = expect(action).rejects.toThrow('Whether input was sent is unknown');
        abort.abort();
        await interrupted;
        expect(driver.process.kill).toHaveBeenCalledWith('SIGTERM');
        const read = omp.run('mac_state', { app });
        const replacement = await driverAt(1);
        replacement.reply(state);
        expect((await read).content).toEqual([{ type: 'text', text: state.result.text }]);
    });

    it('reports malformed replies and process exit diagnostics', async () => {
        const first = omp.run('mac_state', { app });
        const driver = await driverAt(0);
        const malformed = expect(first).rejects.toThrow(
            'Mac harness answered without a valid result. not JSON',
        );
        driver.process.stdout.write('not JSON\n');
        await malformed;

        const second = omp.run('mac_state', { app });
        await driverAt(0, 2);
        const exited = expect(second).rejects.toThrow(
            'Mac harness exited without a result. Cannot load harness',
        );
        driver.process.stderr.write('Cannot load harness\n');
        driver.process.emit('close');
        await exited;
    });

    it('refuses incomplete click coordinates and equals conditions before spawning Python', async () => {
        await expect(omp.run('mac_click', { app, x: 15, y: 30 })).rejects.toThrow(
            'screenshot path from mac_see',
        );
        await expect(
            omp.run('mac_press', { app, title: 'Save', expect: { state: 'equals' } }),
        ).rejects.toThrow('requires value');
        expect(spawn).not.toHaveBeenCalled();
    });

    it('sends a crop as a tuple-compatible array and returns the screenshot as image content', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'tencil-fake-screenshot-'));
        const path = join(dir, 'window.png');
        const image = Buffer.from('fake screenshot');
        try {
            await writeFile(path, image);
            const shot = omp.run('mac_see', {
                app,
                crop: { x: 1, y: 2, width: 30, height: 40 },
                window_id: 9,
            });
            const driver = await driverAt(0);
            expect(driver.requests).toMatchObject([
                { verb: 'see', args: { crop: [1, 2, 30, 40], window_id: 9 } },
            ]);
            driver.reply({ ok: true, result: { path } });
            expect(await shot).toMatchObject({
                content: [
                    { type: 'text', text: expect.stringContaining('Use this PNG path') },
                    { type: 'image', mimeType: 'image/png', data: image.toString('base64') },
                ],
                details: { kind: 'see', mediaPath: path },
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('blocks agent input in other apps while the person is recording a route', async () => {
        const watch = omp.run('mac_route', { app, action: 'watch', name: 'save-document' });
        const driver = await driverAt(0);
        driver.reply({ ok: true, result: { watching: 'save-document' }, hold: 600 });
        expect((await watch).content).toEqual([
            { type: 'text', text: expect.stringContaining('do the task by hand') },
        ]);
        const blocked = await omp.run('mac_press', { app: 'Other Editor', title: 'Save' });
        expect(blocked).toMatchObject({
            isError: true,
            details: { data: { error: { code: 'watching' } } },
        });
        expect(spawn).toHaveBeenCalledTimes(1);
        const stop = omp.run('mac_route', { app, action: 'stop' });
        await driverAt(0, 2);
        driver.reply({
            ok: true,
            result: { watch: { status: 'saved', name: 'save-document', steps: [] } },
        });
        await stop;
        const action = omp.run('mac_press', { app: 'Other Editor', title: 'Save' });
        const other = await driverAt(1);
        other.reply(receipt);
        expect((await action).isError).toBe(false);
    });
});
