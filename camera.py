"""Find a conservative webcam region around the most prominent detected face."""
import cv2
import numpy as np


def _boundary(profile, start, stop, threshold, side):
    start, stop = max(1, int(start)), min(len(profile) - 1, int(stop))
    if stop <= start:
        return None
    values = profile[start:stop]
    peaks = []
    for i in range(1, len(values) - 1):
        if values[i] >= threshold and values[i] >= values[i - 1] and values[i] >= values[i + 1]:
            peaks.append((start + i + 1, float(values[i])))
    if not peaks:
        return None
    best = max(score for _, score in peaks)
    # Prefer the first strong border in the direction away from the face.
    strong = [pos for pos, score in peaks if score >= best * .72]
    return min(strong) if side == 'after' else max(strong)


def _caption_band(frames, boundary):
    """Conservatively locate high-contrast text crossing a horizontal seam."""
    height, width = frames[0].shape[:2]
    if width > height or not (.18 * height < boundary < .8 * height):
        return None
    profiles = []
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        bright = (gray > 210).astype(np.uint8)
        dark = (gray < 65).astype(np.uint8)
        near_dark = cv2.dilate(dark, np.ones((7, 7), np.uint8))
        profiles.append((bright * near_dark)[:, int(width * .1):int(width * .9)].mean(axis=1))
    profile = np.median(profiles, axis=0)
    profile = np.convolve(profile, np.ones(5) / 5, mode='same')
    start = max(0, int(boundary - height * .10))
    end = min(height, int(boundary + height * .10))
    window = profile[start:end]
    if not len(window):
        return None
    peak, baseline = float(window.max()), float(np.median(window))
    if peak < .075:
        return None
    threshold = max(.025, baseline * 3, peak * .15)
    active = profile >= threshold
    groups, first = [], None
    for y in range(start, end):
        if active[y] and first is None:
            first = y
        if first is not None and (not active[y] or y == end - 1):
            last = y if active[y] else y - 1
            if groups and first - groups[-1][1] <= 6:
                groups[-1] = (groups[-1][0], last)
            else:
                groups.append((first, last))
            first = None
    candidates = [(a, b) for a, b in groups
                  if height * .008 <= b - a + 1 <= height * .10
                  and a - height * .025 <= boundary <= b + height * .025]
    if not candidates:
        return None
    a, b = max(candidates, key=lambda pair: float(profile[pair[0]:pair[1] + 1].max()))
    padding = max(5, int(round(height * .012)))
    return {'top': max(0, a - padding), 'bottom': min(height, b + padding + 1)}


def find_camera(path, current_time=0):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError('Не удалось открыть видео.')
    fps, count = cap.get(cv2.CAP_PROP_FPS), cap.get(cv2.CAP_PROP_FRAME_COUNT)
    duration = count / fps if fps > 0 else 0
    times = [max(0, current_time), 0.5, 2, 5, 10]
    frames = []
    for t in dict.fromkeys(min(t, max(0, duration - .2)) if duration else t for t in times):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if ok:
            frames.append(frame)
    cap.release()
    if not frames:
        raise ValueError('Не удалось прочитать кадр видео.')
    classifier = cv2.CascadeClassifier(str(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'))
    if classifier.empty():
        raise RuntimeError('Не найдена модель распознавания лиц.')
    faces = []
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        detected = classifier.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        if len(detected):
            faces.append(max(detected, key=lambda f: f[2] * f[3]))
    if not faces:
        return None
    x, y, fw, fh = map(int, np.median(np.array(faces), axis=0))
    height, width = frames[0].shape[:2]
    # Stable horizontal borders are visible across several frames even as the game moves.
    profiles = []
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
        profiles.append(np.abs(np.diff(gray, axis=0)).mean(axis=1))
    hp = np.median(profiles, axis=0)
    threshold = max(14.0, float(np.median(hp)) * 2.5)
    bottom = _boundary(hp, y + fh * 1.10, y + fh * 5, threshold, 'after')
    top = _boundary(hp, y - fh * 3, y - fh * .10, threshold, 'before')
    early_band = None
    # A webcam crop can cut through the detected face; in that case the real
    # seam is above the face's bottom. Accept it only with both a strong
    # full-width edge and caption evidence near that edge.
    if width <= height and not top:
        early = _boundary(hp, y + fh * .55, y + fh * 1.10, threshold, 'after')
        if early is not None and hp[early - 1] >= max(25.0, threshold * 1.5):
            candidate_band = _caption_band(frames, early)
            if candidate_band and (bottom is None or early < bottom):
                bottom, early_band = early, candidate_band
    if bottom is not None:
        top = top or 0
        # Portrait edits commonly put a full-width webcam above the game.
        if width <= height:
            left, right = 0, width
        else:
            left, right = max(0, int(x + fw / 2 - fw * 1.8)), min(width, int(x + fw / 2 + fw * 1.8))
        result = {'x': left, 'y': top, 'width': right - left, 'height': bottom - top, 'confidence': 'border'}
        if width <= height and top == 0:
            band = early_band or _caption_band(frames, bottom)
            if band:
                result['caption_band'] = band
        return result
    # Without a clear boundary, avoid guessing that all surrounding game is webcam.
    left = max(0, int(x + fw / 2 - fw * 1.7))
    right = min(width, int(x + fw / 2 + fw * 1.7))
    top = max(0, int(y - fh * .65))
    bottom = min(height, int(y + fh * 2.4))
    return {'x': left, 'y': top, 'width': right - left, 'height': bottom - top, 'confidence': 'face'}
