import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import offline_export


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class OfflineExportTest(unittest.TestCase):
    def test_frames_and_audio_with_banner(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, freq, duration in [('source', 440, 1), ('ad', 880, .4)]:
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=30', '-f', 'lavfi', '-i', f'sine=frequency={freq}:sample_rate=48000', '-t', str(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(root / f'{name}.mp4')], check=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(root / 'source.mp4'), '-frames:v', '1', str(root / 'frame.jpg')], check=True)
            settings = dict(source='source.mp4', ad='ad.mp4', duration=1, adDuration=.4, schedule=[.5], sourceGain=1, adGain=1)
            job, count = offline_export.start(settings, root)
            self.assertEqual(count, 84)
            try:
                for _ in range(count):
                    offline_export.frame(job, (root / 'frame.jpg').read_bytes())
                output = root / offline_export.finish(job)
                info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,r_frame_rate,duration', '-of', 'json', str(output)]))
                video = next(s for s in info['streams'] if s['codec_type'] == 'video')
                audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
                self.assertEqual(video['r_frame_rate'], '60/1')
                self.assertEqual(int(video['nb_read_frames']), count)
                self.assertAlmostEqual(float(audio['duration']), 1.4, delta=.04)
                samples = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
                import numpy as np
                sound = np.frombuffer(samples, dtype='<i2')
                def dominant(start):
                    chunk = sound[int(start*48000):int((start+.2)*48000)]
                    return np.fft.rfftfreq(len(chunk), 1/48000)[np.argmax(abs(np.fft.rfft(chunk)))]
                self.assertAlmostEqual(dominant(.1), 440, delta=10)
                self.assertAlmostEqual(dominant(.6), 880, delta=10)
                self.assertAlmostEqual(dominant(1.05), 440, delta=10)
            finally:
                offline_export.cancel(job)

    def test_decoded_frames_follow_timeline_and_reset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=60:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(root / 'source.mp4')], check=True)
            job, _ = offline_export.start(dict(source='source.mp4', duration=1), root)
            try:
                first = offline_export.input_frame(job, 'source', 0)
                later = offline_export.input_frame(job, 'source', 30)
                self.assertNotEqual(first, later)
                self.assertEqual(offline_export.input_frame(job, 'source', 30), later)
                self.assertEqual(offline_export.input_frame(job, 'source', 0), first)
                with self.assertRaises(ValueError):
                    offline_export.input_frame(job, 'background', 0)
            finally:
                offline_export.cancel(job)

    def test_audio_start_offset_is_preserved(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=64x64:r=60:d=1', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', str(root / 'source.mp4')], check=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(root / 'source.mp4'), '-frames:v', '1', str(root / 'frame.jpg')], check=True)
            job, count = offline_export.start(dict(source='source.mp4', duration=1), root)
            try:
                picture = (root / 'frame.jpg').read_bytes()
                for _ in range(count):
                    offline_export.frame(job, picture)
                output = root / offline_export.finish(job)
                samples = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
                audio = np.frombuffer(samples, dtype='<f4')
                self.assertLess(np.max(np.abs(audio[2400:12000])), .003)
                self.assertGreater(np.max(np.abs(audio[28800:38400])), .03)
            finally:
                offline_export.cancel(job)

    def test_incomplete_export_and_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'source.mp4').write_bytes(b'placeholder')
            job, _ = offline_export.start(dict(source='source.mp4', duration=1), root)
            with self.assertRaises(ValueError):
                offline_export.finish(job)
            offline_export.cancel(job)
            self.assertNotIn(job, offline_export.jobs)

    def test_silent_source_gets_silence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=64x64:r=30', '-t', '0.2', '-c:v', 'libx264', str(root / 'source.mp4')], check=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(root / 'source.mp4'), '-frames:v', '1', str(root / 'frame.jpg')], check=True)
            job, count = offline_export.start(dict(source='source.mp4', duration=.2), root)
            try:
                for _ in range(count):
                    offline_export.frame(job, (root / 'frame.jpg').read_bytes())
                output = root / offline_export.finish(job)
                streams = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', str(output)]))['streams']
                self.assertEqual({stream['codec_type'] for stream in streams}, {'audio', 'video'})
            finally:
                offline_export.cancel(job)


if __name__ == '__main__':
    unittest.main()
