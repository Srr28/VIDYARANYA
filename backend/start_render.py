"""Run the API and ARQ consumer together for the single-service Render setup."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time


stopping = False


def _stop_children(*_args: object) -> None:
    global stopping
    stopping = True


def _terminate(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def main() -> int:
    signal.signal(signal.SIGTERM, _stop_children)
    signal.signal(signal.SIGINT, _stop_children)

    worker: subprocess.Popen[bytes] | None = None
    if os.getenv("QUEUE_MODE", "auto").strip().lower() != "in_process":
        worker = subprocess.Popen(["arq", "app.worker.WorkerSettings"], cwd="/app")

    api = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            os.getenv("PORT", "8000"),
        ],
        cwd="/app",
    )

    try:
        while not stopping:
            api_status = api.poll()
            if api_status is not None:
                return api_status

            if worker is not None and worker.poll() is not None:
                print("ARQ worker exited; restarting it in 15 seconds.", flush=True)
                time.sleep(15)
                if not stopping:
                    worker = subprocess.Popen(["arq", "app.worker.WorkerSettings"], cwd="/app")
            time.sleep(0.5)
        return 0
    finally:
        _terminate(api)
        _terminate(worker)


if __name__ == "__main__":
    raise SystemExit(main())
