from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib import error as urlerror
from urllib import request as urlrequest


PLUGIN_VERSION = "0.1.11"
DEFAULT_TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
DEFAULT_CLONE_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/voice_clone"
DEFAULT_RESOURCE_ID = "seed-icl-2.0"
DEFAULT_FORMAT = "mp3"
DEFAULT_SAMPLE_RATE = 24000


class VoiceoverError(RuntimeError):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def safe_segment(value: Any, fallback: str = "unnamed") -> str:
    text = str(value or "").strip()
    if not text:
        text = fallback
    text = re.sub(r"[^A-Za-z0-9._ -]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:80] or fallback


def stable_hash(value: Any, length: int = 16) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:length]


def unit_id_for_subtitle(timeline_id: str, subtitle: Dict[str, Any]) -> str:
    payload = {
        "timelineId": timeline_id,
        "trackIndex": subtitle.get("trackIndex"),
        "subtitleIndex": subtitle.get("subtitleIndex"),
        "startFrame": subtitle.get("startFrame"),
        "endFrame": subtitle.get("endFrame"),
        "text": subtitle.get("text"),
    }
    return "vo_" + stable_hash(payload, 20)


def request_hash(text: str, settings: Dict[str, Any]) -> str:
    return stable_hash({"text": text, "settings": settings}, 24)


def frames_to_ms(frames: Any, fps: float) -> Optional[float]:
    try:
        frame_value = float(frames)
    except (TypeError, ValueError):
        return None
    if fps <= 0:
        return None
    return frame_value * 1000.0 / fps


def timecode_to_frame(timecode: str, fps: float) -> Optional[int]:
    if not timecode or fps <= 0:
        return None
    match = re.match(r"^(\d+):(\d+):(\d+)[:;](\d+(?:\.\d+)?)$", str(timecode).strip())
    if not match:
        return None
    hours, minutes, seconds, frames = match.groups()
    total_seconds = int(hours) * 3600 + int(minutes) * 60 + int(seconds)
    return int(round(total_seconds * fps + float(frames)))


def frame_to_timecode(frame: Any, fps: float) -> str:
    try:
        frame_value = int(round(float(frame)))
    except (TypeError, ValueError):
        frame_value = 0
    if fps <= 0:
        fps = 24.0
    frames_per_second = int(round(fps))
    total_seconds, frame_part = divmod(max(frame_value, 0), frames_per_second)
    hours, rem = divmod(total_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frame_part:02d}"


def extract_subtitle_text(summary: Dict[str, Any]) -> str:
    candidates: List[Any] = [summary.get("name")]
    for key in ("property", "clipProperty"):
        value = summary.get(key)
        if isinstance(value, dict):
            candidates.extend([
                value.get("Text"),
                value.get("Subtitle"),
                value.get("Caption"),
                value.get("Name"),
            ])
    for candidate in candidates:
        text = stringify(candidate)
        if text:
            return clean_subtitle_text(text)
    return ""


def clean_subtitle_text(value: Any) -> str:
    text = stringify(value)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\\N", "\n")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _subtitle_sort_key(row: Dict[str, Any]) -> Tuple[float, float, float]:
    def number(value: Any, fallback: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return fallback

    return (
        number(row.get("startFrame")),
        number(row.get("trackIndex")),
        number(row.get("subtitleIndex")),
    )


def _join_subtitle_texts_for_tts(rows: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    terminal = set("。！？!?；;，,、：:")
    for row in rows:
        text = clean_subtitle_text(row.get("text"))
        if not text:
            continue
        if parts and parts[-1][-1:] not in terminal:
            parts[-1] = parts[-1] + "。"
        parts.append(text)
    return "\n".join(parts)


def merge_selected_subtitles_for_synthesis(subtitles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = [row for row in subtitles if isinstance(row, dict)]
    if len(rows) <= 1:
        return rows
    sorted_rows = sorted(rows, key=_subtitle_sort_key)
    text = _join_subtitle_texts_for_tts(sorted_rows)
    first = sorted_rows[0]
    last = sorted_rows[-1]

    def number(value: Any) -> Optional[float]:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    start_frame = number(first.get("startFrame"))
    end_frames = [number(row.get("endFrame")) for row in sorted_rows]
    end_frame = max((value for value in end_frames if value is not None), default=number(last.get("endFrame")))
    duration_frames = (
        end_frame - start_frame
        if start_frame is not None and end_frame is not None
        else None
    )
    timeline_in_ms = number(first.get("timelineInMs"))
    timeline_out_values = [number(row.get("timelineOutMs")) for row in sorted_rows]
    timeline_out_ms = max((value for value in timeline_out_values if value is not None), default=number(last.get("timelineOutMs")))
    duration_ms = (
        timeline_out_ms - timeline_in_ms
        if timeline_in_ms is not None and timeline_out_ms is not None
        else None
    )
    source_ids = [
        row.get("subtitleIndex")
        for row in sorted_rows
        if row.get("subtitleIndex") is not None
    ]
    merged = {
        **first,
        "name": text,
        "text": text,
        "startFrame": start_frame if start_frame is not None else first.get("startFrame"),
        "endFrame": end_frame if end_frame is not None else last.get("endFrame"),
        "durationFrames": duration_frames if duration_frames is not None else first.get("durationFrames"),
        "timelineInMs": timeline_in_ms if timeline_in_ms is not None else first.get("timelineInMs"),
        "timelineOutMs": timeline_out_ms if timeline_out_ms is not None else last.get("timelineOutMs"),
        "durationMs": duration_ms if duration_ms is not None else first.get("durationMs"),
        "endTimecode": last.get("endTimecode") or first.get("endTimecode"),
        "subtitleIndex": "-".join(str(value) for value in source_ids) or first.get("subtitleIndex"),
        "sourceSubtitleIds": source_ids,
        "sourceSubtitles": sorted_rows,
        "isMergedGroup": True,
        "groupSize": len(sorted_rows),
    }
    return [merged]


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    if isinstance(value, (dict, list, tuple)):
        return ""
    return str(value).strip()


def default_config_path() -> Path:
    return Path.home() / "Movies" / "KairosVoiceover" / "config.local.json"


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    config_path = path or default_config_path()
    if not config_path.exists():
        return {}
    with config_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_config(config: Dict[str, Any], path: Optional[Path] = None) -> Path:
    config_path = path or default_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with config_path.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    try:
        os.chmod(str(config_path), stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return config_path


def build_run_dir(project_name: str, timeline_id: str, run_id: Optional[str] = None) -> Path:
    current_run_id = run_id or time.strftime("%Y%m%d-%H%M%S")
    return (
        Path.home()
        / "Movies"
        / "KairosVoiceover"
        / safe_segment(project_name, "project")
        / safe_segment(timeline_id, "timeline")
        / safe_segment(current_run_id, "run")
    )


def load_json_file(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def strip_resolve_project_suffix(name: str) -> str:
    return re.sub(r"\s+\[(?:Edit|Color)\]\s*$", "", str(name or "").strip(), flags=re.IGNORECASE)


def _voiceover_match_keys(project_id: str, brief: Dict[str, Any]) -> List[str]:
    keys = [project_id, strip_resolve_project_suffix(project_id)]
    brief_name = stringify(brief.get("name"))
    if brief_name:
        keys.extend([brief_name, strip_resolve_project_suffix(brief_name)])
    voiceover_media = brief.get("voiceoverMedia")
    aliases = voiceover_media.get("resolveProjectAliases") if isinstance(voiceover_media, dict) else None
    if isinstance(aliases, list):
        for alias in aliases:
            alias_text = stringify(alias)
            if alias_text:
                keys.extend([alias_text, strip_resolve_project_suffix(alias_text)])
    return [key for key in dict.fromkeys(keys) if key]


def find_kairos_project_for_resolve(workspace_root: Path, resolve_project_name: str) -> Dict[str, Any]:
    projects_root = workspace_root / "projects"
    if not projects_root.exists():
        raise VoiceoverError(
            "voiceover_projects_root_missing",
            f"Kairos projects directory is missing: {projects_root}",
        )

    wanted = {
        stringify(resolve_project_name),
        strip_resolve_project_suffix(resolve_project_name),
    }
    wanted = {value for value in wanted if value}
    matches: List[Dict[str, Any]] = []
    for project_dir in sorted(projects_root.iterdir()):
        if not project_dir.is_dir():
            continue
        brief_path = project_dir / "config" / "project-brief.json"
        if not brief_path.exists():
            continue
        try:
            brief = load_json_file(brief_path)
        except Exception:
            continue
        keys = set(_voiceover_match_keys(project_dir.name, brief))
        if keys.intersection(wanted):
            matches.append({
                "projectId": project_dir.name,
                "projectRoot": str(project_dir),
                "projectBriefPath": str(brief_path),
                "projectName": stringify(brief.get("name")) or project_dir.name,
                "brief": brief,
                "matchedKeys": sorted(keys.intersection(wanted)),
            })

    if not matches:
        raise VoiceoverError(
            "voiceover_project_not_found",
            "Current Resolve project does not match any Kairos project brief name.",
            {
                "resolveProjectName": resolve_project_name,
                "workspaceRoot": str(workspace_root),
                "expected": "Set project-brief.json name to the Resolve project name, use the [Edit]/[Color] naming convention, or add voiceoverMedia.resolveProjectAliases[].",
            },
        )
    if len(matches) > 1:
        raise VoiceoverError(
            "voiceover_project_ambiguous",
            "Current Resolve project matches multiple Kairos projects.",
            {
                "resolveProjectName": resolve_project_name,
                "matches": [
                    {
                        "projectId": match["projectId"],
                        "projectName": match["projectName"],
                        "projectRoot": match["projectRoot"],
                    }
                    for match in matches
                ],
            },
        )
    return matches[0]


def _is_non_native_drive_path(path_text: str) -> bool:
    return os.name != "nt" and bool(re.match(r"^[A-Za-z]:[\\/]", path_text.strip()))


def _nearest_existing_parent(path: Path) -> Optional[Path]:
    current = path.parent
    while current and current != current.parent:
        if current.exists():
            return current
        current = current.parent
    return current if current and current.exists() else None


def _probe_voiceover_root(path_text: str) -> Dict[str, Any]:
    if not stringify(path_text):
        return {"usable": False, "reason": "empty_path"}
    if _is_non_native_drive_path(path_text):
        return {"usable": False, "reason": "non_native_drive_path"}
    path = Path(path_text).expanduser()
    if not path.is_absolute():
        return {"usable": False, "expandedPath": str(path), "reason": "path_not_absolute"}
    created = False
    try:
        if path.exists():
            if not path.is_dir():
                return {"usable": False, "expandedPath": str(path), "reason": "not_directory"}
        else:
            parent = _nearest_existing_parent(path)
            if not parent or not os.access(str(parent), os.W_OK):
                return {
                    "usable": False,
                    "expandedPath": str(path),
                    "reason": "parent_not_writable",
                }
            path.mkdir(parents=True, exist_ok=True)
            created = True
        if not os.access(str(path), os.W_OK):
            return {"usable": False, "expandedPath": str(path), "reason": "not_writable"}
    except OSError as exc:
        return {
            "usable": False,
            "expandedPath": str(path),
            "reason": "mkdir_failed",
            "error": str(exc),
        }
    return {"usable": True, "expandedPath": str(path), "created": created}


def _voiceover_media_candidates(media: Dict[str, Any]) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []
    primary = stringify(media.get("path"))
    if primary:
        candidates.append({"source": "primary", "index": 0, "configuredPath": primary})
    alternates = media.get("alternatePaths")
    if isinstance(alternates, list):
        for index, entry in enumerate(alternates, start=1):
            if not isinstance(entry, dict):
                continue
            path = stringify(entry.get("path"))
            if path:
                candidates.append({"source": "alternate", "index": index, "configuredPath": path})
    return candidates


def resolve_project_voiceover_media(project_match: Dict[str, Any]) -> Dict[str, Any]:
    brief = project_match.get("brief")
    media = brief.get("voiceoverMedia") if isinstance(brief, dict) else None
    if not isinstance(media, dict) or not stringify(media.get("path")):
        raise VoiceoverError(
            "voiceover_media_missing",
            "Project voiceoverMedia.path is not configured in config/project-brief.json.",
            {
                "projectId": project_match.get("projectId"),
                "projectBriefPath": project_match.get("projectBriefPath"),
                "example": {
                    "voiceoverMedia": {
                        "rootId": "voiceover",
                        "path": "/Volumes/YourMedia/KairosVoiceover/project",
                        "alternatePaths": [{"path": "F:\\\\KairosVoiceover\\\\project"}],
                    },
                },
            },
        )

    probed = []
    selected: Optional[Dict[str, Any]] = None
    for candidate in _voiceover_media_candidates(media):
        result = _probe_voiceover_root(candidate["configuredPath"])
        record = {**candidate, **result}
        probed.append(record)
        if record.get("usable") and selected is None:
            selected = record
    if selected is None:
        raise VoiceoverError(
            "voiceover_media_unwritable",
            "No project voiceoverMedia path is writable on this device.",
            {
                "projectId": project_match.get("projectId"),
                "projectBriefPath": project_match.get("projectBriefPath"),
                "candidates": probed,
            },
        )

    return {
        "rootId": stringify(media.get("rootId")) or "voiceover",
        "description": stringify(media.get("description")),
        "selected": selected,
        "candidates": probed,
    }


def build_project_voiceover_run_dir(
    workspace_root: Path,
    resolve_project_name: str,
    timeline_id: str,
    run_id: Optional[str] = None,
    timeline_name: Optional[str] = None,
) -> Tuple[Path, Dict[str, Any]]:
    project = find_kairos_project_for_resolve(workspace_root, resolve_project_name)
    media = resolve_project_voiceover_media(project)
    current_run_id = str(run_id or "").strip()
    current_timeline_name = stringify(timeline_name) or stringify(timeline_id) or "timeline"
    relative_run_dir = Path(
        safe_segment(resolve_project_name, "resolve-project"),
        safe_segment(current_timeline_name, "timeline"),
    )
    selected_root = Path(str(media["selected"]["expandedPath"]))
    run_dir = selected_root / relative_run_dir
    metadata = {
        "outputLayoutVersion": "project-timeline-mp3-v1",
        "projectId": project["projectId"],
        "projectRoot": project["projectRoot"],
        "projectBriefPath": project["projectBriefPath"],
        "projectName": project["projectName"],
        "resolveProjectName": resolve_project_name,
        "timelineId": timeline_id,
        "timelineName": current_timeline_name,
        "runId": current_run_id,
        "rootId": media["rootId"],
        "description": media.get("description") or "",
        "selectedRootPath": str(selected_root),
        "selectedSource": media["selected"].get("source"),
        "selectedAlternateIndex": media["selected"].get("index") if media["selected"].get("source") == "alternate" else None,
        "relativeRunDir": relative_run_dir.as_posix(),
        "candidates": media["candidates"],
    }
    return run_dir, metadata


def build_project_plugin_tmp_dir(workspace_root: Path, resolve_project_name: str) -> Tuple[Path, Dict[str, Any]]:
    project = find_kairos_project_for_resolve(workspace_root, resolve_project_name)
    tmp_dir = Path(project["projectRoot"]) / ".tmp" / "resolve-volc-voiceover-plugin"
    metadata = {
        "projectId": project["projectId"],
        "projectRoot": project["projectRoot"],
        "projectBriefPath": project["projectBriefPath"],
        "projectName": project["projectName"],
        "resolveProjectName": resolve_project_name,
        "tmpDir": str(tmp_dir),
    }
    return tmp_dir, metadata


def _relative_to_root(path: Path, root: Optional[Path]) -> Optional[str]:
    if root is None:
        return None
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        try:
            return path.relative_to(root).as_posix()
        except Exception:
            return None


def ensure_run_dirs(run_dir: Path, cache_root: Optional[Path] = None) -> Dict[str, Path]:
    paths = {
        "run": run_dir,
        "media": run_dir,
        "cache": cache_root or Path.home() / "Movies" / "KairosVoiceover" / ".cache",
    }
    for path in paths.values():
        path.mkdir(parents=True, exist_ok=True)
    return paths


def find_ffmpeg() -> Optional[str]:
    for candidate in (
        shutil.which("ffmpeg"),
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def transcode_for_resolve(input_path: Path, output_path: Path, ffmpeg_path: Optional[str] = None) -> Tuple[Path, Dict[str, Any]]:
    ffmpeg = ffmpeg_path or find_ffmpeg()
    if not ffmpeg:
        return input_path, {"transcoded": False, "reason": "ffmpeg_not_found"}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ac",
        "1",
        "-ar",
        "48000",
        str(output_path),
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        return input_path, {
            "transcoded": False,
            "reason": "ffmpeg_failed",
            "stderr": result.stderr.strip()[-1000:],
        }
    return output_path, {"transcoded": True, "ffmpeg": ffmpeg}


def probe_duration_ms(path: Path) -> Optional[float]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        for candidate in ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"):
            if Path(candidate).exists():
                ffprobe = candidate
                break
    if not ffprobe:
        return None
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        return None
    try:
        seconds = float(result.stdout.strip())
    except ValueError:
        return None
    if not math.isfinite(seconds):
        return None
    return seconds * 1000.0


@dataclass
class TtsSettings:
    api_key: str
    speaker: str
    resource_id: str = DEFAULT_RESOURCE_ID
    endpoint: str = DEFAULT_TTS_ENDPOINT
    audio_format: str = DEFAULT_FORMAT
    sample_rate: int = DEFAULT_SAMPLE_RATE
    model: str = ""
    language: str = "zh-cn"
    speed_ratio: Optional[float] = None
    loudness_ratio: Optional[float] = None
    context_text: str = ""

    def to_request_params(self, text: str) -> Dict[str, Any]:
        audio_params: Dict[str, Any] = {
            "format": self.audio_format,
            "sample_rate": self.sample_rate,
        }
        params: Dict[str, Any] = {
            "text": text,
            "speaker": self.speaker,
            "audio_params": audio_params,
            "explicit_language": self.language,
        }
        if self.model:
            params["model"] = self.model
        if self.context_text:
            params["context_texts"] = [self.context_text]
        if self.speed_ratio is not None:
            params["speed_ratio"] = self.speed_ratio
        if self.loudness_ratio is not None:
            params["loudness_ratio"] = self.loudness_ratio
        return params

    def public_dict(self) -> Dict[str, Any]:
        return {
            "speaker": self.speaker,
            "resourceId": self.resource_id,
            "endpoint": self.endpoint,
            "audioFormat": self.audio_format,
            "sampleRate": self.sample_rate,
            "model": self.model,
            "language": self.language,
            "speedRatio": self.speed_ratio,
            "loudnessRatio": self.loudness_ratio,
            "contextText": self.context_text,
        }


class VolcTtsClient:
    def synthesize(self, text: str, settings: TtsSettings, request_id: Optional[str] = None) -> Dict[str, Any]:
        if not settings.api_key:
            raise VoiceoverError("volc_api_key_missing", "Volcengine API key is required.")
        if not settings.speaker:
            raise VoiceoverError("volc_speaker_missing", "Volcengine speaker id is required.")
        current_request_id = request_id or str(uuid.uuid4())
        payload = {"req_params": settings.to_request_params(text)}
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urlrequest.Request(
            settings.endpoint,
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-Api-Key": settings.api_key,
                "X-Api-Resource-Id": settings.resource_id,
                "X-Api-Request-Id": current_request_id,
                "X-Control-Require-Usage-Tokens-Return": "*",
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=120) as response:
                body = response.read()
                headers = dict(response.headers.items())
        except urlerror.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise VoiceoverError(
                "volc_tts_http_error",
                f"Volcengine TTS HTTP {exc.code}: {body[:500]}",
                {"status": exc.code, "body": body[:2000], "requestId": current_request_id},
            )
        except urlerror.URLError as exc:
            raise VoiceoverError(
                "volc_tts_network_error",
                f"Volcengine TTS network error: {exc}",
                {"requestId": current_request_id},
            )

        parsed = parse_tts_response(body)
        parsed["requestId"] = current_request_id
        parsed["headers"] = {
            key: value
            for key, value in headers.items()
            if key.lower() in {"x-tt-logid", "x-request-id", "content-type"}
        }
        return parsed


def parse_tts_response(body: bytes) -> Dict[str, Any]:
    if not body:
        raise VoiceoverError("volc_tts_empty_response", "Volcengine TTS returned an empty body.")

    text = body.decode("utf-8", errors="ignore").strip()
    json_objects = parse_json_objects(text)
    audio_chunks: List[bytes] = []
    events: List[Dict[str, Any]] = []
    usage: Dict[str, Any] = {}
    subtitles: List[Dict[str, Any]] = []

    for obj in json_objects:
        if not isinstance(obj, dict):
            continue
        events.append(obj)
        usage_candidate = obj.get("usage") or obj.get("Usage")
        if isinstance(usage_candidate, dict):
            usage.update(usage_candidate)
        subtitles_candidate = obj.get("subtitles") or obj.get("subtitle") or obj.get("words")
        if isinstance(subtitles_candidate, list):
            subtitles.extend(item for item in subtitles_candidate if isinstance(item, dict))
        chunk = extract_audio_payload(obj)
        if chunk:
            audio_chunks.append(chunk)
        code = obj.get("code") or obj.get("Code")
        if code not in (None, 0, 3000, 20000000, "0", "3000", "20000000"):
            message = stringify(obj.get("message") or obj.get("Message") or obj.get("msg"))
            raise VoiceoverError(
                "volc_tts_provider_error",
                message or f"Volcengine TTS returned code {code}.",
                {"provider": obj},
            )

    if audio_chunks:
        return {
            "audio": b"".join(audio_chunks),
            "events": events,
            "usage": usage,
            "subtitles": subtitles,
        }

    direct = extract_audio_payload({"data": text}) if not json_objects else b""
    if direct:
        return {"audio": direct, "events": json_objects, "usage": usage, "subtitles": subtitles}

    # Some gateways may already return binary audio.
    if looks_like_audio(body):
        return {"audio": body, "events": json_objects, "usage": usage, "subtitles": subtitles}

    raise VoiceoverError(
        "volc_tts_audio_missing",
        "Unable to find audio data in Volcengine TTS response.",
        {"bodyPreview": text[:1000]},
    )


def parse_json_objects(text: str) -> List[Any]:
    if not text:
        return []
    try:
        return [json.loads(text)]
    except json.JSONDecodeError:
        pass
    result: List[Any] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if result:
        return result
    decoder = json.JSONDecoder()
    index = 0
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        try:
            value, next_index = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            next_start = min(
                candidate for candidate in (
                    text.find("{", index + 1),
                    text.find("[", index + 1),
                )
                if candidate >= 0
            ) if ("{" in text[index + 1:] or "[" in text[index + 1:]) else -1
            if next_start < 0:
                break
            index = next_start
            continue
        result.append(value)
        index = next_index
    return result


def extract_audio_payload(obj: Dict[str, Any]) -> bytes:
    candidates: List[Any] = [
        obj.get("audio"),
        obj.get("data"),
        obj.get("payload"),
        obj.get("audio_data"),
        obj.get("Audio"),
        obj.get("Data"),
    ]
    result = obj.get("result")
    if isinstance(result, dict):
        candidates.extend([
            result.get("audio"),
            result.get("data"),
            result.get("audio_data"),
        ])
    for candidate in candidates:
        if isinstance(candidate, bytes):
            return candidate
        if isinstance(candidate, str):
            decoded = maybe_b64decode(candidate)
            if decoded:
                return decoded
    return b""


def maybe_b64decode(text: str) -> bytes:
    stripped = text.strip()
    if not stripped or len(stripped) < 4:
        return b""
    if stripped.startswith("data:") and "," in stripped:
        stripped = stripped.split(",", 1)[1]
    try:
        return base64.b64decode(stripped, validate=False)
    except Exception:
        return b""


def looks_like_audio(body: bytes) -> bool:
    return body.startswith(b"ID3") or body.startswith(b"RIFF") or body.startswith(b"OggS") or body.startswith(b"\xff\xfb")


class VoiceCloneClient:
    def create_clone(
        self,
        api_key: str,
        speaker_id: str,
        audio_path: Path,
        demo_text: str,
        language: str = "cn",
        custom_speaker_id: str = "",
        endpoint: str = DEFAULT_CLONE_ENDPOINT,
        consent_confirmed: bool = False,
    ) -> Dict[str, Any]:
        if not consent_confirmed:
            raise VoiceoverError("voice_clone_consent_required", "Voice owner consent is required before cloning.")
        if not api_key:
            raise VoiceoverError("volc_api_key_missing", "Volcengine API key is required.")
        if not audio_path.exists():
            raise VoiceoverError("voice_clone_audio_missing", f"Prompt audio does not exist: {audio_path}")
        size = audio_path.stat().st_size
        if size > 10 * 1024 * 1024:
            raise VoiceoverError("voice_clone_audio_too_large", "Prompt audio must be 10MB or smaller.")
        extension = audio_path.suffix.lower().lstrip(".")
        if extension not in {"wav", "mp3", "ogg", "m4a", "aac", "pcm"}:
            raise VoiceoverError("voice_clone_audio_format", "Prompt audio must be wav/mp3/ogg/m4a/aac/pcm.")
        audio_b64 = base64.b64encode(audio_path.read_bytes()).decode("ascii")
        request_id = str(uuid.uuid4())
        payload: Dict[str, Any] = {
            "speaker_id": speaker_id,
            "audio": {"data": audio_b64, "format": extension},
            "language": language,
            "demo_text": demo_text,
        }
        if custom_speaker_id:
            payload["custom_speaker_id"] = custom_speaker_id
        req = urlrequest.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Api-Key": api_key,
                "X-Api-Request-Id": request_id,
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=120) as response:
                body = response.read().decode("utf-8", errors="replace")
                headers = dict(response.headers.items())
        except urlerror.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise VoiceoverError(
                "voice_clone_http_error",
                f"Volcengine voice clone HTTP {exc.code}: {body[:500]}",
                {"status": exc.code, "body": body[:2000], "requestId": request_id},
            )
        try:
            parsed = json.loads(body) if body.strip() else {}
        except json.JSONDecodeError:
            parsed = {"rawBody": body}
        return {
            "requestId": request_id,
            "headers": {
                key: value
                for key, value in headers.items()
                if key.lower() in {"x-tt-logid", "x-request-id", "content-type"}
            },
            "response": parsed,
        }


def synthesize_unit(
    subtitle: Dict[str, Any],
    timeline_id: str,
    run_dir: Path,
    settings: TtsSettings,
    client: Optional[VolcTtsClient] = None,
    force: bool = False,
    cache_root: Optional[Path] = None,
    artifact_root: Optional[Path] = None,
) -> Dict[str, Any]:
    text = clean_subtitle_text(subtitle.get("text"))
    if not text:
        raise VoiceoverError("subtitle_text_missing", "Selected subtitle has no readable text.", {"subtitle": subtitle})

    paths = ensure_run_dirs(run_dir, cache_root=cache_root)
    unit_id = unit_id_for_subtitle(timeline_id, subtitle)
    settings_public = settings.public_dict()
    cache_key = request_hash(text, settings_public)
    raw_ext = settings.audio_format.lower().lstrip(".") or "mp3"
    raw_path = paths["media"] / f"{unit_id}_{cache_key[:8]}.{raw_ext}"
    cache_path = paths["cache"] / f"{cache_key}.{raw_ext}"

    request_id = ""
    provider: Dict[str, Any] = {}
    cache_hit = False

    if cache_path.exists() and not force:
        raw_path.write_bytes(cache_path.read_bytes())
        cache_hit = True
    else:
        result = (client or VolcTtsClient()).synthesize(text, settings)
        request_id = result.get("requestId", "")
        provider = {
            "headers": result.get("headers", {}),
            "usage": result.get("usage", {}),
            "eventCount": len(result.get("events") or []),
            "subtitleCount": len(result.get("subtitles") or []),
        }
        raw_path.write_bytes(result["audio"])
        cache_path.write_bytes(result["audio"])

    import_path = raw_path
    transcode = {"transcoded": False, "reason": "direct_media_file"}
    duration_ms = probe_duration_ms(import_path)
    target_ms = subtitle.get("durationMs")
    overflow_ms = None
    duration_status = "unknown"
    if duration_ms is not None and isinstance(target_ms, (int, float)):
        overflow_ms = duration_ms - float(target_ms)
        duration_status = "overflow" if overflow_ms > 250 else "ok"

    return {
        "unitId": unit_id,
        "requestId": request_id,
        "requestHash": cache_key,
        "cacheHit": cache_hit,
        "text": text,
        "subtitle": subtitle,
        "settings": settings_public,
        "audioPath": str(import_path),
        "audioRelativePath": _relative_to_root(import_path, artifact_root),
        "rawAudioPath": str(raw_path),
        "resolveAudioPath": str(import_path),
        "rawAudioRelativePath": _relative_to_root(raw_path, artifact_root),
        "resolveAudioRelativePath": _relative_to_root(import_path, artifact_root),
        "provider": provider,
        "transcode": transcode,
        "durationMs": duration_ms,
        "targetDurationMs": target_ms,
        "overflowMs": overflow_ms,
        "durationStatus": duration_status,
    }


def write_manifest(run_dir: Path, manifest: Dict[str, Any]) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = run_dir / "manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest_path
