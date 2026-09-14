"""KiCad CLI wrapper.

Exposes the subset of ``kicad-cli`` that SYNTRIX needs over HTTP so the Node services
never shell out to a binary they cannot version. The image pins the KiCad version, so
"which KiCad produced this Gerber" is answerable from the image tag alone.

Endpoints mirror kicad-cli's own verbs:
  POST /sch/erc            run electrical rule check on a .kicad_sch
  POST /sch/export/netlist export a netlist
  POST /sch/export/svg     render the schematic
  POST /sch/export/pdf     render the schematic to PDF
  POST /pcb/export/gerbers produce a Gerber set
  POST /pcb/export/drill   produce drill files
  POST /pcb/export/step    produce a STEP model
  POST /pcb/drc            run design rule check on a .kicad_pcb
"""

from __future__ import annotations

import asyncio
import base64
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

KICAD_CLI = shutil.which("kicad-cli") or "/usr/bin/kicad-cli"
WORK_ROOT = Path(os.environ.get("KICAD_WORK_DIR", "/work"))
# kicad-cli can sit for a long time on a large board; bound it so a wedged run does not
# hold a worker slot forever.
DEFAULT_TIMEOUT_SEC = int(os.environ.get("KICAD_TIMEOUT_SEC", "180"))

STARTED_AT = time.time()

app = FastAPI(
    title="SYNTRIX KiCad service",
    version="0.1.0",
    description="HTTP wrapper around kicad-cli.",
)


# ---------------------------------------------------------------- models
class SchematicJob(BaseModel):
    """A .kicad_sch plus any libraries it needs, as text."""

    schematic: str = Field(..., description="Contents of the .kicad_sch file")
    name: str = Field("design", description="Base filename, without extension")
    extra_files: dict[str, str] = Field(
        default_factory=dict,
        description="Additional files written next to the schematic, by relative path",
    )


class BoardJob(BaseModel):
    board: str = Field(..., description="Contents of the .kicad_pcb file")
    name: str = Field("design", description="Base filename, without extension")
    extra_files: dict[str, str] = Field(default_factory=dict)


class GerberOptions(BaseModel):
    layers: list[str] | None = Field(
        None, description="Layer names; defaults to the standard 2-layer set"
    )
    use_drill_origin: bool = True
    subtract_soldermask: bool = False


class CliResult(BaseModel):
    ok: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    # Text artifacts inline; binary ones base64-encoded under `files_b64`.
    files: dict[str, str] = Field(default_factory=dict)
    files_b64: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------- helpers
def _kicad_version() -> str:
    try:
        out = subprocess.run(
            [KICAD_CLI, "--version"], capture_output=True, text=True, timeout=10
        )
        return out.stdout.strip() or out.stderr.strip() or "unknown"
    except Exception as exc:  # pragma: no cover - defensive
        return f"unavailable: {exc}"


async def _run_cli(args: list[str], cwd: Path, timeout: int = DEFAULT_TIMEOUT_SEC) -> tuple[int, str, str, int]:
    """Run kicad-cli, never raising on a non-zero exit.

    A failed ERC is a normal, expected result that the caller must be able to read, not
    an exception — so the exit code comes back as data.
    """
    started = time.time()
    proc = await asyncio.create_subprocess_exec(
        KICAD_CLI,
        *args,
        cwd=str(cwd),
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
            detail=f"kicad-cli timed out after {timeout}s: {' '.join(args)}",
        )
    duration_ms = int((time.time() - started) * 1000)
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace"), duration_ms


def _stage(files: dict[str, str], primary_name: str, primary_content: str) -> Path:
    """Write a job's files into an isolated working directory."""
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix=f"{uuid.uuid4().hex[:8]}-", dir=str(WORK_ROOT)))
    (workdir / primary_name).write_text(primary_content, encoding="utf-8")
    for rel, content in files.items():
        # Reject path traversal: a caller must not be able to write outside its workdir.
        target = (workdir / rel).resolve()
        if not str(target).startswith(str(workdir.resolve())):
            raise HTTPException(status_code=400, detail=f"Illegal path in extra_files: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return workdir


def _collect(workdir: Path, outdir: Path, text_suffixes: set[str]) -> tuple[dict[str, str], dict[str, str]]:
    text: dict[str, str] = {}
    binary: dict[str, str] = {}
    if not outdir.exists():
        return text, binary
    for path in sorted(outdir.rglob("*")):
        if not path.is_file():
            continue
        rel = str(path.relative_to(outdir))
        if path.suffix.lower() in text_suffixes:
            text[rel] = path.read_text(encoding="utf-8", errors="replace")
        else:
            binary[rel] = base64.b64encode(path.read_bytes()).decode("ascii")
    return text, binary


def _cleanup(workdir: Path) -> None:
    shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------- endpoints
@app.get("/health")
async def health() -> JSONResponse:
    version = _kicad_version()
    available = not version.startswith("unavailable")
    return JSONResponse(
        status_code=200 if available else 503,
        content={
            "status": "ok" if available else "down",
            "service": "kicad",
            "version": "0.1.0",
            "kicad_version": version,
            "uptime_sec": int(time.time() - STARTED_AT),
        },
    )


@app.post("/sch/erc", response_model=CliResult)
async def sch_erc(job: SchematicJob) -> CliResult:
    """Run ERC. A non-zero exit means violations were found, which is a result, not an error."""
    workdir = _stage(job.extra_files, f"{job.name}.kicad_sch", job.schematic)
    try:
        report = f"{job.name}-erc.json"
        code, out, errs, ms = await _run_cli(
            ["sch", "erc", "--format", "json", "--output", report, f"{job.name}.kicad_sch"],
            workdir,
        )
        report_path = workdir / report
        files = {report: report_path.read_text(encoding="utf-8")} if report_path.exists() else {}
        return CliResult(ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms, files=files)
    finally:
        _cleanup(workdir)


@app.post("/sch/export/netlist", response_model=CliResult)
async def sch_netlist(job: SchematicJob, fmt: Literal["kicadsexpr", "spice", "orcadpcb2"] = "kicadsexpr") -> CliResult:
    workdir = _stage(job.extra_files, f"{job.name}.kicad_sch", job.schematic)
    try:
        out_name = f"{job.name}.net"
        code, out, errs, ms = await _run_cli(
            ["sch", "export", "netlist", "--format", fmt, "--output", out_name, f"{job.name}.kicad_sch"],
            workdir,
        )
        path = workdir / out_name
        files = {out_name: path.read_text(encoding="utf-8")} if path.exists() else {}
        return CliResult(ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms, files=files)
    finally:
        _cleanup(workdir)


@app.post("/sch/export/svg", response_model=CliResult)
async def sch_svg(job: SchematicJob) -> CliResult:
    workdir = _stage(job.extra_files, f"{job.name}.kicad_sch", job.schematic)
    try:
        outdir = workdir / "out"
        code, out, errs, ms = await _run_cli(
            ["sch", "export", "svg", "--output", "out", f"{job.name}.kicad_sch"], workdir
        )
        text, binary = _collect(workdir, outdir, {".svg"})
        return CliResult(
            ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms,
            files=text, files_b64=binary,
        )
    finally:
        _cleanup(workdir)


@app.post("/sch/export/pdf", response_model=CliResult)
async def sch_pdf(job: SchematicJob) -> CliResult:
    workdir = _stage(job.extra_files, f"{job.name}.kicad_sch", job.schematic)
    try:
        out_name = f"{job.name}.pdf"
        code, out, errs, ms = await _run_cli(
            ["sch", "export", "pdf", "--output", out_name, f"{job.name}.kicad_sch"], workdir
        )
        path = workdir / out_name
        b64 = {out_name: base64.b64encode(path.read_bytes()).decode("ascii")} if path.exists() else {}
        return CliResult(ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms, files_b64=b64)
    finally:
        _cleanup(workdir)


@app.post("/pcb/export/gerbers", response_model=CliResult)
async def pcb_gerbers(job: BoardJob, options: GerberOptions | None = None) -> CliResult:
    workdir = _stage(job.extra_files, f"{job.name}.kicad_pcb", job.board)
    try:
        args = ["pcb", "export", "gerbers", "--output", "out"]
        if options and options.layers:
            args += ["--layers", ",".join(options.layers)]
        if options and options.subtract_soldermask:
            args.append("--subtract-soldermask")
        args.append(f"{job.name}.kicad_pcb")

        code, out, errs, ms = await _run_cli(args, workdir)
        text, binary = _collect(workdir, workdir / "out", {".gbr", ".gm1", ".gbrjob"})
        return CliResult(
            ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms,
            files=text, files_b64=binary,
        )
    finally:
        _cleanup(workdir)


@app.post("/pcb/export/drill", response_model=CliResult)
async def pcb_drill(job: BoardJob) -> CliResult:
    workdir = _stage(job.extra_files, f"{job.name}.kicad_pcb", job.board)
    try:
        code, out, errs, ms = await _run_cli(
            ["pcb", "export", "drill", "--output", "out/", f"{job.name}.kicad_pcb"], workdir
        )
        text, binary = _collect(workdir, workdir / "out", {".drl", ".rpt"})
        return CliResult(
            ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms,
            files=text, files_b64=binary,
        )
    finally:
        _cleanup(workdir)


@app.post("/pcb/export/step", response_model=CliResult)
async def pcb_step(job: BoardJob) -> CliResult:
    workdir = _stage(job.extra_files, f"{job.name}.kicad_pcb", job.board)
    try:
        out_name = f"{job.name}.step"
        # STEP export loads 3D models and is the slowest verb here, so it gets room.
        code, out, errs, ms = await _run_cli(
            ["pcb", "export", "step", "--output", out_name, f"{job.name}.kicad_pcb"],
            workdir,
            timeout=DEFAULT_TIMEOUT_SEC * 2,
        )
        path = workdir / out_name
        b64 = {out_name: base64.b64encode(path.read_bytes()).decode("ascii")} if path.exists() else {}
        return CliResult(ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms, files_b64=b64)
    finally:
        _cleanup(workdir)


@app.post("/pcb/drc", response_model=CliResult)
async def pcb_drc(job: BoardJob) -> CliResult:
    """Run DRC. As with ERC, violations are a result the caller reads, not an exception."""
    workdir = _stage(job.extra_files, f"{job.name}.kicad_pcb", job.board)
    try:
        report = f"{job.name}-drc.json"
        code, out, errs, ms = await _run_cli(
            ["pcb", "drc", "--format", "json", "--output", report, f"{job.name}.kicad_pcb"],
            workdir,
        )
        path = workdir / report
        files = {report: path.read_text(encoding="utf-8")} if path.exists() else {}
        return CliResult(ok=code == 0, exit_code=code, stdout=out, stderr=errs, duration_ms=ms, files=files)
    finally:
        _cleanup(workdir)
