import json
import sqlite3
import threading
import time
from pathlib import Path

class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(self.root / 'history.sqlite3'), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.db:
            self.db.execute('''CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                duration REAL, file TEXT, status TEXT NOT NULL, features TEXT,
                created REAL NOT NULL, score REAL)''')
    def close(self):
        with self.lock: self.db.close()
    def known(self, video_id):
        with self.lock:
            row = self.db.execute('SELECT status FROM videos WHERE id=?', (video_id,)).fetchone()
            return row['status'] if row else None
    def add(self, video_id, url, title, duration, path, features, status='pending', score=None):
        with self.lock, self.db:
            self.db.execute('INSERT INTO videos(id,url,title,duration,file,status,features,created,score) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', (video_id,url,title,duration,str(path) if path else None,status,json.dumps(features),time.time(),score))
    def mark_skipped(self, video_id, url, title, duration, status='filtered'):
        self.add(video_id,url,title,duration,None,{},status)
    def pending(self):
        with self.lock:
            rows=self.db.execute("SELECT * FROM videos WHERE status='pending' ORDER BY CASE WHEN score IS NULL THEN 1 ELSE 0 END,score DESC,created").fetchall()
            return [dict(x) for x in rows]
    def decisions(self):
        with self.lock:
            return [(json.loads(r['features']),1 if r['status']=='approved' else 0) for r in self.db.execute("SELECT features,status FROM videos WHERE status IN ('approved','rejected') AND features IS NOT NULL")]
    def decide(self, video_id, status, new_path=None):
        assert status in ('approved','rejected')
        with self.lock, self.db:
            self.db.execute('UPDATE videos SET status=?,file=? WHERE id=? AND status=\'pending\'', (status, str(new_path) if new_path else None, video_id))
    def update_scores(self):
        from .analysis import preference_scores
        with self.lock, self.db:
            rows=self.db.execute("SELECT id,features FROM videos WHERE status='pending' AND features IS NOT NULL").fetchall()
            if not rows: return
            scores=preference_scores([json.loads(r['features']) for r in rows], self.decisions())
            self.db.executemany('UPDATE videos SET score=? WHERE id=?', [(score, row['id']) for row,score in zip(rows,scores)])
    def stats(self):
        with self.lock:
            return dict(self.db.execute('SELECT status,count(*) FROM videos GROUP BY status').fetchall())
