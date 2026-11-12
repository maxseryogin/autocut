FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 splitclip \
    && mkdir -p /data/models /tmp/splitclip-media \
    && chown -R splitclip:splitclip /data /tmp/splitclip-media
COPY requirements.txt requirements-cloud.txt ./
RUN pip install -r requirements-cloud.txt
COPY --chown=splitclip:splitclip . .
USER splitclip
ENV SPLITCLIP_CLOUD=1 SPLITCLIP_MODEL_DIR=/data/models SPLITCLIP_MEDIA_DIR=/tmp/splitclip-media SPLITCLIP_GIGAAM_THREADS=2
EXPOSE 8765
CMD ["gunicorn", "--bind", "0.0.0.0:8765", "--workers", "1", "--threads", "6", "--timeout", "300", "app:app"]
