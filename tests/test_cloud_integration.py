import base64
import io
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

class RealAppCloudTests(unittest.TestCase):
    def test_real_routes_are_protected(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(os.environ, {'SPLITCLIP_CLOUD':'1','SPLITCLIP_PASSWORD':'a-long-test-password','SPLITCLIP_MEDIA_DIR':folder}, clear=False):
                # Other tests import app before setting cloud env vars. Load an
                # isolated module so this test exercises actual cloud startup.
                module_name = '_splitclip_cloud_test_app'
                spec = importlib.util.spec_from_file_location(module_name, Path(__file__).resolve().parents[1] / 'app.py')
                app_module = importlib.util.module_from_spec(spec)
                with patch.dict(sys.modules, {module_name: app_module}):
                    spec.loader.exec_module(app_module)
                client=app_module.app.test_client()
                encoded=base64.b64encode(b'autocut:a-long-test-password').decode('ascii')
                credentials={'Authorization':'Basic '+encoded}
                self.assertEqual(client.get('/').status_code,401)
                self.assertEqual(client.post('/api/upload').status_code,401)
                self.assertEqual(client.get('/api/twitch/status').status_code,401)
                self.assertEqual(client.post('/api/twitch/search').status_code,401)
                self.assertEqual(client.post('/api/twitch/clips/123/select').status_code,401)
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
