import base64
import os
import unittest
from unittest.mock import patch
from flask import Flask
from cloud_auth import configure_cloud_access


def auth(username, password):
    raw=f'{username}:{password}'.encode('utf-8')
    return {'Authorization':'Basic '+base64.b64encode(raw).decode('ascii')}


class CloudAccessTests(unittest.TestCase):
    def make_app(self, cloud, password='correct-horse-battery-staple'):
        with patch.dict(os.environ, {'SPLITCLIP_CLOUD':cloud, 'SPLITCLIP_PASSWORD':password}, clear=False):
            app=Flask(__name__)
            configure_cloud_access(app)
            app.add_url_rule('/', 'index', lambda:'private')
            app.add_url_rule('/healthz', 'health', lambda:'ok')
            app.add_url_rule('/media/example.mp4', 'media', lambda:'media')
            app.add_url_rule('/api/upload', 'upload', lambda:'ok', methods=['POST'])
            return app

    def test_local_mode_stays_accessible(self):
        self.assertEqual(self.make_app('0').test_client().get('/').status_code,200)

    def test_cloud_requires_strong_password(self):
        with self.assertRaises(RuntimeError): self.make_app('1','short')

    def test_all_private_routes_require_auth_except_health(self):
        c=self.make_app('1').test_client()
        self.assertEqual(c.get('/healthz').status_code,200)
        self.assertEqual(c.get('/').status_code,401)
        self.assertEqual(c.get('/media/example.mp4').status_code,401)
        self.assertEqual(c.get('/',headers=auth('autocut','wrong-password')).status_code,401)
        res=c.get('/',headers=auth('autocut','correct-horse-battery-staple'))
        self.assertEqual(res.status_code,200)
        self.assertEqual(res.headers['Cache-Control'],'no-store')

    def test_mutations_reject_cross_origin(self):
        c=self.make_app('1').test_client()
        credentials=auth('autocut','correct-horse-battery-staple')
        self.assertEqual(c.post('/api/upload',base_url='https://editor.example',headers={**credentials,'Origin':'https://other.example'}).status_code,403)
        self.assertEqual(c.post('/api/upload',base_url='https://editor.example',headers={**credentials,'Origin':'http://editor.example'}).status_code,403)
        self.assertEqual(c.post('/api/upload',base_url='https://editor.example',headers={**credentials,'Origin':'https://editor.example'}).status_code,200)

if __name__ == '__main__': unittest.main()
