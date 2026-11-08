import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor4'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2
import numpy as np
from camera import _boundary, find_camera

class CameraTests(unittest.TestCase):
    def test_border_selection(self):
        profile=np.ones(150, dtype=np.float32)*3
        profile[80]=40
        self.assertEqual(_boundary(profile,40,120,14,'after'),81)
        self.assertIsNone(_boundary(profile,0,40,14,'after'))
    def test_no_face_does_not_guess(self):
        with tempfile.TemporaryDirectory() as folder:
            path=str(Path(folder)/'blank.avi')
            writer=cv2.VideoWriter(path,cv2.VideoWriter_fourcc(*'MJPG'),10,(320,240))
            self.assertTrue(writer.isOpened())
            for _ in range(12): writer.write(np.zeros((240,320,3),dtype=np.uint8))
            writer.release()
            self.assertIsNone(find_camera(path,0))
    def test_user_video_boundary_when_available(self):
        path=os.environ.get('SPLITCLIP_TEST_VIDEO')
        if not path: self.skipTest('No local reference clip configured')
        for t in (0,5,20,45):
            region=find_camera(path,t)
            self.assertEqual(region['confidence'],'border')
            self.assertEqual(region['x'],0)
            self.assertEqual(region['y'],0)
            self.assertEqual(region['width'],720)
            self.assertEqual(region['height'],493)

if __name__=='__main__': unittest.main(verbosity=2)
