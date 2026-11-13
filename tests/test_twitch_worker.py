import json,tempfile,time,threading,unittest
from pathlib import Path
from twitch_finder.worker import Worker,StopRequested
from twitch_finder.store import Store

class ParallelSearchTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.store=Store(self.root/'data')
 def tearDown(self):
  self.store.close();self.temp.cleanup()
 def test_bounded_parallelism_and_completion(self):
  clips=[{'id':str(i),'url':'https://example.test/'+str(i),'duration':30} for i in range(12)]
  lock=threading.Lock();running=0;peak=0;done=0;events=[]
  def notify(kind,message):
   nonlocal done
   events.append((kind,message))
   if kind=='updated':
    done+=1
    if done==len(clips):worker.stop_search()
  worker=Worker(self.root,self.store,notify)
  worker.run_process=lambda *a,**kw:(0,json.dumps({'entries':clips}).encode(),'')
  def handle(entry,folder):
   nonlocal running,peak
   with lock:running+=1;peak=max(peak,running)
   try:time.sleep(.15);return True
   finally:
    with lock:running-=1
  worker.handle=handle;start=time.monotonic();worker.start(self.root/'videos');worker.thread.join(5)
  self.assertFalse(worker.thread.is_alive());self.assertEqual(done,12);self.assertEqual(peak,6)
  self.assertLess(time.monotonic()-start,1.5)
 def test_stop_does_not_start_queued_clips(self):
  clips=[{'id':str(i),'url':'https://example.test/'+str(i),'duration':30} for i in range(40)]
  started=[];lock=threading.Lock();worker=Worker(self.root,self.store,lambda *a:None)
  worker.run_process=lambda *a,**kw:(0,json.dumps({'entries':clips}).encode(),'')
  def handle(entry,folder):
   with lock:started.append(entry['id'])
   if worker.stop.wait(4):raise StopRequested()
   return True
  worker.handle=handle;worker.start(self.root/'videos');end=time.monotonic()+3
  while len(started)<6 and time.monotonic()<end:time.sleep(.01)
  worker.stop_search();worker.thread.join(3)
  self.assertFalse(worker.thread.is_alive());self.assertEqual(len(started),6)

if __name__=='__main__':unittest.main()
