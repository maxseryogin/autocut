import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor4'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2
import numpy as np
import camera
from camera import _boundary, _caption_band, find_camera

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
    def test_caption_band_crossing_camera_boundary(self):
        frames=[]
        for i in range(5):
            frame=np.full((640,360,3),90+i*2,dtype=np.uint8)
            frame[240:]=(45+i*3,80,100)
            cv2.putText(frame,'OLD TEXT',(55,256),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),5,cv2.LINE_AA)
            cv2.putText(frame,'OLD TEXT',(55,256),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255),2,cv2.LINE_AA)
            frames.append(frame)
        band=_caption_band(frames,240)
        self.assertIsNotNone(band)
        self.assertLess(band['top'],236)
        self.assertGreater(band['bottom'],256)
    def test_clean_seam_is_not_treated_as_captions(self):
        frame=np.full((640,360,3),120,dtype=np.uint8)
        frame[240:]=45
        cv2.putText(frame,'GAME',(50,400),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255),2)
        self.assertIsNone(_caption_band([frame]*5,240))
    def test_caption_seam_can_cut_through_detected_face(self):
        frame = np.full((640, 360, 3), 160, dtype=np.uint8)
        frame[254:] = (45, 60, 80)
        frame[520:] = (150, 150, 150)
        cv2.putText(frame, 'OLD TEXT', (40, 269), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 5, cv2.LINE_AA)
        cv2.putText(frame, 'OLD TEXT', (40, 269), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2, cv2.LINE_AA)
        capture = mock.Mock()
        capture.isOpened.return_value = True
        capture.get.side_effect = lambda key: 25 if key == cv2.CAP_PROP_FPS else 500
        capture.read.return_value = (True, frame)
        classifier = mock.Mock()
        classifier.empty.return_value = False
        classifier.detectMultiScale.return_value = np.array([[120, 160, 120, 120]])
        with mock.patch.object(camera.cv2, 'VideoCapture', return_value=capture), mock.patch.object(camera.cv2, 'CascadeClassifier', return_value=classifier):
            region = find_camera('clip.mp4', 0)
        self.assertEqual(region['height'], 254)
        self.assertLess(region['caption_band']['top'], 254)
        self.assertGreater(region['caption_band']['bottom'], 269)

    def test_early_edge_without_text_does_not_replace_camera_boundary(self):
        frame = np.full((640, 360, 3), 160, dtype=np.uint8)
        frame[254:] = (45, 60, 80)
        frame[520:] = (150, 150, 150)
        capture = mock.Mock()
        capture.isOpened.return_value = True
        capture.get.side_effect = lambda key: 25 if key == cv2.CAP_PROP_FPS else 500
        capture.read.return_value = (True, frame)
        classifier = mock.Mock()
        classifier.empty.return_value = False
        classifier.detectMultiScale.return_value = np.array([[120, 160, 120, 120]])
        with mock.patch.object(camera.cv2, 'VideoCapture', return_value=capture), mock.patch.object(camera.cv2, 'CascadeClassifier', return_value=classifier):
            region = find_camera('clip.mp4', 0)
        self.assertEqual(region['height'], 520)
        self.assertNotIn('caption_band', region)

    def test_caption_with_cropped_face_when_available(self):
        path = os.environ.get('SPLITCLIP_TEST_CAPTION_CROPPED_FACE')
        if not path:
            self.skipTest('No local cropped-face reference configured')
        for t in (0, 1, 4, 10):
            region = find_camera(path, t)
            self.assertEqual(region['height'], 507)
            self.assertLessEqual(region['caption_band']['top'], 500)
            self.assertGreaterEqual(region['caption_band']['bottom'], 560)

    def test_source_with_overlapping_subtitles_when_available(self):
        path=os.environ.get('SPLITCLIP_TEST_CAPTION_SOURCE')
        if not path: self.skipTest('No local caption reference configured')
        region=find_camera(path,0)
        self.assertEqual(region['confidence'],'border')
        self.assertTrue(450<=region['caption_band']['top']<=480)
        self.assertTrue(530<=region['caption_band']['bottom']<=555)
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
            self.assertNotIn('caption_band',region)

if __name__=='__main__': unittest.main(verbosity=2)
