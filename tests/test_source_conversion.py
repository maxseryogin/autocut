import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import app as splitclip


class PrepareSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_patch = mock.patch.object(splitclip, 'DATA', Path(self.temp.name))
        self.data_patch.start()
        self.addCleanup(self.data_patch.stop)
        (splitclip.DATA / 'source.mp4').write_bytes(b'source')
        self.client = splitclip.app.test_client()

    def test_conversion_creates_browser_compatible_file(self):
        def convert(command, **kwargs):
            Path(command[-1]).write_bytes(b'converted')
            self.assertIn('libx264', command)
            self.assertIn('yuv420p', command)
            self.assertIn('0:a:0?', command)
            self.assertIn('aac', command)
            return SimpleNamespace(returncode=0, stderr=b'')
        with mock.patch.object(splitclip.subprocess, 'run', side_effect=convert):
            response = self.client.post('/api/prepare-source', json={'name': 'source.mp4'})
        self.assertEqual(response.status_code, 200)
        output = splitclip.DATA / response.json['url'].rsplit('/', 1)[-1]
        self.assertEqual(output.read_bytes(), b'converted')
        self.assertEqual((splitclip.DATA / 'source.mp4').read_bytes(), b'source')

    def test_missing_source_or_traversal_is_rejected(self):
        for name in ('missing.mp4', '../source.mp4'):
            self.assertEqual(self.client.post('/api/prepare-source', json={'name': name}).status_code, 400)

    def test_failed_conversion_removes_partial_file(self):
        def fail(command, **kwargs):
            Path(command[-1]).write_bytes(b'partial')
            return SimpleNamespace(returncode=1, stderr=b'invalid media')
        with mock.patch.object(splitclip.subprocess, 'run', side_effect=fail):
            response = self.client.post('/api/prepare-source', json={'name': 'source.mp4'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual([p.name for p in splitclip.DATA.iterdir()], ['source.mp4'])

    def test_missing_ffmpeg_is_reported(self):
        with mock.patch.object(splitclip.subprocess, 'run', side_effect=FileNotFoundError):
            response = self.client.post('/api/prepare-source', json={'name': 'source.mp4'})
        self.assertEqual(response.status_code, 503)
        self.assertIn('FFmpeg', response.json['error'])


if __name__ == '__main__':
    unittest.main()
