"""Lightweight temporal analysis and preference ranking; not a semantic video classifier."""
import cv2
import numpy as np

def video_features(path):
    cap=cv2.VideoCapture(str(path))
    if not cap.isOpened(): raise ValueError('Не удалось прочитать видео')
    fps=cap.get(cv2.CAP_PROP_FPS) or 25
    frames=cap.get(cv2.CAP_PROP_FRAME_COUNT)
    duration=frames/fps if frames else 0
    if duration <= 0: cap.release(); raise ValueError('Не удалось определить длительность')
    samples=[]
    for t in np.linspace(0.1, max(.1,duration-.2), min(12,max(3,int(duration//2)))):
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t)*1000)
        ok, image=cap.read()
        if not ok: continue
        image=cv2.resize(image,(96,160))
        hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
        samples.append((gray,hsv))
    cap.release()
    if len(samples)<2: raise ValueError('Недостаточно кадров для проверки')
    top=[]; bottom=[]
    for (a,_),(b,__) in zip(samples,samples[1:]):
        top.append(float(np.mean(cv2.absdiff(a[:65],b[:65]))/255))
        bottom.append(float(np.mean(cv2.absdiff(a[65:],b[65:]))/255))
    arr=np.stack([h for _,h in samples]).astype('float32')
    vec=[min(duration,180)/180, float(np.mean(top)),float(np.mean(bottom)),float(np.std(top)),float(np.std(bottom))]
    for crop in (arr[:,:65,:,:], arr[:,65:,:,:]):
        # Robust descriptive features, not evidence of identity or subtitles.
        vec.extend((float(np.mean(crop[:,:,:,i])/([180,255,255][i])) for i in range(3)))
        vec.append(float(np.std(crop[:,:,:,2])/255))
    return duration, [round(x,6) for x in vec]

def preference_scores(items, decisions):
    result=[None]*len(items)
    if len(decisions)<12: return result
    try:
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        from sklearn.linear_model import LogisticRegression
        for n in {len(x) for x in items if isinstance(x,list)}:
            pairs=[(x,y) for x,y in decisions if isinstance(x,list) and len(x)==n]
            x=[a for a,b in pairs]; y=[b for a,b in pairs]
            if y.count(0)<6 or y.count(1)<6: continue
            model=make_pipeline(StandardScaler(),LogisticRegression(class_weight='balanced',random_state=0))
            model.fit(x,y)
            idx=[i for i,a in enumerate(items) if isinstance(a,list) and len(a)==n]
            probs=model.predict_proba([items[i] for i in idx])[:,1]
            for i,prob in zip(idx,probs): result[i]=float(prob)
    except (ValueError, ImportError): pass
    return result

def preference_score(features, decisions):
    return preference_scores([features],decisions)[0]
