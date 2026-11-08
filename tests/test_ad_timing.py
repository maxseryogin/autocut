import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor4'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from ad_timing import suggest_from_audio

class AdTimingTests(unittest.TestCase):
    def test_picks_pause_before_louder_central_event(self):
        sound = np.full(8000 * 20, 1000, dtype=np.int16)
        sound[8000 * 9:8000 * 10] = 0
        sound[8000 * 11:8000 * 13] = 12000
        t, detected = suggest_from_audio(sound)
        self.assertTrue(detected)
        self.assertGreaterEqual(t, 8)
        self.assertLess(t, 11)

    def test_silence_uses_middle(self):
        t, detected = suggest_from_audio(np.zeros(8000 * 12, dtype=np.int16))
        self.assertFalse(detected)
        self.assertEqual(t, 6)

if __name__ == '__main__': unittest.main()
