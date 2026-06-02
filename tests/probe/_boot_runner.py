"""Out-of-process backend probe, executed by env.capture_first_run().

Runs in its OWN process so it never mutates the parent test session's module
table or environment (in-process booting purges/re-imports the backend, which
corrupts DB_PATH for other tests — see env.py). Boots the FastAPI app against a
data dir and captures, in a single boot, everything the L5/engine/security/
coverage probes need:

  - first-run endpoints (health / system info / model status): status/body/latency
  - DB creation on first boot
  - TTS + ASR engine matrices (/engines/tts, /engines/asr)
  - loopback-rejection of a system endpoint from a non-loopback origin
  - the OpenAPI path inventory (for the Coverage Critic)

Writes the captured context as JSON to the output path. Not a test module.

argv: <data_dir> <output_json_path>
"""

import glob
import json
import os
import sys
import time

ENDPOINTS = [("/health", "health"), ("/system/info", "sysinfo"), ("/model/status", "model")]


def main() -> int:
    data_dir, out_path = sys.argv[1], sys.argv[2]
    os.environ["OMNIVOICE_MODEL"] = "test"
    os.environ["OMNIVOICE_DISABLE_FILE_LOG"] = "1"
    os.environ["OMNIVOICE_DATA_DIR"] = data_dir

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    backend = os.path.join(repo_root, "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)

    from fastapi.testclient import TestClient
    from main import app

    ctx: dict = {}
    with TestClient(app, client=("127.0.0.1", 50000)) as client:  # ctx-enter fires lifespan → init_db()
        for path, prefix in ENDPOINTS:
            t0 = time.perf_counter()
            resp = client.get(path)
            ctx[f"{prefix}_ms"] = (time.perf_counter() - t0) * 1000.0
            ctx[f"{prefix}_status"] = resp.status_code
            try:
                ctx[f"{prefix}_body"] = resp.json()
            except Exception:  # noqa: BLE001
                ctx[f"{prefix}_body"] = None

        # Engine matrices (loopback-gated routers → use the loopback client).
        for fam in ("tts", "asr"):
            r = client.get(f"/engines/{fam}")
            ctx[f"engines_{fam}_status"] = r.status_code
            try:
                ctx[f"engines_{fam}"] = r.json()
            except Exception:  # noqa: BLE001
                ctx[f"engines_{fam}"] = None

        # Loopback security: a non-loopback origin must be rejected on system
        # routes. Use a bare client (no `with`) so we don't re-enter the app
        # lifespan — re-entry rebinds the module-level task queue to a new event
        # loop and crashes. The require_loopback dependency only inspects
        # request.client.host, which doesn't need lifespan state.
        nl = TestClient(app)  # default client host 'testclient' = non-loopback
        ctx["loopback_reject_status"] = nl.get("/system/info").status_code

        # Dictation: handshake-only connect to the streaming-ASR WebSocket
        # (confirms the endpoint is wired + accepts loopback, without loading an
        # ASR model). Immediately closing triggers the server's disconnect path.
        try:
            with client.websocket_connect("/ws/transcribe"):
                ctx["ws_transcribe_connected"] = True
        except Exception as exc:  # noqa: BLE001
            ctx["ws_transcribe_connected"] = False
            ctx["ws_transcribe_error"] = str(exc)[:200]

    # OpenAPI inventory (no client/lifespan needed). WebSocket routes aren't in
    # the OpenAPI schema, so enumerate them from the route table separately.
    try:
        ctx["openapi_paths"] = sorted(app.openapi().get("paths", {}).keys())
    except Exception:  # noqa: BLE001
        ctx["openapi_paths"] = []
    ctx["ws_routes"] = sorted(
        getattr(r, "path", "") for r in app.routes if "WebSocket" in type(r).__name__
    )

    ctx["data_dir"] = data_dir
    ctx["db_path"] = ""
    for pat in ("*.sqlite3", "*.sqlite", "*.db"):
        hits = glob.glob(os.path.join(data_dir, "**", pat), recursive=True)
        if hits:
            ctx["db_path"] = hits[0]
            break
    ctx["db_created"] = bool(ctx["db_path"])

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(ctx, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
