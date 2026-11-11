from __future__ import annotations

import contextlib
import json
import plistlib
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from macos_harness import (
    MacOS,
    MacOSError,
    OperationError,
    Postcondition,
    Receipt,
    equals,
    gone,
    present,
)
from macos_harness.errors import ErrorCode

SELECTORS = {"text", "role", "title", "identifier", "description"}
# The fields a route finds a control by, in the order mac.state labels it.
NAMES = ("title", "description", "identifier")
ARGUMENTS = {
    "see": {"window_index", "window_id", "crop", "zoom"},
    "state": {"query", "window_id", "diff"},
    "query": SELECTORS | {"limit", "visible_only"},
    "handoff": {"reason"},
    "press": SELECTORS | {"state_id", "window_id", "timeout"},
    "click": {"x", "y", "element", "state_id", "window_id", "screenshot", "button", "clicks", "timeout"},
    "type": {"text", "window_id", "timeout"},
    "key": {"key", "window_id", "timeout"},
    "script": {"source", "language", "timeout"},
    "route": {"action", "name", "entry", "goal", "inputs", "timeout"},
    "menus": {"text", "limit"},
    "menu": {"text", "timeout"},
    "sdef": set(),
    "paste": {"text", "html", "rtf", "tsv", "files", "window_id", "timeout"},
    "open_files": {"files", "timeout"},
    "steps": {"steps"},
}
INPUT = {"press", "click", "type", "key", "script", "menu", "paste", "open_files"}
STEP_OPS = {"press", "click", "type", "key", "menu", "paste", "open_files", "expect"}
SCRIPTABLE = "This app is scriptable: prefer one mac_script to a series of clicks"
# A recording spans the agent's turns, and the harness gives it one deadline.
RECORDING_S = 600.0
CHECK_S = 2.0
STEP_S = 5.0


class Recorder(Protocol):
    def press(
        self, *, role: str, postcondition: Postcondition, title: str | None = None,
        identifier: str | None = None, description: str | None = None,
    ) -> Receipt: ...

    def key(self, key: str, *, postcondition: Postcondition) -> Receipt: ...


@dataclass
class Recording:
    name: str
    context: contextlib.AbstractContextManager[Recorder]
    recorder: Recorder
    steps: int = 0
    started: float = field(default_factory=time.monotonic)

    def drop(self, reason: MacOSError) -> None:
        self.context.__exit__(type(reason), reason, reason.__traceback__)


@dataclass
class Session:
    macs: dict[str, MacOS] = field(default_factory=dict)
    scriptable: dict[str | int, bool] = field(default_factory=dict)
    recordings: dict[str, Recording] = field(default_factory=dict)

    def hold(self) -> float:
        now = time.monotonic()
        return max(
            (RECORDING_S - (now - recording.started) for recording in self.recordings.values()),
            default=0.0,
        )


def arguments(values: dict[str, object], allowed: set[str]) -> dict[str, object]:
    unknown = values.keys() - allowed
    if unknown:
        raise MacOSError(
            f"Unknown arguments: {', '.join(sorted(unknown))}", code=ErrorCode.BAD_REQUEST
        )
    return {key: value for key, value in values.items() if value is not None}


def postcondition(expect: dict[str, object], timeout: object = None):
    state = expect.get("state")
    allowed = SELECTORS | {"state"}
    if state == "equals":
        allowed |= {"value", "attribute"}
    values = arguments(expect, allowed)
    values.pop("state", None)
    if timeout is not None:
        values["timeout"] = timeout
    if state == "present":
        return present(**values)
    if state == "gone":
        return gone(**values)
    if state == "equals":
        if "value" not in values:
            raise MacOSError("An equals expectation requires value", code=ErrorCode.BAD_REQUEST)
        return equals(**values)
    raise MacOSError(f"Unknown expectation state: {state!r}", code=ErrorCode.BAD_REQUEST)


def exact(expect: object, what: str, timeout: object):
    if not isinstance(expect, dict):
        raise MacOSError(f"{what} is required", code=ErrorCode.BAD_REQUEST)
    named = [name for name in NAMES if expect.get(name)]
    if not expect.get("role") or len(named) != 1 or expect.get("text") is not None:
        raise MacOSError(
            f"{what} needs role and exactly one of title, description or identifier, "
            "without text: a route finds a control again by those alone",
            code=ErrorCode.BAD_REQUEST,
        )
    if expect.get("state") == "equals" and type(expect.get("value")) not in (bool, int, float):
        raise MacOSError(
            f"{what} can compare only true, false or a number in a route",
            code=ErrorCode.BAD_REQUEST,
        )
    return postcondition(expect, timeout)


def annotated(exc: MacOSError, note: str) -> MacOSError:
    message = f"{str(exc).rstrip('.')}. {note}"
    if isinstance(exc, OperationError):
        return OperationError(message, receipt=exc.receipt, code=exc.code, details=exc.details)
    return MacOSError(message, code=exc.code, details=exc.details)


def scriptable(path: object) -> bool:
    if not isinstance(path, str):
        return False
    try:
        with Path(path, "Contents", "Info.plist").open("rb") as source:
            info = plistlib.load(source)
    except (OSError, ValueError):
        return False
    return isinstance(info, dict) and (
        str(info.get("NSAppleScriptEnabled")).lower() in ("1", "true", "yes")
        or bool(info.get("OSAScriptingDefinition"))
    )


def held(mac: MacOS, app: str | int, state_id: object, window_id: object = None, states: dict | None = None):
    states = {} if states is None else states
    if window_id not in states:
        states[window_id] = mac.state(app, window_id=window_id)
    try:
        return states[window_id][state_id]
    except KeyError as exc:
        raise MacOSError(exc.args[0], code=ErrorCode.ELEMENT_UNKNOWN) from None


def targeted(mac: MacOS, app: str | int, verb: str, values: dict[str, object], states: dict) -> None:
    window_id = values.pop("window_id", None) if verb == "press" else values.get("window_id")
    state_id = values.pop("state_id", None)
    if state_id is not None:
        values["element"] = held(mac, app, state_id, window_id, states)
    elif verb == "press" and window_id is not None:
        raise MacOSError("window_id goes with a state_id from that window", code=ErrorCode.BAD_REQUEST)


def steps(mac: MacOS, app: str | int, values: dict[str, object]) -> dict[str, object]:
    states: dict = {}
    calls = []
    for index, step in enumerate(values["steps"]):
        op = step.get("op") if isinstance(step, dict) else None
        if op not in STEP_OPS:
            raise MacOSError(
                f"steps[{index}] needs op, one of {', '.join(sorted(STEP_OPS))}", code=ErrorCode.BAD_REQUEST
            )
        expect = step.get("expect")
        if op == "expect":
            if expect is None:
                raise MacOSError(f"steps[{index}] is an expect step with no expect", code=ErrorCode.BAD_REQUEST)
            calls.append({"op": "expect", "condition": postcondition(expect)})
            continue
        args = arguments({key: value for key, value in step.items() if key not in ("op", "expect")}, ARGUMENTS[op])
        targeted(mac, app, op, args, states)
        if expect is not None:
            args["postcondition"] = postcondition(expect)
        calls.append({"op": "menu_search" if op == "menu" else op, **args})
    result = mac.do.steps(calls, app=app)
    return {"steps": result.to_json(), "summary": str(result)}


def locator(mac: MacOS, app: str | int, values: dict[str, object]) -> dict[str, str]:
    state_id = values.pop("state_id", None)
    if state_id is not None:
        element = held(mac, app, state_id)
    else:
        matches = mac.ax.query(app=app, limit=2, **{key: values[key] for key in SELECTORS & values.keys()})
        if len(matches) != 1:
            raise MacOSError(
                "These selectors do not match exactly one control; nothing was sent and the "
                "recording stays open",
                code=ErrorCode.ELEMENT_UNKNOWN,
            )
        element = matches[0]
    role = element.get("role")
    for name in NAMES:
        label = element.get(name)
        if isinstance(role, str) and isinstance(label, str) and label:
            found = mac.ax.query(app=app, role=role, limit=2, **{name: label})
            if len(found) == 1 and found.complete:
                return {"role": role, name: label}
    raise MacOSError(
        "No title, description or identifier names this control alone, so a route could not "
        "find it again; nothing was sent and the recording stays open",
        code=ErrorCode.ELEMENT_UNKNOWN,
    )


def record(
    session: Session, mac: MacOS, agent_id: str, app: str | int, verb: str,
    values: dict[str, object], expect: object,
) -> dict[str, object]:
    recording = session.recordings[agent_id]
    if verb not in ("press", "key") or "window_id" in values:
        raise MacOSError(
            f"The recording {recording.name} saves mac_press and mac_key steps without window_id, "
            f"so this {verb} was not sent; save or cancel the recording first",
            code=ErrorCode.BAD_REQUEST,
        )
    if expect is None:
        raise MacOSError(
            "A recorded step needs expect, which replay checks after it; nothing was sent and "
            "the recording stays open",
            code=ErrorCode.BAD_REQUEST,
        )
    try:
        condition = exact(expect, "expect", values.get("timeout", STEP_S))
    except MacOSError as exc:
        raise annotated(exc, "Nothing was sent and the recording stays open") from None
    target = None if verb == "key" else locator(mac, app, values)
    try:
        if target is None:
            receipt = recording.recorder.key(values["key"], postcondition=condition)
        else:
            receipt = recording.recorder.press(postcondition=condition, **target)
    except MacOSError as exc:
        del session.recordings[agent_id]
        recording.drop(exc)
        raise annotated(
            exc, f"The recording {recording.name} ended without saving; mac_route record starts it again"
        ) from exc
    recording.steps += 1
    return {
        "receipt": receipt.to_json(),
        "summary": f"{receipt}; saved as step {recording.steps} of {recording.name}",
    }


def route(
    session: Session, mac: MacOS, agent_id: str, app: str | int, values: dict[str, object]
) -> dict[str, object]:
    action = values.get("action")
    recording = session.recordings.get(agent_id)
    if action in ("save", "cancel"):
        if recording is None:
            raise MacOSError(
                "No recording is open for this app; mac_route record starts one",
                code=ErrorCode.BAD_REQUEST,
            )
        del session.recordings[agent_id]
        if action == "cancel":
            recording.drop(MacOSError("Cancelled", code=ErrorCode.BAD_REQUEST))
            return {"cancelled": recording.name}
        try:
            recording.context.__exit__(None, None, None)
        except MacOSError as exc:
            raise annotated(exc, f"{recording.name} was not saved, and its recording is closed") from exc
        return {"saved": recording.name, "steps": recording.steps}
    if recording is not None and action != "list":
        raise MacOSError(
            f"The recording {recording.name} is open; save or cancel it first",
            code=ErrorCode.BAD_REQUEST,
        )
    bundle = mac.status(app)["app"]["bundle_id"]
    if not isinstance(bundle, str):
        raise MacOSError("This app has no bundle identifier, so it keeps no routes", code=ErrorCode.BAD_REQUEST)
    name = values.get("name")
    if action == "list":
        return {"routes": mac.route.list(app=bundle)}
    if action == "run":
        result = mac.route.run(
            name, app=bundle, timeout=values.get("timeout", 30.0), inputs=values.get("inputs")
        )
        return {"run": result.to_json(), "steps": [str(receipt) for receipt in result.steps_run]}
    if action == "record":
        context = mac.route.record(
            name, app=bundle, entry=exact(values.get("entry"), "entry", CHECK_S),
            goal=exact(values.get("goal"), "goal", CHECK_S), timeout=RECORDING_S,
        )
        try:
            recorder = context.__enter__()
        except MacOSError as exc:
            raise annotated(exc, "No recording started") from exc
        session.recordings[agent_id] = Recording(name, context, recorder)
        return {"recording": name, "app": bundle}
    raise MacOSError(f"Unknown route action: {action!r}", code=ErrorCode.BAD_REQUEST)


def run(session: Session, request: dict[str, object]) -> object:
    verb = request["verb"]
    if verb not in ARGUMENTS:
        raise MacOSError(f"Unknown operation: {verb!r}", code=ErrorCode.BAD_REQUEST)
    app = request["app"]
    if not isinstance(app, str) or not app.strip():
        raise MacOSError("An explicit target app is required", code=ErrorCode.BAD_REQUEST)
    if app.isascii() and app.isdecimal():
        app = int(app)
    values = arguments(request["args"], ARGUMENTS[verb])
    agent_id = request["agent_id"]
    mac = session.macs.get(agent_id)
    if mac is None:
        mac = session.macs[agent_id] = MacOS(agent_id=agent_id)
    if verb == "route":
        return route(session, mac, agent_id, app, values)
    if verb == "steps" and agent_id in session.recordings:
        raise MacOSError(
            "A recording takes one press or key per call; send the steps one at a time or close the recording",
            code=ErrorCode.BAD_REQUEST,
        )
    if agent_id in session.recordings and verb in INPUT:
        return record(session, mac, agent_id, app, verb, values, request.get("expect"))
    if verb == "see":
        crop = values.get("crop")
        if crop is not None:
            values["crop"] = tuple(crop)
        return mac.see(app, **values)
    if verb == "state":
        if app not in session.scriptable:
            session.scriptable[app] = scriptable(mac.status(app)["app"]["path"])
        try:
            state = mac.state(app, **values)
        except MacOSError as exc:
            if not session.scriptable[app]:
                raise
            raise annotated(exc, SCRIPTABLE) from exc
        text = f"{state.text}\n{SCRIPTABLE}." if session.scriptable[app] else state.text
        return {"text": text, "complete": state.complete}
    if verb == "query":
        matches = mac.ax.query(app=app, **values)
        return {"matches": list(matches), "complete": matches.complete, "visited": matches.visited}
    if verb == "handoff":
        handoff = mac.handoff(app=app, **values)
        return {"handoff": handoff.to_json(), "prompt": handoff.to_prompt()}
    if verb == "script":
        return {"output": mac.script(**values)}
    if verb == "sdef":
        return mac.sdef(app)
    if verb == "menus":
        return {"matches": mac.menu_search(app=app, **values)}
    if verb == "steps":
        return steps(mac, app, values)
    if verb == "menu":
        verb = "menu_search"
    targeted(mac, app, verb, values, {})
    expect = request.get("expect")
    if expect is not None:
        values["postcondition"] = postcondition(expect)
    receipt = getattr(mac.do, verb)(app=app, **values)
    return {"receipt": receipt.to_json(), "summary": str(receipt)}


def interrupt(_signal: int, _frame: object) -> None:
    # OMP cancels with SIGTERM; an interrupt lets MacOS close its private helpers.
    raise KeyboardInterrupt


def answer(session: Session, line: str) -> dict[str, object]:
    try:
        with contextlib.redirect_stdout(sys.stderr):
            reply: dict[str, object] = {"ok": True, "result": run(session, json.loads(line))}
    except MacOSError as exc:
        reply = {
            "ok": False,
            "error": exc.to_json(),
            "receipt": exc.receipt.to_json() if isinstance(exc, OperationError) else None,
        }
    hold = session.hold()
    if hold > 0:
        reply["hold"] = round(hold, 1)
    return reply


def main() -> int:
    """Answer one JSON request a line, in order, until stdin closes. One
    process serves one app, so its MacOS instances, imports, pointer helper
    and open route recordings outlive a single call."""
    signal.signal(signal.SIGTERM, interrupt)
    session = Session()
    try:
        for line in sys.stdin:
            print(json.dumps(answer(session, line), separators=(",", ":")), flush=True)
    except KeyboardInterrupt:
        return 130
    finally:
        for mac in session.macs.values():
            mac.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
