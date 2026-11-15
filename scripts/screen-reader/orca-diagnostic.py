"""Observation-only instrumentation for the synthetic live-region self-test."""
import faulthandler
import os
from functools import wraps

from orca import debug, liveregions
from orca.scripts.web import script_utilities

if not getattr(liveregions.LiveRegionManager, "_capture_diagnostic", False):
    liveregions.LiveRegionManager._capture_diagnostic = True
    if debug.debugFile is None:
        raise RuntimeError("Diagnostic requires Orca --debug-file")
    debug.debugFile.reconfigure(line_buffering=True, write_through=True)
    trace = open(os.path.join(os.environ["EVIDENCE_DIR"], "orca-stack.log"), "w", buffering=1)
    count = [0]
    active = [False]

    def emit(text):
        if active[0] and count[0] < 100:
            count[0] += 1
            debug.printMessage(debug.LEVEL_INFO, "LRDIAG " + text, True)
            debug.debugFile.flush()

    def instrument(cls, name):
        original = getattr(cls, name)

        @wraps(original)
        def observed(self, *args, **kwargs):
            if not active[0] and name == "handleEvent" and args and getattr(
                args[0], "any_data", None
            ) == "Synthetic announcement received":
                active[0] = True
                faulthandler.dump_traceback_later(1.5, repeat=False, file=trace)
            if not active[0]:
                return original(self, *args, **kwargs)
            cache = getattr(self, "_treatAsTextObject", None)
            cached = cache.get(hash(args[0])) if cache is not None and args else None
            queue = getattr(self, "msg_queue", None)
            before = len(queue) if queue is not None else None
            emit(f"enter {name} cached={cached!r} queue={before!r}")
            try:
                result = original(self, *args, **kwargs)
            except Exception as error:
                emit(f"exception {name} type={type(error).__name__}")
                raise
            after = len(queue) if queue is not None else None
            summary = (None if result is None else hash(result)) if name == "_findContainer" else result
            emit(f"exit {name} result={summary!r} queue={after!r}")
            return result

        setattr(cls, name, observed)

    for method in ("_getLiveType", "_findContainer", "_getMessage", "handleEvent", "pumpMessages"):
        instrument(liveregions.LiveRegionManager, method)
    for method in ("treatAsTextObject", "expandEOCs"):
        instrument(script_utilities.Utilities, method)
    debug.printMessage(debug.LEVEL_INFO, "LRDIAG installed; debug file is line-buffered", True)
    debug.debugFile.flush()
