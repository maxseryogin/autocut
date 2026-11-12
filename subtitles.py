"""Local Russian GigaAM v3 F32 speech recognition jobs for Splitclip."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
import os
import subprocess
import sys
import tempfile
import uuid

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='subtitles')
_lock = Lock()
_jobs = {}
_model = None
MODEL_NAME = 'gigaam-v3-e2e-ctc'
MODEL_FILES = ('v3_e2e_ctc.onnx', 'v3_e2e_ctc_vocab.txt')
SAMPLE_RATE = 16000
WINDOW = 18
STEP = 16


def _update(job_id, **values):
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(values)


def _model_dir():
    root = os.environ.get('SPLITCLIP_MODEL_DIR') or str(Path(__file__).resolve().parent / 'models')
    return Path(root) / 'gigaam-v3-f32'


def _load_model(job_id):
    # Prevent Hugging Face's optional Xet client from creating a cache on C:.
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    import onnx_asr
    import onnxruntime as ort
    directory = _model_dir()
    directory.mkdir(parents=True, exist_ok=True)
    missing = any(not (directory / name).is_file() or (directory / name).stat().st_size == 0 for name in MODEL_FILES)
    _update(job_id, state='loading', message=('Скачиваем GigaAM v3 F32 на диск модели (около 900 МБ)…' if missing else 'Загружаем GigaAM v3 F32 в память…'))
    if missing:
        # Keep the download and its temporary cache alongside the model, not on C:.
        from huggingface_hub import hf_hub_download, constants
        constants.HF_HUB_DISABLE_XET = True
        for filename in MODEL_FILES:
            hf_hub_download('istupakov/gigaam-v3-onnx', filename, local_dir=directory, cache_dir=directory / '.cache' / 'hub')
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(6, int(os.environ.get('SPLITCLIP_GIGAAM_THREADS', os.cpu_count() or 1))))
    return onnx_asr.load_model(MODEL_NAME, path=directory, quantization=None, providers=['CPUExecutionProvider'], sess_options=options).with_timestamps()


def _words(result, offset, duration, keep_start, keep_end):
    """Combine timestamped subword tokens into words and retain the window's core."""
    tokens, timestamps = result.tokens or [], result.timestamps or []
    if len(tokens) != len(timestamps):
        raise ValueError('Модель не вернула временные метки слов.')
    grouped = []
    text, first, last = '', None, None

    def finish():
        if not text.strip() or first is None:
            return
        begin = max(offset, offset + float(first))
        end = min(offset + duration, offset + float(last) + .04)
        midpoint = (begin + end) / 2
        if keep_start <= midpoint < keep_end and end > begin:
            grouped.append({'start': round(max(begin, keep_start), 3), 'end': round(min(end, keep_end), 3), 'text': text.strip()})

    for token, timestamp in zip(tokens, timestamps):
        if not token:
            continue
        if token[0].isspace() and text.strip():
            finish()
            text, first, last = '', None, None
        if token.strip() and first is None:
            first = timestamp
        text += token
        if token.strip():
            last = timestamp
    finish()
    return grouped


def _transcribe(model, path, job_id):
    import numpy as np
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    # Decode to a temporary raw file and memory-map it: long videos do not fill RAM.
    with tempfile.TemporaryDirectory(prefix='splitclip-asr-', dir=str(Path(path).parent)) as temp:
        pcm = Path(temp) / 'audio.f32'
        proc = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(path), '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE), '-f', 'f32le', str(pcm)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=1800, creationflags=flags)
        if proc.returncode or not pcm.exists() or pcm.stat().st_size < 4:
            raise ValueError('Не удалось прочитать звук видео.')
        samples = np.memmap(pcm, dtype='<f4', mode='r')
        try:
            total = len(samples) / SAMPLE_RATE
            captions = []
            start = 0
            while start < len(samples):
                end = min(start + WINDOW * SAMPLE_RATE, len(samples))
                offset, duration = start / SAMPLE_RATE, (end - start) / SAMPLE_RATE
                keep_start = 0 if start == 0 else offset + (WINDOW - STEP) / 2
                keep_end = total + 1 if end == len(samples) else offset + WINDOW - (WINDOW - STEP) / 2
                result = model.recognize(np.array(samples[start:end], dtype=np.float32), sample_rate=SAMPLE_RATE)
                captions.extend(_words(result, offset, duration, keep_start, keep_end))
                _update(job_id, progress=min(99, int(100 * end / len(samples))))
                if end == len(samples):
                    break
                start += STEP * SAMPLE_RATE
            return captions
        finally:
            del samples


def _run(job_id, path, language):
    global _model
    try:
        if language not in (None, 'ru'):
            raise ValueError('GigaAM v3 распознаёт только русский язык.')
        if _model is None:
            _model = _load_model(job_id)
        _update(job_id, state='transcribing', message='Распознаём русскую речь с GigaAM v3 F32…', progress=0)
        captions = _transcribe(_model, path, job_id)
        if not captions:
            _update(job_id, state='empty', message='Речь не найдена. Проверьте, что в видео есть звук.', segments=[])
        else:
            _update(job_id, state='done', message='Субтитры готовы. Проверьте текст и время слов.', progress=100, segments=captions)
    except Exception as exc:
        _update(job_id, state='error', message='Не удалось распознать речь. Проверьте звук, установку GigaAM и интернет при первой загрузке.', detail=str(exc)[:300])


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
