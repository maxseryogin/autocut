import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from twitch_library import TwitchLibrary

class TwitchLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.library=TwitchLibrary(self.root/'library')
        self.media=self.root/'media'; self.media.mkdir()
    def tearDown(self):
        self.library.worker.close()
        self.library.store.close()
        self.temp.cleanup()
    def add(self, clip_id, status='pending'):
        folder=self.library.videos/('Отобранные' if status=='approved' else '')
        folder.mkdir(exist_ok=True)
        video=folder/(clip_id+'.mp4');video.write_bytes(b'video '+clip_id.encode())
        video.with_suffix('.url').write_text('URL=https://twitch.tv/test',encoding='utf-8')
        self.library.store.add(clip_id,'https://www.twitch.tv/test/clip/'+clip_id,'test',30,video,[.1]*13,status=status)
        return video
    def test_select_moves_pending_and_preserves_link_for_editor(self):
        original=self.add('123')
        result=self.library.select('123',self.media)
        dest=self.library.videos/'Отобранные'/'123.mp4'
        self.assertTrue(dest.exists());self.assertTrue(dest.with_suffix('.url').exists());self.assertFalse(original.exists())
        self.assertEqual((self.media/Path(result['url']).name).read_bytes(),b'video 123')
        self.assertEqual(self.library.store.known('123'),'approved')
        result2=self.library.select('123',self.media)
        self.assertTrue((self.media/Path(result2['url']).name).is_file())
    def test_reject_removes_file_but_keeps_decision(self):
        path=self.add('456');self.library.reject('456')
        self.assertFalse(path.exists());self.assertFalse(path.with_suffix('.url').exists())
        self.assertEqual(self.library.store.known('456'),'rejected')
    def test_untrusted_paths_and_approved_deletion_are_rejected(self):
        self.add('789','approved')
        with self.assertRaises(ValueError):self.library.reject('789')
        with self.assertRaises(ValueError):self.library.video('../789')
        outside=self.root/'external.mp4';outside.write_bytes(b'private')
        with self.library.store.lock,self.library.store.db:
            self.library.store.db.execute('update videos set file=? where id=?',(str(outside),'789'))
        with self.assertRaises(FileNotFoundError):self.library.video('789')
    def test_move_failure_does_not_lose_original_or_leave_copy(self):
        original=self.add('123');destination=self.library.videos/'Отобранные'/'123.mp4';destination.write_bytes(b'other')
        with self.assertRaises(FileExistsError):self.library.select('123',self.media)
        self.assertTrue(original.exists());self.assertEqual(self.library.store.known('123'),'pending')
        self.assertEqual(list(self.media.iterdir()),[])
    def test_editor_api_lists_streams_and_selects_clip(self):
        import app as server
        self.add('123')
        with patch.object(server,'_twitch_instance',self.library), patch.object(server,'DATA',self.media):
            client=server.app.test_client()
            status=client.get('/api/twitch/status').get_json()
            self.assertEqual(status['clips'][0]['id'],'123')
            response=client.get('/api/twitch/clips/123/video',headers={'Range':'bytes=0-4'})
            self.assertEqual(response.status_code,206)
            self.assertEqual(response.data,b'video')
            response.close()
            self.assertEqual(client.post('/api/twitch/clips/123/reject',headers={'Origin':'https://other.example'}).status_code,403)
            self.assertEqual(self.library.store.known('123'),'pending')
            result=client.post('/api/twitch/clips/123/select')
            self.assertEqual(result.status_code,200)
            media=client.get(result.get_json()['url'])
            self.assertEqual(media.data,b'video 123');media.close()
            self.assertEqual(client.post('/api/twitch/clips/123/reject').status_code,400)

if __name__=='__main__':unittest.main()
