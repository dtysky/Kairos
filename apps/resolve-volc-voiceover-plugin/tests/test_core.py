import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_volc_voiceover_core import (
    TtsSettings,
    build_project_plugin_tmp_dir,
    build_project_voiceover_run_dir,
    clean_subtitle_text,
    extract_subtitle_text,
    frame_to_timecode,
    find_kairos_project_for_resolve,
    merge_selected_subtitles_for_synthesis,
    parse_tts_response,
    request_hash,
    resolve_project_voiceover_media,
    synthesize_unit,
    timecode_to_frame,
    unit_id_for_subtitle,
    write_manifest,
)


class CoreTests(unittest.TestCase):
    def test_timecode_frame_roundtrip(self):
        self.assertEqual(timecode_to_frame("00:01:02:12", 24), 1500)
        self.assertEqual(frame_to_timecode(1500, 24), "00:01:02:12")

    def test_extract_subtitle_text_prefers_name_then_properties(self):
        self.assertEqual(
            extract_subtitle_text({"name": "", "property": {"Text": "<b>Hello</b>\\Nworld"}}),
            "Hello world",
        )

    def test_unit_id_stable(self):
        subtitle = {"trackIndex": 1, "subtitleIndex": 2, "startFrame": 10, "endFrame": 20, "text": "hello"}
        self.assertEqual(unit_id_for_subtitle("tl", subtitle), unit_id_for_subtitle("tl", subtitle))

    def test_request_hash_changes_with_settings(self):
        left = request_hash("hello", TtsSettings(api_key="", speaker="a").public_dict())
        right = request_hash("hello", TtsSettings(api_key="", speaker="b").public_dict())
        self.assertNotEqual(left, right)

    def test_parse_json_base64_audio(self):
        audio = b"ID3test"
        body = json.dumps({"code": 0, "data": base64.b64encode(audio).decode("ascii")}).encode("utf-8")
        parsed = parse_tts_response(body)
        self.assertEqual(parsed["audio"], audio)

    def test_parse_volc_end_event_as_success(self):
        audio = b"ID3test"
        body = "\n".join([
            json.dumps({"code": 0, "message": "", "data": base64.b64encode(audio).decode("ascii")}),
            json.dumps({"code": 20000000, "message": "ok", "data": None, "usage": {"text_words": 8}}),
        ]).encode("utf-8")
        parsed = parse_tts_response(body)
        self.assertEqual(parsed["audio"], audio)
        self.assertEqual(parsed["usage"]["text_words"], 8)

    def test_parse_concatenated_json_chunks(self):
        audio = b"ID3test"
        body = (
            json.dumps({"code": 0, "data": base64.b64encode(audio).decode("ascii")})
            + json.dumps({"code": 20000000, "message": "ok", "data": None})
        ).encode("utf-8")
        parsed = parse_tts_response(body)
        self.assertEqual(parsed["audio"], audio)

    def test_manifest_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_manifest(Path(tmp), {"schemaVersion": "x"})
            self.assertTrue(path.exists())

    def test_resolve_project_name_matches_edit_suffix(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            brief_path = workspace / "projects" / "proj-a" / "config" / "project-brief.json"
            brief_path.parent.mkdir(parents=True)
            brief_path.write_text(json.dumps({
                "name": "格聂南线",
                "mappings": [],
                "voiceoverMedia": {"path": str(workspace / "voiceover")},
            }), encoding="utf-8")
            match = find_kairos_project_for_resolve(workspace, "格聂南线 [Edit]")
            self.assertEqual(match["projectId"], "proj-a")

    def test_resolve_project_name_matches_voiceover_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            brief_path = workspace / "projects" / "proj-a" / "config" / "project-brief.json"
            brief_path.parent.mkdir(parents=True)
            brief_path.write_text(json.dumps({
                "name": "Project A",
                "mappings": [],
                "voiceoverMedia": {
                    "path": str(workspace / "voiceover"),
                    "resolveProjectAliases": ["Kairos Volc Voiceover Debug"],
                },
            }), encoding="utf-8")
            match = find_kairos_project_for_resolve(workspace, "Kairos Volc Voiceover Debug")
            self.assertEqual(match["projectId"], "proj-a")

    def test_voiceover_media_prefers_current_device_writable_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            project_root = workspace / "projects" / "proj-a"
            brief_path = project_root / "config" / "project-brief.json"
            primary_parent = workspace / "primary-parent"
            primary_parent.mkdir()
            alternate = workspace / "alternate-root"
            brief_path.parent.mkdir(parents=True)
            brief_path.write_text(json.dumps({
                "name": "Project A",
                "mappings": [],
                "voiceoverMedia": {
                    "rootId": "vo",
                    "path": str(primary_parent / "voiceover"),
                    "alternatePaths": [{"path": str(alternate)}],
                },
            }), encoding="utf-8")
            run_dir, metadata = build_project_voiceover_run_dir(
                workspace,
                "Project A [Edit]",
                "timeline-1",
                "20260624-150737",
                timeline_name="Main Timeline",
            )
            self.assertEqual(metadata["rootId"], "vo")
            self.assertEqual(metadata["selectedSource"], "primary")
            self.assertTrue(str(run_dir).startswith(str(primary_parent / "voiceover")))
            self.assertEqual(metadata["outputLayoutVersion"], "project-timeline-mp3-v1")
            self.assertEqual(metadata["relativeRunDir"], "Project A _Edit_/Main Timeline")

    def test_project_plugin_tmp_dir_is_project_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            brief_path = workspace / "projects" / "proj-a" / "config" / "project-brief.json"
            brief_path.parent.mkdir(parents=True)
            brief_path.write_text(json.dumps({
                "name": "Project A",
                "mappings": [],
            }), encoding="utf-8")
            tmp_dir, metadata = build_project_plugin_tmp_dir(workspace, "Project A [Edit]")
            self.assertEqual(
                tmp_dir,
                workspace / "projects" / "proj-a" / ".tmp" / "resolve-volc-voiceover-plugin",
            )
            self.assertEqual(metadata["projectId"], "proj-a")

    def test_voiceover_media_skips_non_native_drive_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            alternate = Path(tmp) / "voiceover"
            media = resolve_project_voiceover_media({
                "projectId": "proj-a",
                "projectBriefPath": "/tmp/project-brief.json",
                "brief": {
                    "voiceoverMedia": {
                        "path": "F:\\kairos\\voiceover",
                        "alternatePaths": [{"path": str(alternate)}],
                    },
                },
            })
            if os.name != "nt":
                self.assertEqual(media["selected"]["configuredPath"], str(alternate))
                self.assertEqual(media["candidates"][0]["reason"], "non_native_drive_path")

    def test_synthesize_unit_records_root_relative_audio_paths(self):
        class FakeClient:
            def synthesize(self, text, settings):
                return {"requestId": "req-1", "headers": {}, "usage": {}, "audio": b"ID3test"}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subtitle = {
                "trackIndex": 1,
                "subtitleIndex": 1,
                "startFrame": 0,
                "endFrame": 24,
                "durationMs": 1000,
                "text": "hello",
            }
            unit = synthesize_unit(
                subtitle,
                "timeline",
                root / "run",
                TtsSettings(api_key="key", speaker="speaker"),
                client=FakeClient(),
                cache_root=root / ".cache",
                artifact_root=root,
            )
            expected = f"run/{unit['unitId']}_{unit['requestHash'][:8]}.mp3"
            self.assertEqual(unit["audioRelativePath"], expected)
            self.assertEqual(unit["rawAudioRelativePath"], expected)
            self.assertEqual(unit["resolveAudioRelativePath"], expected)

    def test_merge_selected_subtitles_for_synthesis(self):
        rows = [
            {
                "trackIndex": 1,
                "subtitleIndex": 2,
                "startFrame": 48,
                "endFrame": 72,
                "timelineInMs": 2000,
                "timelineOutMs": 3000,
                "durationMs": 1000,
                "text": "插件能用吗",
                "startTimecode": "01:00:02:00",
                "endTimecode": "01:00:03:00",
            },
            {
                "trackIndex": 1,
                "subtitleIndex": 1,
                "startFrame": 0,
                "endFrame": 40,
                "timelineInMs": 0,
                "timelineOutMs": 1667,
                "durationMs": 1667,
                "text": "测试一下哈哈哈哈",
                "startTimecode": "01:00:00:00",
                "endTimecode": "01:00:01:16",
            },
        ]
        merged = merge_selected_subtitles_for_synthesis(rows)
        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0]["isMergedGroup"])
        self.assertEqual(merged[0]["sourceSubtitleIds"], [1, 2])
        self.assertEqual(merged[0]["startFrame"], 0)
        self.assertEqual(merged[0]["endFrame"], 72)
        self.assertEqual(merged[0]["text"], "测试一下哈哈哈哈。\n插件能用吗")


if __name__ == "__main__":
    unittest.main()
