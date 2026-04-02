#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = REPO_ROOT / "vendor" / "pyJianYingDraft"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from pyJianYingDraft import (  # type: ignore
    AudioMaterial,
    AudioSegment,
    ClipSettings,
    DraftFolder,
    ScriptFile,
    TextSegment,
    TextStyle,
    TrackType,
    VideoMaterial,
    VideoSegment,
)
from pyJianYingDraft.metadata import TransitionType  # type: ignore
from pyJianYingDraft.time_util import Timerange  # type: ignore


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export a Kairos Jianying manifest with vendored pyJianYingDraft.",
    )
    parser.add_argument("--manifest", required=True, help="Path to the JSON manifest file.")
    args = parser.parse_args()

    try:
        manifest_path = Path(args.manifest).resolve()
        manifest = load_json(manifest_path)
        result = export_manifest(manifest)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover - exercised via the Node runner
        payload = {
            "code": "jianying_export_failed",
            "message": str(exc),
            "details": {
                "type": type(exc).__name__,
                "traceback": traceback.format_exc(),
            },
        }
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1


def export_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    spec = manifest["spec"]
    output_path = Path(manifest["outputPath"]).resolve()
    output_root = output_path.parent
    draft_name = output_path.name
    output_root.mkdir(parents=True, exist_ok=True)

    draft_folder = DraftFolder(str(output_root))
    script = draft_folder.create_draft(
        draft_name,
        width=int(spec["timeline"]["resolution"]["width"]),
        height=int(spec["timeline"]["resolution"]["height"]),
        fps=int(spec["timeline"]["fps"]),
        allow_replace=False,
    )
    # Current Jianying builds expect the main draft payload as `draft_info.json`.
    script.save_path = str(output_path / "draft_info.json")

    messages: List[Dict[str, str]] = []
    create_tracks(script, spec["tracks"])
    create_media_segments(script, spec["clips"], messages)
    create_text_segments(script, spec["subtitles"])
    script.save()
    draft_material_count = patch_draft_meta(output_path, draft_name, script)
    if draft_material_count:
        messages.append({
            "code": "draft_material_library_written",
            "level": "info",
            "message": (
                "Registered media in Jianying material library metadata "
                f"({draft_material_count} items)."
            ),
        })
    material_count, segment_count = patch_local_material_registry(output_path, script)
    if material_count or segment_count:
        messages.append({
            "code": "local_material_registry_written",
            "level": "info",
            "message": (
                "Registered local media in Jianying root metadata "
                f"({material_count} materials, {segment_count} segments)."
            ),
        })

    return {
        "backend": "pyjianyingdraft",
        "outputPath": str(output_path),
        "messages": messages,
    }


def create_tracks(script: ScriptFile, tracks: List[Dict[str, Any]]) -> None:
    for track in tracks:
        kind = str(track["kind"])
        if kind == "video":
            track_type = TrackType.video
        elif kind == "audio":
            track_type = TrackType.audio
        elif kind == "text":
            track_type = TrackType.text
        else:
            raise ValueError(f"Unsupported Jianying track kind: {kind}")

        script.add_track(
            track_type,
            track_name=str(track["name"]),
            relative_index=int(track.get("relativeIndex", 0)),
        )


def create_media_segments(
    script: ScriptFile,
    clips: List[Dict[str, Any]],
    messages: List[Dict[str, str]],
) -> None:
    for clip in clips:
        target_timerange = build_timerange(
            clip["targetStartMs"],
            clip["targetEndMs"],
        )
        source_timerange = build_optional_timerange(
            clip.get("sourceInMs"),
            clip.get("sourceOutMs"),
        )

        volume = float(clip.get("volume", 1.0))

        if clip["kind"] == "audio":
            segment = AudioSegment(
                str(clip["materialPath"]),
                target_timerange,
                source_timerange=source_timerange,
                volume=volume,
            )
        else:
            segment = VideoSegment(
                str(clip["materialPath"]),
                target_timerange,
                source_timerange=source_timerange,
                volume=volume,
                clip_settings=build_clip_settings(clip.get("clipSettings")),
            )
            transition = clip.get("transitionOut")
            if transition:
                transition_name = str(transition["name"])
                try:
                    transition_type = TransitionType.from_name(transition_name)
                    duration_ms = transition.get("durationMs")
                    if duration_ms is None:
                        segment.add_transition(transition_type)
                    else:
                        segment.add_transition(
                            transition_type,
                            duration=ms_to_us(int(duration_ms)),
                        )
                except ValueError:
                    messages.append({
                        "code": "unsupported_transition",
                        "level": "warning",
                        "message": (
                            f"Transition '{transition_name}' is not available in "
                            "pyJianYingDraft metadata and was skipped."
                        ),
                    })

        script.add_segment(segment, str(clip["trackName"]))


def create_text_segments(script: ScriptFile, subtitles: List[Dict[str, Any]]) -> None:
    for subtitle in subtitles:
        segment = TextSegment(
            str(subtitle["text"]),
            build_timerange(subtitle["startMs"], subtitle["endMs"]),
            style=build_text_style(subtitle.get("style")),
            clip_settings=build_clip_settings(subtitle.get("clipSettings")),
        )
        script.add_segment(segment, str(subtitle["trackName"]))


def patch_draft_meta(output_path: Path, draft_name: str, script: ScriptFile) -> int:
    meta_path = output_path / "draft_meta_info.json"
    if not meta_path.exists():
        return 0

    meta = load_json(meta_path)
    now_s = int(time.time())
    now_us = int(time.time() * 1_000_000)
    draft_materials = build_draft_material_groups(script, now_s, now_us)
    meta["draft_id"] = str(uuid.uuid4()).upper()
    meta["draft_name"] = draft_name
    meta["draft_fold_path"] = str(output_path)
    meta["draft_root_path"] = str(output_path.parent)
    meta["tm_duration"] = int(script.duration)
    meta["draft_materials"] = draft_materials
    meta["draft_materials_copied_info"] = []
    meta["draft_segment_extra_info"] = []
    meta["draft_need_rename_folder"] = False
    meta["tm_draft_create"] = int(meta.get("tm_draft_create") or now_us)
    meta["tm_draft_modified"] = now_us
    meta["draft_timeline_materials_size_"] = len(
        json.dumps(script.content.get("materials", {}), ensure_ascii=False),
    )
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=4),
        encoding="utf-8",
    )
    return len(draft_materials[0]["value"])


def patch_local_material_registry(output_path: Path, script: ScriptFile) -> tuple[int, int]:
    media_materials = collect_media_materials(script)
    material_ranks = {
        str(material.material_id): index
        for index, material in enumerate(media_materials)
    }
    key_value: Dict[str, Dict[str, Any]] = {}

    for material in media_materials:
        material_id = str(material.material_id)
        material_name = str(material.material_name)
        rank = material_ranks[material_id]
        key_value[material_id] = build_material_registry_entry(
            material_id=material_id,
            material_name=material_name,
            rank=rank,
        )

    media_segments = collect_media_segments(script)
    for segment in media_segments:
        material_id = str(segment.material_instance.material_id)
        material_name = str(segment.material_instance.material_name)
        rank = material_ranks.get(material_id, 0)
        segment_id = str(segment.segment_id)
        key_value[segment_id] = build_segment_registry_entry(
            segment_id=segment_id,
            material_id=material_id,
            material_name=material_name,
            rank=rank,
        )

    write_compact_json(output_path / "key_value.json", key_value)
    write_compact_json(
        output_path / "draft_virtual_store.json",
        {
            "draft_materials": [],
            "draft_virtual_store": [
                {
                    "type": 0,
                    "value": [{
                        "creation_time": 0,
                        "display_name": "",
                        "filter_type": 0,
                        "id": "",
                        "import_time": 0,
                        "import_time_us": 0,
                        "sort_sub_type": 0,
                        "sort_type": 0,
                        "subdraft_filter_type": 0,
                    }],
                },
                {
                    "type": 1,
                    "value": [
                        {
                            "child_id": build_virtual_store_child_id(str(material.material_id)),
                            "parent_id": "",
                        }
                        for material in media_materials
                    ],
                },
                {
                    "type": 2,
                    "value": [],
                },
            ],
        },
    )

    return len(media_materials), len(media_segments)


def collect_media_materials(script: ScriptFile) -> List[VideoMaterial | AudioMaterial]:
    return [
        *script.materials.videos,
        *script.materials.audios,
    ]


def collect_media_segments(script: ScriptFile) -> List[VideoSegment | AudioSegment]:
    segments: List[VideoSegment | AudioSegment] = []
    for track in script.tracks.values():
        for segment in track.segments:
            if isinstance(segment, (VideoSegment, AudioSegment)):
                segments.append(segment)
    return segments


def build_material_registry_entry(
    *,
    material_id: str,
    material_name: str,
    rank: int,
) -> Dict[str, Any]:
    return {
        "commerce_template_cate": "",
        "commerce_template_pay_status": "",
        "commerce_template_pay_type": "",
        "douyin_music_is_avaliable": False,
        "enter_from": "",
        "filter_category": "",
        "filter_detail": "",
        "is_brand": 0,
        "is_favorite": False,
        "is_from_artist_shop": 0,
        "is_limited": False,
        "is_similar_music": False,
        "is_vip": "0",
        "keywordSource": "",
        "materialCategory": "media",
        "materialId": material_id,
        "materialName": material_name,
        "materialSubcategory": "local",
        "materialSubcategoryId": "",
        "materialThirdcategory": "导入",
        "materialThirdcategoryId": "",
        "material_copyright": "",
        "material_is_purchased": "",
        "music_source": "",
        "original_song_id": "",
        "original_song_name": "",
        "pgc_id": "",
        "pgc_name": "",
        "previewed": 0,
        "previewed_before_added": 0,
        "rank": str(rank),
        "rec_id": "",
        "requestId": "",
        "role": "",
        "searchId": "",
        "searchKeyword": "",
        "special_effect_loading_type": "",
        "team_id": "",
        "template_author_id": "",
        "template_drafts_price": 0,
        "template_duration": 0,
        "template_fragment_cnt": 0,
        "template_need_purcahse": True,
        "template_pay_type": "",
        "template_type": "",
        "template_use_cnt": 0,
        "textTemplateVersion": "",
    }


def build_segment_registry_entry(
    *,
    segment_id: str,
    material_id: str,
    material_name: str,
    rank: int,
) -> Dict[str, Any]:
    return {
        "filter_category": "",
        "filter_detail": "",
        "is_brand": 0,
        "is_from_artist_shop": 0,
        "is_vip": "0",
        "keywordSource": "",
        "materialCategory": "media",
        "materialId": material_id,
        "materialName": material_name,
        "materialSubcategory": "local",
        "materialSubcategoryId": "",
        "materialThirdcategory": "导入",
        "materialThirdcategoryId": "",
        "material_copyright": "",
        "material_is_purchased": "",
        "rank": str(rank),
        "rec_id": "",
        "requestId": "",
        "role": "",
        "searchId": "",
        "searchKeyword": "",
        "segmentId": segment_id,
        "team_id": "",
        "textTemplateVersion": "",
    }


def build_virtual_store_child_id(material_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"kairos:jianying:virtual-store:{material_id}"))


def build_draft_material_groups(
    script: ScriptFile,
    now_s: int,
    now_us: int,
) -> List[Dict[str, Any]]:
    media_entries = [
        build_draft_material_entry(material, now_s, now_us)
        for material in collect_media_materials(script)
    ]
    return [
        {"type": 0, "value": media_entries},
        {"type": 1, "value": []},
        {"type": 2, "value": []},
        {"type": 3, "value": []},
        {"type": 6, "value": []},
        {"type": 7, "value": []},
        {"type": 8, "value": []},
    ]


def build_draft_material_entry(
    material: VideoMaterial | AudioMaterial,
    now_s: int,
    now_us: int,
) -> Dict[str, Any]:
    material_path = str(Path(material.path).resolve())
    material_uuid = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"kairos:jianying:draft-material:{os.path.normcase(material_path)}",
        ),
    ).upper()
    metetype = "music"
    duration = int(material.duration)
    width = 0
    height = 0

    if isinstance(material, VideoMaterial):
        metetype = "photo" if material.material_type == "photo" else "video"
        duration = 5_000_000 if material.material_type == "photo" else int(material.duration)
        width = int(material.width)
        height = int(material.height)

    return {
        "create_time": now_s,
        "duration": duration,
        "extra_info": Path(material_path).name,
        "file_Path": material_path,
        "height": height,
        "id": material_uuid,
        "import_time": now_s,
        "import_time_ms": now_us,
        "item_source": 1,
        "md5": "",
        "metetype": metetype,
        "roughcut_time_range": {
            "duration": -1,
            "start": -1,
        },
        "sub_time_range": {
            "duration": -1,
            "start": -1,
        },
        "type": 0,
        "width": width,
    }


def write_compact_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def build_clip_settings(raw: Optional[Dict[str, Any]]) -> Optional[ClipSettings]:
    if not raw:
        return None
    return ClipSettings(
        scale_x=float(raw.get("scale_x", 1.0)),
        scale_y=float(raw.get("scale_y", 1.0)),
        transform_x=float(raw.get("transform_x", 0.0)),
        transform_y=float(raw.get("transform_y", 0.0)),
        rotation=float(raw.get("rotation", 0.0)),
    )


def build_text_style(raw: Optional[Dict[str, Any]]) -> TextStyle:
    raw = raw or {}
    return TextStyle(
        size=float(raw.get("size", 6.0)),
        align=1,
        auto_wrapping=True,
    )


def build_timerange(start_ms: Any, end_ms: Any) -> Timerange:
    start = int(start_ms)
    end = int(end_ms)
    if end < start:
        raise ValueError(f"Invalid time range: end ({end}) < start ({start})")
    return Timerange(ms_to_us(start), ms_to_us(end - start))


def build_optional_timerange(start_ms: Any, end_ms: Any) -> Optional[Timerange]:
    if start_ms is None or end_ms is None:
        return None
    return build_timerange(start_ms, end_ms)


def ms_to_us(value_ms: int) -> int:
    return int(round(value_ms * 1000))


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
