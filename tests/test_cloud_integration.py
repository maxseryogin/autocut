import base64
import io
import os
import tempfile
import unittest
from unittest.mock import patch

class RealAppCloudTests(unittest.TestCase):
    def test_real_routes_are_protected(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {'SPLITCLIP_CLOUD':'1','SPLITCLIP_PASSWORD':'a-long-test-password','SPLITCLIP_MEDIA_DIR':folder}, clear=False):
                import app as app_module
                client=app_module.app.test_client()
                encoded=base64.b64encode(b'autocut:a-long-test-password').decode('ascii')
                credentials={'Authorization':'Basic '+encoded}
                self.assertEqual(client.get('/').status_code,401)
                self.assertEqual(client.post('/api/upload').status_code,401)
                self.assertEqual(client.get('/healthz').status_code,200)
                page=client.get('/',headers=credentials)
                self.assertEqual(page.status_code,200)
                page.close()
                response=client.post('/api/upload',data={'file':(io.BytesIO(b'video-test-data'),'clip.mp4')},headers=credentials)
                self.assertEqual(response.status_code,200)
                url=response.get_json()['url']
                self.assertEqual(client.get(url).status_code,401)
                media=client.get(url,headers=credentials)
                self.assertEqual(media.data,b'video-test-data')
                media.close()

if __name__ == '__main__': unittest.main()
