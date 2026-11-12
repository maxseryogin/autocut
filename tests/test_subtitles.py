import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import subtitles


class SubtitleTests(unittest.TestCase):
    def test_subword_timestamps_and_punctuation(self):
        result = SimpleNamespace(tokens=[' При', 'вет', ',', ' мир', '!'], timestamps=[.1, .2, .3, .5, .6])
        self.assertEqual(subtitles._words(result, 10, 2, 0, 20), [
            {'start': 10.1, 'end': 10.34, 'text': 'Привет,'},
            {'start': 10.5, 'end': 10.64, 'text': 'мир!'},
        ])

    def test_overlap_assigns_word_once(self):
        result = SimpleNamespace(tokens=[' один', ' два'], timestamps=[.2, 1.2])
        self.assertEqual([x['text'] for x in subtitles._words(result, 16, 2, 17, 30)], ['два'])
        self.assertEqual([x['text'] for x in subtitles._words(result, 16, 2, 0, 17)], ['один'])

    def test_invalid_timestamps_fail(self):
        with self.assertRaises(ValueError):
            subtitles._words(SimpleNamespace(tokens=[' привет'], timestamps=[]), 0, 1, 0, 1)

    def test_language_restriction_and_job_state(self):
        with mock.patch.object(subtitles, '_update') as update:
            subtitles._run('id', 'file', 'en')
        self.assertEqual(update.call_args.kwargs['state'], 'error')
        self.assertIn('русский', update.call_args.kwargs['detail'])

    def test_model_uses_f32_local_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in subtitles.MODEL_FILES:
                (Path(tmp) / name).write_bytes(b'x')
            fake = mock.Mock()
            with mock.patch.object(subtitles, '_model_dir', return_value=Path(tmp)), mock.patch('onnx_asr.load_model', return_value=fake) as load:
                subtitles._load_model('id')
            self.assertEqual(load.call_args.kwargs['path'], Path(tmp))
            self.assertIsNone(load.call_args.kwargs['quantization'])
            self.assertEqual(load.call_args.kwargs['providers'], ['CPUExecutionProvider'])
            fake.with_timestamps.assert_called_once()


if __name__ == '__main__':
    unittest.main()
