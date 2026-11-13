"""Local Twitch search and review library for Splitclip."""
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from twitch_finder.store import Store
from twitch_finder.worker import Worker

def _move_after_playback(source, target):
    # The browser's video stream may release its Windows file handle just
    # after the user clicks a button. Retry briefly rather than losing a vote.
    for attempt in range(6):
        try:
            shutil.move(str(source),str(target))
            return
        except PermissionError:
            if attempt == 5: raise
            time.sleep(.15)

class TwitchLibrary:
    def __init__(self, root):
        self.root=Path(root).resolve(); self.root.mkdir(parents=True,exist_ok=True)
        self.videos=self.root/'videos'; self.videos.mkdir(exist_ok=True)
        (self.videos/'Отобранные').mkdir(exist_ok=True)
        self.store=Store(self.root)
        self.lock=threading.RLock()
        self.message='Готово к поиску клипов на Twitch.';self.warning=''
        self.worker=Worker(self.root,self.store,self._notify)
    def _notify(self,kind,message):
        with self.lock:
            if kind in ('status','error','finished'): self.message=message
            if kind in ('warning','error'): self.warning=message
    def start(self):
        with self.lock:
            if self.worker.active: return False
            self.warning='';self.message='Запускаю поиск…'
            return self.worker.start(self.videos)
    def stop(self):
        with self.lock:
            if self.worker.active:
                self.message='Останавливаю поиск…';self.worker.stop_search()
    def status(self):
        with self.lock, self.store.lock:
            rows=self.store.db.execute("SELECT id,title,duration,url,status,score FROM videos WHERE status IN ('pending','approved') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, CASE WHEN score IS NULL THEN 1 ELSE 0 END,score DESC,created DESC").fetchall()
            return {'active':self.worker.active,'message':self.message,'warning':self.warning,
                    'clips':[dict(r) for r in rows], 'counts':self.store.stats()}
    def _row(self,clip_id):
        if not str(clip_id).isdigit(): raise ValueError('Некорректный номер клипа.')
        row=self.store.db.execute("SELECT * FROM videos WHERE id=? AND status IN ('pending','approved')",(str(clip_id),)).fetchone()
        if not row or not row['file']: raise FileNotFoundError('Клип не найден.')
        path=Path(row['file']).resolve()
        if not path.is_relative_to(self.videos.resolve()) or not path.is_file(): raise FileNotFoundError('Файл клипа не найден в папке Splitclip.')
        return row,path
    def video(self,clip_id):
        with self.lock,self.store.lock:
            return self._row(clip_id)[1]
    def select(self,clip_id,media_dir):
        with self.lock,self.store.lock:
            row,path=self._row(clip_id)
            output=Path(media_dir)/(uuid.uuid4().hex+'.mp4')
            try:
                shutil.copy2(path,output)
                if row['status']=='pending':
                    target=self.videos/'Отобранные'/path.name;link=path.with_suffix('.url');destlink=target.with_suffix('.url')
                    if target.exists() or destlink.exists(): raise FileExistsError('Файл уже есть в отобранных.')
                    _move_after_playback(path,target)
                    try:
                        if link.exists():shutil.move(str(link),str(destlink))
                        self.store.decide(clip_id,'approved',target)
                    except Exception:
                        if destlink.exists():shutil.move(str(destlink),str(link))
                        shutil.move(str(target),str(path));raise
                    try:self.store.update_scores()
                    except Exception:pass
                return {'url':'/media/'+output.name,'name':row['title'] or ('Twitch '+str(clip_id)),'original_url':row['url']}
            except Exception:
                output.unlink(missing_ok=True);raise
    def reject(self,clip_id):
        with self.lock,self.store.lock:
            row,path=self._row(clip_id)
            if row['status']!='pending': raise ValueError('Удалять можно только новые клипы.')
            temp=path.with_name(path.name+'.удаление');link=path.with_suffix('.url')
            if temp.exists(): raise FileExistsError('Временный файл уже существует.')
            _move_after_playback(path,temp)
            try:self.store.decide(clip_id,'rejected')
            except Exception:temp.rename(path);raise
            temp.unlink();link.unlink(missing_ok=True)
            try:self.store.update_scores()
            except Exception:pass
