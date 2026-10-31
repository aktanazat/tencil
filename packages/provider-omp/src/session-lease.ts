import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LeaseHolder {
    pid: number;
    /** Parent pid, so an `omp` started by a wrapper script counts as the wrapper's. */
    ppid: number;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Processes holding OMP's ownership lease on a session. OMP 18 takes the lease,
 * an `flock` on `<state>/run/session-owners/<id>.lock`, on a session's first
 * write and holds it until the process exits. The file stays behind after
 * that, so only a process with it open counts; lsof lists those without
 * taking the lock. On Linux and Windows the lease is an abstract socket or a
 * named mutex instead, which this can't inspect.
 */
export async function leaseHolders(sessionId: string, cwd: string): Promise<LeaseHolder[]> {
    if (process.platform === 'linux' || process.platform === 'win32') {
        throw new Error(
            `Tencil can't tell which OMP process owns a session on ${process.platform}`,
        );
    }
    if (!SESSION_ID.test(sessionId)) throw new Error(`Unexpected OMP session id: ${sessionId}`);
    const lockPath = `${resolve(cwd, sessionOwnersDir(), sessionId)}.lock`;
    try {
        await stat(lockPath);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
    }
    return parseHolders(await openers(lockPath));
}

/** OMP's `getSessionOwnersDir`, with the override its own test runs export. */
function sessionOwnersDir(): string {
    const override = process.env.PI_TEST_SESSION_OWNERS_DIR;
    if (override !== undefined) return override;
    const xdgState = process.env.XDG_STATE_HOME;
    const base =
        process.platform === 'darwin' && xdgState && existsSync(join(xdgState, 'omp'))
            ? join(xdgState, 'omp')
            : join(homedir(), process.env.PI_CONFIG_DIR || '.omp');
    return join(base, 'run', 'session-owners');
}

function openers(path: string): Promise<string> {
    return new Promise((done, fail) => {
        execFile('lsof', ['-w', '-F', 'pR', '--', path], (error, stdout, stderr) => {
            if (!error) done(stdout);
            // lsof exits 1 without output when nobody has the file open.
            else if (error.code === 1 && !stdout && !stderr) done('');
            else
                fail(
                    new Error(
                        `Couldn't check OMP's lease on ${path}: ${stderr.trim() || error.message}`,
                    ),
                );
        });
    });
}

function parseHolders(output: string): LeaseHolder[] {
    const holders: LeaseHolder[] = [];
    for (const line of output.split('\n')) {
        const value = Number(line.slice(1));
        if (line.startsWith('p')) holders.push({ pid: value, ppid: 0 });
        const last = holders.at(-1);
        if (line.startsWith('R') && last) last.ppid = value;
    }
    return holders;
}
