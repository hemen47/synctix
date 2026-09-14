"""Python EDA tooling service.

Some capabilities have no good JavaScript equivalent, so they live here behind HTTP
rather than being reimplemented badly in Node:

  * **kiutils** — read and write KiCad S-expression files with full fidelity. Used to
    verify our own KiCad export and to parse symbol/footprint libraries at M8.
  * **SKiDL** — programmatic netlist generation, used as an independent cross-check of
    the netlists our exporter produces.
  * **PySpice** — an alternative SPICE front end, used to validate simulation results
    from a second implementation at M6.

Every endpoint reports which libraries are actually importable, so a partially built
image degrades visibly instead of failing at the first request.
"""

from __future__ import annotations

import importlib
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

STARTED_AT = time.time()

app = FastAPI(
    title="SYNTRIX Python tools service",
    version="0.1.0",
    description="SKiDL, kiutils and PySpice behind HTTP.",
)

OPTIONAL_LIBS = ("skidl", "kiutils", "PySpice")


def _lib_status() -> dict[str, str]:
    """Report each optional library as its version or the reason it is unavailable."""
    status: dict[str, str] = {}
    for name in OPTIONAL_LIBS:
        try:
            mod = importlib.import_module(name)
            status[name] = getattr(mod, "__version__", "present")
        except Exception as exc:
            status[name] = f"unavailable: {type(exc).__name__}"
    return status


def _require(name: str) -> Any:
    try:
        return importlib.import_module(name)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"{name} is not available in this image: {exc}",
        )


class KicadParseJob(BaseModel):
    content: str = Field(..., description="Contents of a .kicad_sch or .kicad_pcb file")
    kind: str = Field("schematic", description="'schematic' or 'board'")


class KicadParseResult(BaseModel):
    ok: bool
    kind: str
    # A structural summary rather than the whole tree: the caller wants to know the file
    # parses and what is in it, not to receive it back verbatim.
    summary: dict[str, Any]


@app.get("/health")
async def health() -> JSONResponse:
    libs = _lib_status()
    # The service is useful even with one library missing, so health reports detail
    # rather than collapsing to a single boolean.
    degraded = any(v.startswith("unavailable") for v in libs.values())
    return JSONResponse(
        status_code=200,
        content={
            "status": "degraded" if degraded else "ok",
            "service": "pytools",
            "version": "0.1.0",
            "uptime_sec": int(time.time() - STARTED_AT),
            "libraries": libs,
        },
    )


@app.post("/kicad/parse", response_model=KicadParseResult)
async def kicad_parse(job: KicadParseJob) -> KicadParseResult:
    """Parse a KiCad file with kiutils and summarise it.

    This is how M5 verifies our KiCad exporter: a file that kiutils cannot parse is not
    a valid KiCad file, whatever kicad-cli's exit code says.
    """
    kiutils = _require("kiutils")

    if job.kind == "schematic":
        from kiutils.schematic import Schematic  # type: ignore[import-not-found]

        sch = Schematic().from_string(job.content)
        return KicadParseResult(
            ok=True,
            kind="schematic",
            summary={
                "version": sch.version,
                "symbol_count": len(sch.schematicSymbols),
                "wire_count": len(sch.graphicalItems),
                "label_count": len(sch.labels) + len(sch.globalLabels),
                "refdes": sorted(
                    p.value
                    for s in sch.schematicSymbols
                    for p in s.properties
                    if p.key == "Reference"
                ),
            },
        )

    if job.kind == "board":
        from kiutils.board import Board  # type: ignore[import-not-found]

        board = Board().from_string(job.content)
        return KicadParseResult(
            ok=True,
            kind="board",
            summary={
                "version": board.version,
                "footprint_count": len(board.footprints),
                "trace_count": len(board.traceItems),
                "layer_count": len(board.layers),
                "net_count": len(board.nets),
            },
        )

    raise HTTPException(status_code=400, detail="kind must be 'schematic' or 'board'")


@app.get("/capabilities")
async def capabilities() -> dict[str, Any]:
    """What this image can actually do, for the API's service registry."""
    libs = _lib_status()
    return {
        "libraries": libs,
        "endpoints": {
            "/kicad/parse": "kiutils" in libs and not libs["kiutils"].startswith("unavailable"),
        },
    }
