"""Freerouting service.

Autorouting is a DSN-in, SES-out transaction: @syntrix/pcb exports a Specctra DSN via
`dsn-converter`, this service routes it, and the SES session file comes back to be
merged into the design as `pcb_trace` elements.

Routing is slow — minutes on a real board — so the Node side calls this from a BullMQ
worker, not from a request handler. The endpoint is still synchronous because the
worker is the thing that owns the queueing.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

JAR = Path(os.environ.get("FREEROUTING_JAR", "/opt/freerouting.jar"))
WORK_ROOT = Path(os.environ.get("FREEROUTING_WORK_DIR", "/work"))
DEFAULT_TIMEOUT_SEC = int(os.environ.get("FREEROUTING_TIMEOUT_SEC", "900"))

STARTED_AT = time.time()

app = FastAPI(
    title="SYNTRIX Freerouting service",
    version="0.1.0",
    description="Specctra DSN autorouting.",
)


class RouteJob(BaseModel):
    dsn: str = Field(..., description="Specctra DSN file contents")
    name: str = Field("board", description="Base filename, without extension")
    # Freerouting's own knobs. Defaults match its CLI defaults.
    max_passes: int = Field(10, ge=1, le=1000, description="Optimisation passes")
    timeout_sec: int | None = None


class RouteResult(BaseModel):
    ok: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    # The SES session file, empty when routing failed.
    ses: str = ""
    # Reported so the caller can tell "routed everything" from "routed most of it".
    unrouted_hint: str | None = None


@app.get("/health")
async def health() -> JSONResponse:
    available = JAR.exists()
    return JSONResponse(
        status_code=200 if available else 503,
        content={
            "status": "ok" if available else "down",
            "service": "freerouting",
            "version": "0.1.0",
            "jar": str(JAR),
            "jar_present": available,
            "detail": None if available else "freerouting.jar is missing from the image",
            "uptime_sec": int(time.time() - STARTED_AT),
        },
    )


@app.post("/route", response_model=RouteResult)
async def route(job: RouteJob) -> RouteResult:
    if not JAR.exists():
        raise HTTPException(status_code=503, detail="freerouting.jar is not present in this image")

    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix=f"{uuid.uuid4().hex[:8]}-", dir=str(WORK_ROOT)))
    timeout = job.timeout_sec or DEFAULT_TIMEOUT_SEC

    try:
        dsn_path = workdir / f"{job.name}.dsn"
        ses_path = workdir / f"{job.name}.ses"
        dsn_path.write_text(job.dsn, encoding="utf-8")

        started = time.time()
        proc = await asyncio.create_subprocess_exec(
            "java",
            "-jar",
            str(JAR),
            "-de",
            str(dsn_path),
            "-do",
            str(ses_path),
            "-mp",
            str(job.max_passes),
            # Headless: there is no display in the container, and the GUI would block.
            "-dr",
            cwd=str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "JAVA_TOOL_OPTIONS": "-Djava.awt.headless=true"},
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(
                status_code=504,
                detail=f"Routing timed out after {timeout}s — lower max_passes or raise timeout_sec",
            )

        out = stdout.decode(errors="replace")
        ses = ses_path.read_text(encoding="utf-8") if ses_path.exists() else ""

        # Freerouting reports incomplete routing in its log rather than its exit code, so
        # a "success" with unrouted nets must be surfaced explicitly.
        hint = None
        for line in out.splitlines():
            if "unrouted" in line.lower() or "incomplete" in line.lower():
                hint = line.strip()
                break

        return RouteResult(
            ok=bool(ses) and proc.returncode == 0,
            exit_code=proc.returncode or 0,
            stdout=out,
            stderr=stderr.decode(errors="replace"),
            duration_ms=int((time.time() - started) * 1000),
            ses=ses,
            unrouted_hint=hint,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
