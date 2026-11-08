"""Local speech recognition jobs for Splitclip."""
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import os
import uuid

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='subtitles')
_lock = Lock()
_jobs = {}
_model = None


def _update(job_id, **values):
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(values)


def _group_words(segments):
    """Produce one caption per spoken word, using Whisper's word timestamps."""
    groups = []
    for segment in segments:
        words = segment.words or []
        if not words:
            text = segment.text.strip()
            if text:
                pieces = text.split()
                step = max(.01, (segment.end - segment.start) / len(pieces))
                for i, piece in enumerate(pieces):
                    groups.append({'start': round(segment.start + i * step, 2), 'end': round(segment.start + (i + 1) * step, 2), 'text': piece})
            continue
        for word in words:
            if word.start is None or word.end is None or not word.word.strip():
                continue
            parts = word.word.strip().split()
            start = float(word.start)
            step = max(.05, (float(word.end) - start) / len(parts))
            for index, text in enumerate(parts):
                groups.append({'start': round(start + index * step, 2), 'end': round(start + (index + 1) * step, 2), 'text': text})
    return groups


def _run(job_id, path, language):
    global _model
    try:
        _update(job_id, state='loading', message='Загружаем более точную модель речи. При первом запуске потребуется около 1,5 ГБ из интернета.')
        if _model is None:
            from faster_whisper import WhisperModel
            from pathlib import Path
            _model = WhisperModel('medium', device='cpu', compute_type='int8', cpu_threads=min(6, os.cpu_count() or 1), download_root=str(Path(__file__).resolve().parent / 'models'))
        _update(job_id, state='transcribing', message='Распознаём речь…', progress=0)
        segments, info = _model.transcribe(str(path), language=language, beam_size=8, best_of=8, vad_filter=True, word_timestamps=True)
        found = []
        for segment in segments:
            found.append(segment)
            progress = min(99, max(0, int(100 * segment.end / info.duration))) if info.duration else 0
            _update(job_id, progress=progress)
        captions = _group_words(found)
        if not captions:
            _update(job_id, state='empty', message='Речь не найдена. Проверьте, что в видео есть звук.', segments=[])
        else:
            _update(job_id, state='done', message='Субтитры готовы. При необходимости исправьте текст.', progress=100, segments=captions)
    except Exception as exc:
        _update(job_id, state='error', message='Не удалось распознать речь. Проверьте интернет при первой загрузке модели и наличие звука в видео.', detail=str(exc)[:300])


def start(path, language=None):
    job_id = uuid.uuid4().hex
    with _lock:
        _jobs[job_id] = {'state': 'queued', 'message': 'Подготавливаем субтитры…', 'progress': 0}
    _executor.submit(_run, job_id, path, language)
    return job_id


def get(job_id):
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None
