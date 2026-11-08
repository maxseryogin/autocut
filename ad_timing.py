"""Suggest a pause before a louder moment near the middle of a clip."""
import subprocess
import sys
import numpy as np


def suggest_from_audio(audio, sample_rate=8000):
    window=int(sample_rate*.5)
    audio=np.asarray(audio,dtype=np.float32)
    count=len(audio)//window
    if count < 8:
        return max(.1, len(audio)/sample_rate/2), False
    levels=np.sqrt(np.mean(np.square(audio[:count*window].reshape(count,window)),axis=1))
    smooth=np.convolve(levels,np.ones(3)/3,mode='same')
    if np.max(smooth)<80:
        return count*.25, False
    start=max(1,int(count*.38)); end=max(start+1,min(count-1,int(count*.75)))
    peak=start+int(np.argmax(smooth[start:end]))
    low=max(int(count*.20),peak-10,1); high=max(low+1,peak-1)
    candidates=np.arange(low,high)
    if not len(candidates):
        return max(.1,peak*.5-1), False
    normalized=smooth[candidates]/max(float(smooth[peak]),1)
    score=normalized+.035*(peak-candidates)+.02*np.abs(candidates-count*.5)
    best=int(candidates[np.argmin(score)])
    return round((best+.5)*.5,2), True


def suggest_moment(path,duration):
    duration=float(duration)
    if duration<=0:
        raise ValueError('Не удалось определить длительность видео.')
    try:
        flags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0
        proc=subprocess.run(['ffmpeg','-v','error','-i',str(path),'-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'],capture_output=True,timeout=120,creationflags=flags,check=True)
        pcm=np.frombuffer(proc.stdout,dtype='<i2')
        if not len(pcm): raise ValueError('no audio')
        moment, detected=suggest_from_audio(pcm)
        return {'time':round(min(max(.1,moment),max(.1,duration-.2)),2),'method':'audio' if detected else 'middle'}
    except (OSError,subprocess.SubprocessError,ValueError):
        return {'time':round(duration*.5,2),'method':'middle'}
