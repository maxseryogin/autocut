"""Optional shared-password access for the cloud deployment."""
import hmac
import os
from urllib.parse import urlsplit

from flask import Response, request
from werkzeug.middleware.proxy_fix import ProxyFix


def configure_cloud_access(app):
    if os.environ.get('SPLITCLIP_CLOUD') != '1':
        return
    username = os.environ.get('SPLITCLIP_USERNAME', 'autocut')
    password = os.environ.get('SPLITCLIP_PASSWORD', '')
    if len(password) < 16:
        raise RuntimeError('SPLITCLIP_PASSWORD must contain at least 16 characters in cloud mode')
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

    @app.before_request
    def protect_cloud():
        if request.path == '/healthz' and request.method == 'GET':
            return None
        credentials = request.authorization
        user = (credentials.username or '') if credentials else ''
        secret = (credentials.password or '') if credentials else ''
        if not (hmac.compare_digest(user.encode('utf-8'), username.encode('utf-8')) and
                hmac.compare_digest(secret.encode('utf-8'), password.encode('utf-8'))):
            return Response('Authentication required', 401, {
                'WWW-Authenticate': 'Basic realm="Splitclip", charset="UTF-8"',
                'Cache-Control': 'no-store',
            })
        origin = request.headers.get('Origin')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin:
            parsed = urlsplit(origin)
            if parsed.scheme != 'https' or parsed.netloc.lower() != request.host.lower():
                return Response('Origin not allowed', 403)
        return None

    @app.after_request
    def prevent_private_cache(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response
