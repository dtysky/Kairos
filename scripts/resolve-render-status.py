#!/usr/bin/env python3
"""Read the current Resolve render state without mutating the project."""

import importlib.util
import json
import sys
from pathlib import Path


def load_host_module():
    host_path = Path(__file__).resolve().parents[1] / "vendor" / "resolve-color-host" / "resolve-color-host.py"
    spec = importlib.util.spec_from_file_location("kairos_resolve_color_host", host_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Resolve host module: {host_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def job_id(row):
    if not isinstance(row, dict):
        return None
    return row.get("JobId") or row.get("JobID") or row.get("jobId")


def status_text(status):
    if not isinstance(status, dict):
        return ""
    return str(status.get("JobStatus") or status.get("Status") or status.get("status") or "").strip()


def main():
    host = load_host_module()
    resolve = host.load_resolve()
    manager = host.safe_call(resolve, "GetProjectManager")
    project = host.safe_call(manager, "GetCurrentProject") if manager else None
    if project is None:
        raise RuntimeError("Resolve has no current project")

    rendering = bool(host.safe_call(project, "IsRenderingInProgress"))
    render_jobs = host.safe_call(project, "GetRenderJobList") or []
    jobs = []
    active_statuses = {"rendering", "queued", "ready", "waiting"}
    has_active_job = False
    has_incomplete_job = False
    for row in render_jobs if isinstance(render_jobs, list) else []:
        current_id = job_id(row)
        status = host.safe_call(project, "GetRenderJobStatus", current_id) if current_id else {}
        current_status = status_text(status)
        completion = status.get("CompletionPercentage") if isinstance(status, dict) else None
        has_active_job = has_active_job or current_status.lower() in active_statuses
        has_incomplete_job = has_incomplete_job or (
            isinstance(completion, (int, float)) and completion < 100
        )
        jobs.append({"jobId": current_id, "status": status})

    payload = {
        "connected": True,
        "projectName": host.safe_call(project, "GetName"),
        "isRenderingInProgress": rendering,
        "hasActiveRenderJob": has_active_job,
        "hasIncompleteRenderJob": has_incomplete_job,
        "renderFinished": not rendering and not has_active_job and not has_incomplete_job,
        "jobs": jobs,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"connected": False, "renderFinished": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(2)
