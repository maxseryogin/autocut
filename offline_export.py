"""Frame-by-frame export: encode browser-composited frames and assemble audio."""
import math
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

EXPORT_FPS = 60
EXPORT_PROTOCOL = 2

FLAGS = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
jobs = {}
jobs_lock = threading.Lock()


def _media(data, key, directory, required=True):
    name = data.get(key)
    if not name and not required:
        return None
    if not isinstance(name, str) or not name or Path(name).name != name or not (directory / name).is_file():
        raise ValueError('Видео не найдено. Загрузите его заново.')
    return directory / name


def _number(value, low, high):
    try:
        value = float(value)
    except (ValueError, TypeError):
        raise ValueError('Некорректные параметры экспорта.')
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError('Некорректные параметры экспорта.')
    return value


def _has_audio(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, creationflags=FLAGS)
    if result.returncode:
        raise ValueError('Не удалось прочитать звук видео.')
    return bool(result.stdout.strip())


def start(data, directory):
    source = _media(data, 'source', directory)
    ad = _media(data, 'ad', directory, False)
    background = _media(data, 'background', directory, False)
    duration = _number(data.get('duration'), .01, 7200)
    ad_duration = _number(data.get('adDuration', 0), 0, 600)
    schedule = data.get('schedule', [])
    if not isinstance(schedule, list) or len(schedule) > 120 or (schedule and (not ad or ad_duration <= 0)):
        raise ValueError('Некорректные параметры баннера.')
    schedule = [_number(t, 0, duration) for t in schedule]
    if any(a >= b for a, b in zip(schedule, schedule[1:])):
        raise ValueError('Некорректное время вставок.')
    gains = [_number(data.get('sourceGain', 1), 0, 6), _number(data.get('adGain', 1), 0, 6)]
    count = math.ceil((duration + len(schedule) * ad_duration) * EXPORT_FPS - 1e-9)
    job_id = uuid.uuid4().hex
    video = directory / (job_id + '-frames.mp4')
    output = directory / (job_id + '.mp4')
    process = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', str(EXPORT_FPS), '-vcodec', 'mjpeg', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', str(video)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=FLAGS)
    job = dict(process=process, video=video, output=output, source=source, ad=ad, background=background, streams={}, duration=duration, ad_duration=ad_duration, schedule=schedule, gains=gains, expected=count, frames=0, touched=time.monotonic(), lock=threading.Lock(), cancelled=False)
    with jobs_lock:
        jobs[job_id] = job
    return job_id, count



class FrameDecoder:
    """Sequential FFmpeg decoder with a fixed presentation-time grid."""
    def __init__(self, path):
        self.path = path
        self.process = None
        self.buffer = bytearray()
        self.index = -1
        self.last = None
        self._start()

    def _start(self):
        self.process = subprocess.Popen([
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-i', str(self.path), '-map', '0:v:0', '-an',
            '-vf', f'fps={EXPORT_FPS}:start_time=0:round=down,tpad=stop_mode=clone:stop_duration=1',
            '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1',
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=FLAGS)
        self.buffer.clear()
        self.index = -1
        self.last = None

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.process and self.process.stdout:
            self.process.stdout.close()

    def _read(self):
        while True:
            start = self.buffer.find(b'\xff\xd8')
            if start >= 0:
                end = self.buffer.find(b'\xff\xd9', start + 2)
                if end >= 0:
                    image = bytes(self.buffer[start:end + 2])
                    del self.buffer[:end + 2]
                    return image
                if start:
                    del self.buffer[:start]
            if len(self.buffer) > 32 * 1024 * 1024:
                raise ValueError('Слишком большой кадр исходного видео.')
            chunk = self.process.stdout.read1(65536)
            if not chunk:
                raise ValueError('Не удалось декодировать кадр исходного видео.')
            self.buffer.extend(chunk)

    def get(self, index):
        if index < self.index:
            self.close()
            self._start()
        while self.index < index:
            self.last = self._read()
            self.index += 1
        return self.last


def input_frame(job_id, kind, index):
    job = jobs.get(job_id)
    if not job or kind not in ('source', 'ad', 'background') or not job.get(kind):
        raise ValueError('Исходное видео для экспорта не найдено.')
    if not isinstance(index, int) or index < 0 or index > 7200 * EXPORT_FPS:
        raise ValueError('Некорректный номер кадра.')
    with job['lock']:
        if job['cancelled']:
            raise ValueError('Экспорт отменён.')
        if kind not in job['streams']:
            job['streams'][kind] = FrameDecoder(job[kind])
        data = job['streams'][kind].get(index)
        job['touched'] = time.monotonic()
        return data

def frame(job_id, content):
    job = jobs.get(job_id)
    if not job:
        raise ValueError('Экспорт не найден.')
    if not content.startswith(b'\xff\xd8') or not content.endswith(b'\xff\xd9') or len(content) > 12 * 1024 * 1024:
        raise ValueError('Не удалось прочитать кадр.')
    with job['lock']:
        if job['cancelled'] or job['frames'] >= job['expected']:
            raise ValueError('Экспорт уже завершён.')
        try:
            job['process'].stdin.write(content)
        except (BrokenPipeError, OSError) as exc:
            raise ValueError('Кодировщик кадров остановился: ' + str(exc))
        job['frames'] += 1
        job['touched'] = time.monotonic()


def finish(job_id):
    job = jobs.get(job_id)
    if not job:
        raise ValueError('Экспорт не найден.')
    with job['lock']:
        if job['cancelled']:
            raise ValueError('Экспорт отменён.')
        # Разрешаем небольшое расхождение: браузер мог не отправить последний кадр
        # из-за округления или таймаута, но видео уже собрано.
        if job['frames'] < job['expected'] - 2:
            raise ValueError(f'Получены не все кадры видео ({job["frames"]} из {job["expected"]}).')
        job['touched'] = time.monotonic()
        try:
            job['process'].stdin.close()
        except (BrokenPipeError, OSError):
            pass
    try:
        code = job['process'].wait(timeout=600)
    except subprocess.TimeoutExpired:
        job['process'].kill()
        job['process'].wait()
        raise ValueError('Кодировщик кадров не завершился вовремя.')
    if job['cancelled']:
        raise ValueError('Экспорт отменён.')
    if code:
        raise ValueError(f'Кодировщик кадров завершился с ошибкой (код {code}).')
    for stream in job['streams'].values():
        stream.close()
    job['streams'].clear()
    source_audio = _has_audio(job['source'])
    ad_audio = bool(job['ad']) and _has_audio(job['ad'])
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(job['video']), '-i', str(job['source'])]
    if job['ad']:
        command += ['-i', str(job['ad'])]
    filters, labels = [], []
    def segment(input_index, start, length, has_audio, gain):
        if length <= 0:
            return
        label = 'a' + str(len(labels))
        if has_audio:
            filters.append(f'[{input_index}:a:0]aresample=48000:async=1:first_pts=0,apad,atrim=start={start:.9f}:duration={length:.9f},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={gain:.6f}[{label}]')
        else:
            filters.append(f'anullsrc=r=48000:cl=stereo,atrim=duration={length:.9f}[{label}]')
        labels.append(f'[{label}]')
    previous = 0
    for at in job['schedule']:
        segment(1, previous, at - previous, source_audio, job['gains'][0])
        segment(2, 0, job['ad_duration'], ad_audio, job['gains'][1])
        previous = at
    segment(1, previous, job['duration'] - previous, source_audio, job['gains'][0])
    if not labels:
        raise ValueError('Не удалось построить аудиодорожку.')
    filters.append(''.join(labels) + f'concat=n={len(labels)}:v=0:a=1,alimiter=limit=0.89[aout]')
    command += ['-filter_complex', ';'.join(filters), '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(job['output'])]
    proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=FLAGS)
    with job['lock']:
        job['mux'] = proc
        if job['cancelled']:
            proc.terminate()
    try:
        _, error = proc.communicate(timeout=600)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise ValueError('Сборка звука заняла слишком много времени.')
    if job['cancelled']:
        raise ValueError('Экспорт отменён.')
    if proc.returncode:
        detail = (error or b'').decode('utf-8', 'replace').strip()[-500:]
        raise ValueError('Не удалось собрать звук видео.' + ((' ' + detail) if detail else ''))
    try:
        job['video'].unlink(missing_ok=True)
    except OSError:
        pass
    with jobs_lock:
        jobs.pop(job_id, None)
    return job['output'].name

def cancel(job_id):
    with jobs_lock:
        job = jobs.pop(job_id, None)
    if not job:
        return
    job['cancelled'] = True
    for stream in list(job['streams'].values()):
        try:
            stream.close()
        except Exception:
            pass
    for proc in (job['process'], job.get('mux')):
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            except Exception:
                pass
    if job['process'].stdin and not job['process'].stdin.closed:
        try:
            job['process'].stdin.close()
        except (OSError, BrokenPipeError):
            pass
    # Не удаляем output сразу — дадим пользователю скачать, если он успел создаться.
    try:
        job['video'].unlink(missing_ok=True)
    except OSError:
        pass

def _reap():
    while True:
        time.sleep(60)
        now = time.monotonic()
        with jobs_lock:
            stale = [key for key, job in jobs.items() if now - job['touched'] > 900]
        for key in stale:
            cancel(key)


threading.Thread(target=_reap, daemon=True).start()
