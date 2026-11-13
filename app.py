import os, sys, uuid, tempfile, threading, webbrowser, subprocess
from pathlib import Path
from urllib.parse import urlparse
from flask import Flask, request, jsonify, send_file, send_from_directory

BASE = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
sys.path.insert(0, str(BASE / 'vendor4'))
sys.path.insert(0, str(BASE / 'vendor_ytdlp'))
DATA = Path(os.environ['SPLITCLIP_MEDIA_DIR']) if os.environ.get('SPLITCLIP_MEDIA_DIR') else Path(tempfile.mkdtemp(prefix='splitclip-'))
DATA.mkdir(parents=True, exist_ok=True)
app = Flask(__name__, static_folder=str(BASE / 'static'), static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024 * 1024
from cloud_auth import configure_cloud_access
configure_cloud_access(app)

_twitch_lock = threading.Lock()
_twitch_instance = None

def twitch_library():
    global _twitch_instance
    with _twitch_lock:
        if _twitch_instance is None:
            from twitch_library import TwitchLibrary
            root = Path(os.environ.get('SPLITCLIP_TWITCH_DIR', BASE / 'twitch_data'))
            _twitch_instance = TwitchLibrary(root)
        return _twitch_instance

@app.before_request
def protect_local_twitch_actions():
    # Cross-site HTML forms can send POST requests to a localhost server even
    # without CORS. Only allow a browser origin belonging to this instance.
    if request.path.startswith('/api/twitch/') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('Origin')
        if origin:
            parsed = urlparse(origin)
            if parsed.scheme != request.scheme or parsed.netloc.lower() != request.host.lower():
                return jsonify(error='Запрос с другого сайта запрещён.'), 403

@app.get('/api/twitch/status')
def twitch_status():
    try: return jsonify(twitch_library().status())
    except (OSError, ValueError) as exc: return jsonify(error=str(exc)), 500

@app.post('/api/twitch/search')
def twitch_search():
    try:
        library = twitch_library()
        started = library.start()
        return jsonify(started=started, **library.status())
    except (OSError, ValueError) as exc: return jsonify(error=str(exc)), 500

@app.post('/api/twitch/stop')
def twitch_stop():
    library = twitch_library()
    library.stop()
    return jsonify(library.status())

@app.get('/api/twitch/clips/<clip_id>/video')
def twitch_video(clip_id):
    try: return send_file(twitch_library().video(clip_id), conditional=True, mimetype='video/mp4')
    except (ValueError, FileNotFoundError): return jsonify(error='Клип не найден.'), 404

@app.post('/api/twitch/clips/<clip_id>/select')
def twitch_select(clip_id):
    try: return jsonify(twitch_library().select(clip_id, DATA))
    except (ValueError, OSError) as exc: return jsonify(error=str(exc)), 400

@app.post('/api/twitch/clips/<clip_id>/reject')
def twitch_reject(clip_id):
    try:
        twitch_library().reject(clip_id)
        return '', 204
    except (ValueError, OSError) as exc: return jsonify(error=str(exc)), 400

@app.post('/api/export')
def export_start():
    import offline_export
    try:
        data = request.get_json(silent=True) or {}
        if data.get('protocol') != offline_export.EXPORT_PROTOCOL:
            return jsonify(error='Версии страницы и сервера не совпадают. Обнови страницу.'), 409
        job, count = offline_export.start(data, DATA)
        return jsonify(job=job, frames=count, fps=offline_export.EXPORT_FPS, protocol=offline_export.EXPORT_PROTOCOL), 201
    except (ValueError, OSError) as exc:
        return jsonify(error=str(exc) or 'Не удалось начать экспорт.'), 400

@app.get('/api/export/<job>/input/<kind>')
def export_input(job, kind):
    import offline_export
    from flask import Response
    try:
        index = int(request.args.get('index', ''))
        return Response(offline_export.input_frame(job, kind, index), mimetype='image/jpeg', headers={'Cache-Control': 'no-store'})
    except (ValueError, OSError) as exc:
        return jsonify(error=str(exc) or 'Не удалось декодировать кадр.'), 400

@app.post('/api/export/<job>/frame')
def export_frame(job):
    import offline_export
    try:
        offline_export.frame(job, request.get_data())
        return '', 204
    except (ValueError, OSError) as exc:
        return jsonify(error=str(exc) or 'Не удалось сохранить кадр.'), 400

@app.post('/api/export/<job>/finish')
def export_finish(job):
    import offline_export
    try:
        return jsonify(url='/media/' + offline_export.finish(job))
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        app.logger.warning('Export failed: %s', exc)
        offline_export.cancel(job)
        return jsonify(error=str(exc) or 'Не удалось собрать видео. Попробуйте ещё раз.'), 400

@app.delete('/api/export/<job>')
def export_cancel(job):
    import offline_export
    offline_export.cancel(job)
    return '', 204

@app.get('/healthz')
def healthz(): return jsonify(status='ok')

@app.get('/')
def index(): return app.send_static_file('index.html')

@app.get('/media/<path:name>')
def media(name): return send_from_directory(DATA, name, conditional=True)

@app.post('/api/upload')
def upload():
    f = request.files.get('file')
    if not f: return jsonify(error='Выберите видеофайл.'), 400
    suffix = Path(f.filename or '').suffix.lower()
    if suffix not in ('.mp4', '.mov', '.webm', '.mkv', '.m4v'): return jsonify(error='Поддерживаются MP4, MOV, WebM и MKV.'), 400
    name = uuid.uuid4().hex + suffix
    f.save(DATA / name)
    return jsonify(url='/media/' + name, name=f.filename)

@app.post('/api/import')
def import_video():
    url = (request.get_json(silent=True) or {}).get('url', '').strip()
    p = urlparse(url)
    host = (p.hostname or '').lower()
    if p.scheme not in ('https', 'http') or not (host == 'tiktok.com' or host.endswith('.tiktok.com')):
        return jsonify(error='Вставьте корректную ссылку на видео TikTok.'), 400
    name = uuid.uuid4().hex
    try:
        import yt_dlp
        opts = {'outtmpl': str(DATA / (name + '.%(ext)s')), 'format': 'best[ext=mp4]/best', 'noplaylist': True, 'quiet': True, 'no_warnings': True, 'socket_timeout': 25, 'restrictfilenames': True}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = Path(ydl.prepare_filename(info))
        if not path.exists(): raise RuntimeError('Загруженный файл не найден')
        return jsonify(url='/media/' + path.name, name=info.get('title') or 'TikTok')
    except Exception as exc:
        detail = str(exc)
        lower = detail.lower()
        if any(word in lower for word in ('winerror 10013', 'network is unreachable', 'failed to establish a new connection', 'timed out', 'timeout')):
            message = 'Нет доступа к TikTok. Проверьте интернет и перезапустите приложение через start.bat.'
        elif 'unexpected response' in lower or 'unable to extract' in lower:
            message = 'TikTok изменил способ выдачи видео. Обновите yt-dlp или загрузите видеофайл вручную.'
        elif any(word in lower for word in ('private', 'login required', 'not available', 'unavailable')):
            message = 'Видео недоступно: оно может быть закрытым, удалённым или ограниченным для просмотра.'
        else:
            message = 'Не удалось загрузить ролик. Проверьте ссылку или загрузите видеофайл вручную.'
        app.logger.warning('TikTok import failed: %s', detail[:400])
        return jsonify(error=message), 400

@app.post('/api/prepare-source')
def prepare_source():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', ''))
    if not name or Path(name).name != name or not (DATA / name).is_file():
        return jsonify(error='Исходное видео не найдено. Загрузите его заново.'), 400
    output = DATA / (uuid.uuid4().hex + '.mp4')
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(DATA / name),
               '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
               '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    try:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                timeout=600, creationflags=flags, check=False)
        if result.returncode or not output.is_file() or output.stat().st_size == 0:
            app.logger.warning('Source conversion failed: %s', result.stderr.decode('utf-8', errors='replace')[-1000:])
            raise ValueError('conversion failed')
        return jsonify(url='/media/' + output.name)
    except FileNotFoundError:
        output.unlink(missing_ok=True)
        return jsonify(error='Для преобразования видео нужен FFmpeg. Установите его и перезапустите приложение.'), 503
    except subprocess.TimeoutExpired:
        output.unlink(missing_ok=True)
        return jsonify(error='Преобразование видео заняло слишком много времени. Попробуйте более короткий файл.'), 408
    except (ValueError, OSError):
        output.unlink(missing_ok=True)
        return jsonify(error='Не удалось преобразовать видео для браузера. Попробуйте другой файл.'), 400

@app.post('/api/detect')
def detect():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', ''))
    if not name or Path(name).name != name or not (DATA / name).is_file():
        return jsonify(error='Сначала загрузите видео.'), 400
    try:
        from camera import find_camera
        region = find_camera(DATA / name, max(0, float(data.get('time', 0))))
        if region is None:
            return jsonify(error='Лицо не найдено. Выделите окно камеры вручную ниже.'), 404
        return jsonify(region)
    except Exception:
        app.logger.exception('Face detection failed')
        return jsonify(error='Не удалось запустить поиск лица. Проверьте установку OpenCV или настройте область вручную.'), 500

@app.post('/api/subtitles')
def create_subtitles():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', ''))
    if not name or Path(name).name != name or not (DATA / name).is_file():
        return jsonify(error='Сначала загрузите видео.'), 400
    language = data.get('language') or None
    if language not in (None, 'ru'):
        return jsonify(error='GigaAM v3 поддерживает только русский язык.'), 400
    from subtitles import start
    return jsonify(job_id=start(DATA / name, language)), 202

@app.get('/api/subtitles/<job_id>')
def subtitles_status(job_id):
    from subtitles import get
    job = get(job_id)
    return (jsonify(job), 200) if job else (jsonify(error='Задача распознавания не найдена.'), 404)

@app.post('/api/ad-moment')
def ad_moment():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', ''))
    if not name or Path(name).name != name or not (DATA / name).is_file():
        return jsonify(error='Сначала загрузите видео.'), 400
    try:
        import cv2
        from ad_timing import suggest_moment
        video = cv2.VideoCapture(str(DATA / name))
        fps, frames = video.get(cv2.CAP_PROP_FPS), video.get(cv2.CAP_PROP_FRAME_COUNT)
        video.release()
        if fps <= 0 or frames <= 0: raise ValueError('duration')
        return jsonify(suggest_moment(DATA / name, frames / fps))
    except Exception:
        app.logger.exception('Ad moment detection failed')
        return jsonify(error='Не удалось определить момент. Выберите его вручную.'), 400

@app.post('/api/inspect-media')
def inspect_media():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', ''))
    if not name or Path(name).name != name or not (DATA / name).is_file():
        return jsonify(error='Файл не найден.'), 400
    try:
        from media_inspection import inspect_audio, inspect_banner, fit_banner
        kind = data.get('kind')
        if kind == 'audio':
            return jsonify(inspect_audio(DATA / name))
        if kind in ('banner', 'banner-fit'):
            import math
            strength = float(data.get('strength', 50))
            if not math.isfinite(strength): raise ValueError('invalid settings')
            if kind == 'banner-fit': return jsonify(fit_banner(DATA / name, strength))
            scale, scale_y = float(data.get('scale', 100)), float(data.get('scale_y', data.get('scale', 100)))
            offset_x, offset_y = float(data.get('offset_x', 0)), float(data.get('offset_y', 0))
            if not all(map(math.isfinite,(scale,scale_y,offset_x,offset_y))): raise ValueError('invalid settings')
            return jsonify(inspect_banner(DATA / name, strength, scale, scale_y, offset_x, offset_y))
        return jsonify(error='Неизвестный тип проверки.'), 400
    except Exception:
        app.logger.exception('Media inspection failed')
        return jsonify(error='Не удалось проверить файл.'), 400

if __name__ == '__main__':
    if '--no-browser' not in sys.argv:
        threading.Timer(1, lambda: webbrowser.open('http://127.0.0.1:8765')).start()
    app.run(host='127.0.0.1', port=8765, threaded=True, debug=False)
