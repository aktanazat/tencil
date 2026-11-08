from __future__ import annotations

import contextlib
import json
import signal
import sys

from macos_harness import MacOS, MacOSError, OperationError, equals, gone, present
from macos_harness.errors import ErrorCode

SELECTORS = {"text", "role", "title", "identifier", "description"}
ARGUMENTS = {
    "see": {"window_index", "window_id", "crop", "zoom"},
    "state": {"query", "window_id", "diff"},
    "query": SELECTORS | {"limit", "visible_only"},
    "handoff": {"reason"},
    "press": SELECTORS | {"state_id", "timeout"},
    "click": {"x", "y", "element", "state_id", "window_id", "screenshot", "button", "clicks", "timeout"},
    "type": {"text", "window_id", "timeout"},
    "key": {"key", "window_id", "timeout"},
}


def arguments(values: dict[str, object], allowed: set[str]) -> dict[str, object]:
    unknown = values.keys() - allowed
    if unknown:
        raise MacOSError(
            f"Unknown arguments: {', '.join(sorted(unknown))}", code=ErrorCode.BAD_REQUEST
        )
    return {key: value for key, value in values.items() if value is not None}


def postcondition(expect: dict[str, object]):
    state = expect.get("state")
    allowed = SELECTORS | {"state"}
    if state == "equals":
        allowed |= {"value", "attribute"}
    values = arguments(expect, allowed)
    values.pop("state", None)
    if state == "present":
        return present(**values)
    if state == "gone":
        return gone(**values)
    if state == "equals":
        if "value" not in values:
            raise MacOSError("An equals expectation requires value", code=ErrorCode.BAD_REQUEST)
        return equals(**values)
    raise MacOSError(f"Unknown expectation state: {state!r}", code=ErrorCode.BAD_REQUEST)


def run(macs: dict[str, MacOS], request: dict[str, object]) -> object:
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
    mac = macs.get(agent_id)
    if mac is None:
        mac = macs[agent_id] = MacOS(agent_id=agent_id)
    if verb == "see":
        crop = values.get("crop")
        if crop is not None:
            values["crop"] = tuple(crop)
        return mac.see(app, **values)
    if verb == "state":
        state = mac.state(app, **values)
        return {"text": state.text, "complete": state.complete}
    if verb == "query":
        matches = mac.ax.query(app=app, **values)
        return {"matches": list(matches), "complete": matches.complete, "visited": matches.visited}
    if verb == "handoff":
        handoff = mac.handoff(app=app, **values)
        return {"handoff": handoff.to_json(), "prompt": handoff.to_prompt()}
    state_id = values.pop("state_id", None)
    if state_id is not None:
        state = mac.state(app, window_id=values.get("window_id"))
        try:
            values["element"] = state[state_id]
        except KeyError as exc:
            raise MacOSError(exc.args[0], code=ErrorCode.ELEMENT_UNKNOWN) from None
    expect = request.get("expect")
    if expect is not None:
        values["postcondition"] = postcondition(expect)
    receipt = getattr(mac.do, verb)(app=app, **values)
    return {"receipt": receipt.to_json(), "summary": str(receipt)}


def interrupt(_signal: int, _frame: object) -> None:
    # OMP cancels with SIGTERM; an interrupt lets MacOS close its private helpers.
    raise KeyboardInterrupt


def answer(macs: dict[str, MacOS], line: str) -> dict[str, object]:
    try:
        with contextlib.redirect_stdout(sys.stderr):
            return {"ok": True, "result": run(macs, json.loads(line))}
    except MacOSError as exc:
        return {
            "ok": False,
            "error": exc.to_json(),
            "receipt": exc.receipt.to_json() if isinstance(exc, OperationError) else None,
        }


def main() -> int:
    """Answer one JSON request a line, in order, until stdin closes. One
    process serves one app, so its MacOS instances, imports and pointer
    helper outlive a single call."""
    signal.signal(signal.SIGTERM, interrupt)
    macs: dict[str, MacOS] = {}
    try:
        for line in sys.stdin:
            print(json.dumps(answer(macs, line), separators=(",", ":")), flush=True)
    except KeyboardInterrupt:
        return 130
    finally:
        for mac in macs.values():
            mac.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
