import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path
from .analysis import video_features, preference_score

NO_WINDOW=getattr(subprocess,'CREATE_NO_WINDOW',0)
SOURCE='https://www.twitch.tv/stariy_bog/clips?range=7d'
class StopRequested(Exception): pass

class Worker:
    def __init__(self,root,store,notify):
        self.root=Path(root); self.store=store; self.notify=notify
        self.stop=threading.Event(); self.active=False; self.thread=None
        # Bound parallelism to avoid filling the disk or exhausting the CPU.
        self.max_workers=6; self.render_slots=threading.BoundedSemaphore(2)
        self.local=threading.local(); self.warning_lock=threading.Lock(); self.caption_warning=False
        self.temp_root=self.root/'temp'
        self.temp_root.mkdir(parents=True,exist_ok=True)
        exe=Path(sys.executable)
        self.python=str(exe.with_name('python.exe')) if exe.name.lower()=='pythonw.exe' else str(exe)
    def start(self,folder):
        if self.active: return False
        self.stop.clear(); self.active=True
        self.thread=threading.Thread(target=self._work,args=(Path(folder),),daemon=True); self.thread.start(); return True
    def stop_search(self): self.stop.set()
    def close(self): self.stop.set()
    def run_process(self,args,timeout=300):
        with tempfile.TemporaryFile(dir=self.temp_root) as out,tempfile.TemporaryFile(dir=self.temp_root) as err:
            proc=subprocess.Popen(args,stdout=out,stderr=err,creationflags=NO_WINDOW)
            started=time.monotonic()
            while proc.poll() is None:
                if self.stop.wait(.15) or time.monotonic()-started>timeout:
                    proc.terminate()
                    try: proc.wait(timeout=3)
                    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
                    if self.stop.is_set(): raise StopRequested()
                    raise TimeoutError('Время ожидания истекло')
            out.seek(0);err.seek(0)
            return proc.returncode,out.read(),err.read().decode('utf-8',errors='replace')[-600:]
    def ytdlp(self,options):
        rc,out,err=self.run_process([self.python,'-m','yt_dlp','--no-warnings','--no-playlist',*options])
        if rc: raise RuntimeError('Twitch: '+err[-300:])
        return out
    def _work(self,folder):
        try:
            folder.mkdir(parents=True,exist_ok=True); (folder/'Отобранные').mkdir(exist_ok=True)
            seen=set(); saved=0
            while not self.stop.is_set():
                self.notify('status','Получаю список клипов за 7 дней с Twitch…')
                # Playlist extraction is needed here; individual clip commands use --no-playlist.
                rc,out,err=self.run_process([self.python,'-m','yt_dlp','--flat-playlist','--dump-single-json','--no-warnings',SOURCE])
                if rc: raise RuntimeError('Не удалось получить список Twitch: '+err[-300:])
                clips=json.loads(out.decode('utf-8',errors='replace')).get('entries') or []
                eligible=[]
                for entry in clips:
                    vid=str(entry.get('id') or ''); url=entry.get('url') or ''; duration=entry.get('duration') or 0
                    if not vid or not url or vid in seen or self.store.known(vid) in ('pending','approved','rejected'): continue
                    seen.add(vid)
                    if duration and duration<20: continue
                    eligible.append(entry)
                checked=0; total=len(eligible)
                self.notify('status',f'Найдено публикаций: {len(clips)}. Параллельно проверяю клипы от 20 секунд…')
                # Only six clips are in flight at a time, including those waiting
                # for one of the two conversion slots.
                with ThreadPoolExecutor(max_workers=self.max_workers, thread_name_prefix='twitch-clip') as pool:
                    remaining=iter(eligible); pending={}
                    def fill():
                        while len(pending)<self.max_workers and not self.stop.is_set():
                            try: entry=next(remaining)
                            except StopIteration: break
                            pending[pool.submit(self.handle,entry,folder)]=str(entry['id'])
                    fill()
                    while pending:
                        done,_=wait(pending,timeout=.2,return_when=FIRST_COMPLETED)
                        for future in done:
                            vid=pending.pop(future); checked+=1
                            try:
                                if future.result(): saved+=1; self.notify('updated',str(saved))
                            except StopRequested: pass
                            except Exception as e:
                                self.notify('warning',f'Клип {vid} не обработан: {str(e)[:140]}')
                            if not self.stop.is_set():
                                self.notify('status',f'Проверено: {checked} из {total}. Готово: {saved}. Одновременно в работе: {len(pending)}.')
                        fill()
                if self.stop.is_set(): break
                self.notify('status',f'Проверка завершена. Готово: {saved}. Новые клипы проверятся через 2 минуты; можно остановить поиск.')
                self.stop.wait(120)
        except StopRequested: pass
        except Exception as e: self.notify('error',str(e)[:500])
        finally:
            self.active=False; self.notify('finished','Поиск остановлен. Можно просматривать клипы.')
    def has_face(self,path):
        import cv2
        import numpy as np
        cap=cv2.VideoCapture(str(path)); fps=cap.get(cv2.CAP_PROP_FPS) or 25
        duration=cap.get(cv2.CAP_PROP_FRAME_COUNT)/fps
        detector=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')
        if detector.empty(): cap.release(); raise RuntimeError('Не удалось загрузить распознавание лица')
        found=0; frames=0
        for t in np.linspace(max(.2,duration*.12),max(.4,duration*.88),5):
            if self.stop.is_set(): cap.release(); raise StopRequested()
            cap.set(cv2.CAP_PROP_POS_MSEC,float(t)*1000); ok,img=cap.read()
            if not ok: continue
            h,w=img.shape[:2]; crop=img[:int(h*.295),int(w*.77):]
            gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
            faces=detector.detectMultiScale(gray,scaleFactor=1.1,minNeighbors=4,minSize=(max(20,int(w*.012)),max(20,int(h*.02))))
            found+=bool(len(faces)); frames+=1
            if found:
                cap.release()
                return True
        cap.release()
        if frames<2: raise RuntimeError('Не удалось проверить видео')
        return found>=1
    def handle(self,entry,folder):
        vid=str(entry['id']); url=entry['url']
        meta=json.loads(self.ytdlp(['--dump-single-json','--skip-download',url]).decode('utf-8',errors='replace'))
        duration=meta.get('duration') or entry.get('duration') or 0
        if duration<20: return False
        categories=meta.get('categories') or []
        if 'dota 2' not in [str(c).casefold() for c in categories]: return False
        with tempfile.TemporaryDirectory(prefix='twitchfinder_',dir=self.temp_root) as temp:
            td=Path(temp); out=str(td/(vid+'.%(ext)s'))
            self.ytdlp(['-f','best[ext=mp4]/best','-o',out,url])
            raw=next((p for p in td.iterdir() if p.suffix.lower() in ('.mp4','.mkv','.webm')),None)
            if raw is None: raise RuntimeError('Нет загруженного видео')
            if not self.has_face(raw): return False
            ffmpeg=shutil.which('ffmpeg')
            if not ffmpeg: raise RuntimeError('FFmpeg не найден. Установите FFmpeg и перезапустите приложение.')
            rendered=td/(vid+'_vertical.mp4')
            graph='[0:v]split=2[c][g];[c]crop=iw*0.23:ih*0.295:iw*0.77:0,scale=720:480:force_original_aspect_ratio=increase,crop=720:480[cam];[g]crop=ih*0.9:ih:(iw-ih*0.9)/2:0,scale=720:800[game];[cam][game]vstack=inputs=2[v]'
            while not self.render_slots.acquire(timeout=.2):
                if self.stop.is_set(): raise StopRequested()
            try:
                if self.stop.is_set(): raise StopRequested()
                rc,out,err=self.run_process([ffmpeg,'-y','-loglevel','error','-i',str(raw),'-filter_complex',graph,'-map','[v]','-map','0:a?','-c:v','libx264','-threads','2','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart',str(rendered)])
            finally:
                self.render_slots.release()
            if rc: raise RuntimeError('Ошибка обрезки: '+err[-180:])
            if self.stop.is_set(): raise StopRequested()
            if not hasattr(self.local,'caption_check'):
                try:
                    from .captions import CaptionCheck
                    self.local.caption_check=CaptionCheck()
                except Exception:
                    self.local.caption_check=False
                    with self.warning_lock:
                        if not self.caption_warning:
                            self.notify('warning','Распознавание текста недоступно: субтитры нужно проверять вручную.')
                            self.caption_warning=True
            if self.local.caption_check:
                try:
                    has_captions,_=self.local.caption_check.check(rendered)
                    if has_captions: return False
                except Exception:
                    self.notify('warning','Не удалось проверить субтитры в одном из клипов; проверь их вручную.')
            actual,features=video_features(rendered)
            score=preference_score(features,self.store.decisions())
            if self.stop.is_set(): raise StopRequested()
            target=folder/(vid+'.mp4'); link=folder/(vid+'.url')
            if target.exists() or link.exists(): raise FileExistsError('Файл с таким именем уже существует')
            shutil.move(str(rendered),str(target))
            try:
                link.write_text('[InternetShortcut]\nURL='+url+'\n',encoding='utf-8')
                self.store.add(vid,url,meta.get('title') or entry.get('title') or '',actual,target,features,score=score)
            except Exception:
                target.unlink(missing_ok=True); link.unlink(missing_ok=True); raise
            return True
