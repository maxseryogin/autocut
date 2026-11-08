import math, sys, tempfile, unittest, wave
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'vendor4'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import cv2
import numpy as np
from media_inspection import inspect_audio, inspect_banner, fit_banner

class InspectionTests(unittest.TestCase):
 def test_loudness_compensation_matches_sources(self):
  with tempfile.TemporaryDirectory() as folder:
   outputs=[]
   for name,amp in [('quiet',.08),('loud',.32)]:
    path=Path(folder)/(name+'.wav');rate=16000;t=np.arange(rate*5)/rate
    samples=(np.sin(2*np.pi*440*t)*amp*32767).astype('<i2')
    with wave.open(str(path),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate);f.writeframes(samples.tobytes())
    result=inspect_audio(path);self.assertEqual(result['state'],'ok');outputs.append(result['lufs']+result['gain_db'])
   self.assertLess(abs(outputs[0]-outputs[1]),.5)
 def test_banner_area_and_center(self):
  with tempfile.TemporaryDirectory() as folder:
   path=str(Path(folder)/'banner.avi');writer=cv2.VideoWriter(path,cv2.VideoWriter_fourcc(*'MJPG'),10,(360,640));self.assertTrue(writer.isOpened())
   for _ in range(50):
    frame=np.zeros((640,360,3),np.uint8);frame[:]=(0,255,0);cv2.rectangle(frame,(60,170),(300,470),(220,20,20),-1);writer.write(frame)
   writer.release();res=inspect_banner(path,50,100)
   self.assertEqual(res['state'],'ok');self.assertTrue(res['centered']);self.assertFalse(res['clipped']);self.assertGreater(res['min_visible_percent'],25)
 def test_fit_centers_and_increases_small_banner(self):
  with tempfile.TemporaryDirectory() as folder:
   path=str(Path(folder)/'small.avi');writer=cv2.VideoWriter(path,cv2.VideoWriter_fourcc(*'MJPG'),10,(360,640));self.assertTrue(writer.isOpened())
   for _ in range(50):
    frame=np.zeros((640,360,3),np.uint8);frame[:]=(0,255,0);cv2.rectangle(frame,(80,240),(280,390),(220,20,20),-1);writer.write(frame)
   writer.release();fit=fit_banner(path,50)
   self.assertEqual(fit['state'],'ok');self.assertGreaterEqual(fit['inspection']['min_visible_percent'],25);self.assertTrue(fit['inspection']['centered']);self.assertFalse(fit['inspection']['clipped'])
 def test_fully_green_banner_requires_manual_review(self):
  with tempfile.TemporaryDirectory() as folder:
   path=str(Path(folder)/'green.avi');writer=cv2.VideoWriter(path,cv2.VideoWriter_fourcc(*'MJPG'),10,(360,640));self.assertTrue(writer.isOpened())
   for _ in range(50):
    frame=np.zeros((640,360,3),np.uint8);frame[:]=(0,255,0);writer.write(frame)
   writer.release();self.assertEqual(fit_banner(path,50)['state'],'manual')
 def test_supplied_banner_when_available(self):
  import os
  path=os.environ.get('SPLITCLIP_TEST_BANNER')
  if not path:self.skipTest('No local banner configured')
  fit=fit_banner(path,50);self.assertEqual(fit['state'],'partial');self.assertFalse(fit['inspection']['clipped']);self.assertTrue(fit['inspection']['centered']);self.assertGreaterEqual(sum(s['visible_percent']>=25 for s in fit['inspection']['samples']),13);self.assertLess(fit['inspection']['min_visible_percent'],25);self.assertAlmostEqual(fit['inspection']['duration'],6.933,places=2)
 def test_silent_audio_is_not_passed(self):
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder)/'silent.wav'
   with wave.open(str(path),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(bytes(16000*5*2))
   self.assertIn(inspect_audio(path)['state'],('silent','missing'))
if __name__=='__main__':unittest.main()
