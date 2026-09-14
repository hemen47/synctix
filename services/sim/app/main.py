"""Native ngspice service.

The WASM simulator in @syntrix/sim handles interactive analyses in the browser. This
service exists for the jobs that outgrow it: long transients, wide parameter sweeps, and
Monte Carlo. Same `Simulator` interface on the Node side; only the transport differs.

ngspice runs in batch mode (`-b`) with the netlist supplied as a file. Raw output is
written in ASCII and parsed back into vectors here, so the Node side receives JSON and
never has to understand the rawfile format.
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

NGSPICE = shutil.which("ngspice") or "/usr/bin/ngspice"
WORK_ROOT = Path(os.environ.get("SIM_WORK_DIR", "/work"))
DEFAULT_TIMEOUT_SEC = int(os.environ.get("SIM_TIMEOUT_SEC", "300"))

STARTED_AT = time.time()

app = FastAPI(
    title="SYNTRIX simulation service",
    version="0.1.0",
    description="Native ngspice runner for long jobs.",
)


class SimJob(BaseModel):
    netlist: str = Field(..., description="Complete SPICE netlist including analysis cards")
    name: str = Field("circuit", description="Base filename, without extension")
    timeout_sec: int | None = Field(None, description="Override the default timeout")


class SimVector(BaseModel):
    name: str
    values: list[float]
    # AC analysis is complex-valued; the imaginary part rides alongside.
    imag: list[float] | None = None


class SimResponse(BaseModel):
    ok: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    # Independent variable (time / frequency / sweep) plus one vector per node.
    sweep: SimVector | None = None
    vectors: list[SimVector] = Field(default_factory=list)


def _ngspice_version() -> str:
    try:
        out = os.popen(f"{NGSPICE} -v 2>&1").read()
        for line in out.splitlines():
            if "ngspice" in line.lower():
                return line.strip()
        return out.strip()[:120] or "unknown"
    except Exception as exc:  # pragma: no cover - defensive
        return f"unavailable: {exc}"


def _parse_ascii_raw(text: str) -> tuple[SimVector | None, list[SimVector]]:
    """Parse an ngspice ASCII rawfile into vectors.

    The format is a header (Variables:, No. Points:) followed by `Values:` blocks, one
    per point, each listing every variable in declaration order. The first variable is
    the sweep.
    """
    lines = text.splitlines()
    names: list[str] = []
    n_vars = 0
    n_points = 0
    complex_data = False
    values_at = -1

    for i, line in enumerate(lines):
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("no. variables:"):
            n_vars = int(stripped.split(":")[1])
        elif low.startswith("no. points:"):
            n_points = int(stripped.split(":")[1])
        elif low.startswith("flags:"):
            complex_data = "complex" in low
        elif low.startswith("variables:"):
            # Variable declarations: "<index> <name> <type>", one per line.
            for decl in lines[i + 1 : i + 1 + n_vars]:
                parts = decl.split()
                if len(parts) >= 2:
                    names.append(parts[1])
        elif low.startswith("values:"):
            values_at = i + 1
            break

    if values_at < 0 or not names:
        return None, []

    real: list[list[float]] = [[] for _ in names]
    imag: list[list[float]] = [[] for _ in names]

    var_index = 0
    for line in lines[values_at:]:
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        # A point's first line is prefixed with its index; continuation lines are not.
        if parts[0].isdigit() and len(parts) > 1:
            var_index = 0
            parts = parts[1:]
        for token in parts:
            if var_index >= len(names):
                break
            if complex_data and "," in token:
                re_s, im_s = token.split(",", 1)
                real[var_index].append(float(re_s))
                imag[var_index].append(float(im_s))
            else:
                real[var_index].append(float(token))
            var_index += 1

    vectors = [
        SimVector(
            name=name,
            values=real[i],
            imag=imag[i] if complex_data and imag[i] else None,
        )
        for i, name in enumerate(names)
    ]

    if not vectors:
        return None, []
    # ngspice always emits the independent variable first.
    return vectors[0], vectors[1:]


@app.get("/health")
async def health() -> JSONResponse:
    version = _ngspice_version()
    available = not version.startswith("unavailable")
    return JSONResponse(
        status_code=200 if available else 503,
        content={
            "status": "ok" if available else "down",
            "service": "sim",
            "version": "0.1.0",
            "ngspice_version": version,
            "uptime_sec": int(time.time() - STARTED_AT),
        },
    )


@app.post("/run", response_model=SimResponse)
async def run(job: SimJob) -> SimResponse:
    """Run a netlist in batch mode and return parsed vectors.

    A netlist that fails to converge is a result the caller must read, not an exception,
    so ngspice's exit code and log come back as data.
    """
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix=f"{uuid.uuid4().hex[:8]}-", dir=str(WORK_ROOT)))
    timeout = job.timeout_sec or DEFAULT_TIMEOUT_SEC

    try:
        netlist_path = workdir / f"{job.name}.cir"
        raw_path = workdir / f"{job.name}.raw"
        netlist_path.write_text(job.netlist, encoding="utf-8")

        started = time.time()
        proc = await asyncio.create_subprocess_exec(
            NGSPICE,
            "-b",
            "-a",
            "-r",
            str(raw_path),
            str(netlist_path),
            cwd=str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(
                status_code=504,
                detail=f"ngspice timed out after {timeout}s — reduce the analysis range or raise timeout_sec",
            )

        duration_ms = int((time.time() - started) * 1000)
        sweep, vectors = (None, [])
        if raw_path.exists():
            sweep, vectors = _parse_ascii_raw(raw_path.read_text(encoding="utf-8", errors="replace"))

        return SimResponse(
            ok=proc.returncode == 0 and sweep is not None,
            exit_code=proc.returncode or 0,
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
            duration_ms=duration_ms,
            sweep=sweep,
            vectors=vectors,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
