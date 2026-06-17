import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kairos_volc_voiceover_core import (
    TtsSettings,
    clean_subtitle_text,
    extract_subtitle_text,
    frame_to_timecode,
    parse_tts_response,
    request_hash,
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

    def test_manifest_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_manifest(Path(tmp), {"schemaVersion": "x"})
            self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
