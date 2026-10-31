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
    "query": SELECTORS | {"limit", "visible_only"},
    "handoff": {"reason"},
    "press": SELECTORS | {"timeout"},
    "click": {"x", "y", "element", "window_id", "screenshot", "button", "clicks", "timeout"},
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


def run(request: dict[str, object]) -> object:
    verb = request["verb"]
    if verb not in ARGUMENTS:
        raise MacOSError(f"Unknown operation: {verb!r}", code=ErrorCode.BAD_REQUEST)
    app = request["app"]
    if not isinstance(app, str) or not app.strip():
        raise MacOSError("An explicit target app is required", code=ErrorCode.BAD_REQUEST)
    if app.isascii() and app.isdecimal():
        app = int(app)
    values = arguments(request["args"], ARGUMENTS[verb])
    with MacOS(agent_id=request["agent_id"]) as mac:
        if verb == "see":
            crop = values.get("crop")
            if crop is not None:
                values["crop"] = tuple(crop)
            return mac.see(app, **values)
        if verb == "query":
            matches = mac.ax.query(app=app, **values)
            return {"matches": list(matches), "complete": matches.complete, "visited": matches.visited}
        if verb == "handoff":
            handoff = mac.handoff(app=app, **values)
            return {"handoff": handoff.to_json(), "prompt": handoff.to_prompt()}
        expect = request.get("expect")
        if expect is not None:
            values["postcondition"] = postcondition(expect)
        receipt = getattr(mac.do, verb)(app=app, **values)
        return {"receipt": receipt.to_json(), "summary": str(receipt)}


def interrupt(_signal: int, _frame: object) -> None:
    # OMP cancels with SIGTERM; an interrupt lets MacOS close its private helpers.
    raise KeyboardInterrupt


def main() -> int:
    signal.signal(signal.SIGTERM, interrupt)
    try:
        request = json.loads(sys.argv[1])
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        envelope = {"ok": True, "result": result}
        code = 0
    except MacOSError as exc:
        envelope = {
            "ok": False,
            "error": exc.to_json(),
            "receipt": exc.receipt.to_json() if isinstance(exc, OperationError) else None,
        }
        code = 1
    except KeyboardInterrupt:
        return 130
    print(json.dumps(envelope, separators=(",", ":")))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
