from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kairos_ml import qwen3_asr_runner as runner

class MlxAlignmentTests(unittest.TestCase):
    def align(self, items):
        utils = ModuleType('mlx_audio.stt.utils')
        utils.load_audio = lambda _: [0] * 160000
        aligner = SimpleNamespace(generate=lambda **_: SimpleNamespace(items=items))
        with mock.patch.dict(sys.modules, {'mlx_audio.stt.utils': utils}):
            return runner._align_segments(aligner, Path('test.wav'), [{'start': 2, 'end': 3, 'text': '测试'}], 'Chinese')

    def test_preserves_zero_duration_character_and_offsets(self):
        result = self.align([SimpleNamespace(text='测', start_time=0.1, end_time=0.1), SimpleNamespace(text='试', start_time=0.1, end_time=0.5)])
        self.assertEqual(result, [{'text': '测', 'start': 2.1, 'end': 2.1}, {'text': '试', 'start': 2.1, 'end': 2.5}])

    def test_rejects_no_usable_timing(self):
        with self.assertRaises(RuntimeError):
            self.align([SimpleNamespace(text='测试', start_time=0, end_time=0)])

if __name__ == '__main__': unittest.main()
