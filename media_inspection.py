"""Local media inspection for campaign requirements and playback loudness."""
import json, math, re, subprocess, sys
import cv2
import numpy as np


def inspect_audio(path):
    flags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0
    try:
        run=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(path),'-vn','-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=120,creationflags=flags)
        text=run.stderr.decode('utf-8',errors='replace')
        match=re.search(r'\{\s*"input_i"\s*:[\s\S]*?\}',text)
        if run.returncode or not match:
            return {'state':'missing','message':'Звуковая дорожка не найдена или не читается.'}
        values=json.loads(match.group())
        loudness=float(values['input_i'])
        if not math.isfinite(loudness) or loudness < -65:
            return {'state':'silent','message':'Звук отсутствует или почти не слышен.'}
        gain_db=max(-15.0,min(15.0,-16.0-loudness))
        return {'state':'ok','lufs':round(loudness,1),'gain_db':round(gain_db,1),'gain':round(10**(gain_db/20),4),'limited':abs(-16.0-loudness)>15.0}
    except (OSError,subprocess.TimeoutExpired,ValueError,KeyError,json.JSONDecodeError):
        return {'state':'error','message':'Не удалось измерить громкость.'}


def _banner_frames(path):
    cap=cv2.VideoCapture(str(path))
    if not cap.isOpened(): return None, None
    fps,count=cap.get(cv2.CAP_PROP_FPS),cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if fps<=0 or count<=0:
        cap.release();return None, None
    duration=count/fps;frames=[]
    for fraction in np.linspace(.025,.975,20):
        cap.set(cv2.CAP_PROP_POS_MSEC,min(duration-.01,duration*fraction)*1000)
        ok,frame=cap.read()
        if ok: frames.append(frame)
    cap.release()
    return frames,duration


def _measure_banner(frames,duration,strength=50,scale_percent=100,scale_y_percent=None,offset_x=0,offset_y=0):
    width,height=360,640
    strength=max(0,min(100,float(strength)))
    sx=max(50,min(170,float(scale_percent)))/100
    sy=max(50,min(170,float(scale_y_percent if scale_y_percent is not None else scale_percent)))/100
    dx=max(-100,min(100,float(offset_x)))*width/100
    dy=max(-100,min(100,float(offset_y)))*height/100
    samples=[]
    for frame in frames:
        h,w=frame.shape[:2]; base=min(width/w,height/h)
        rw,rh=max(1,round(w*base*sx)),max(1,round(h*base*sy))
        resized=cv2.resize(frame,(rw,rh),interpolation=cv2.INTER_AREA if max(sx,sy)*base<1 else cv2.INTER_LINEAR)
        x=round((width-rw)/2+dx);y=round((height-rh)/2+dy)
        x0,y0=max(0,x),max(0,y);x1,y1=min(width,x+rw),min(height,y+rh)
        rgb=np.zeros((height,width,3),dtype=np.uint8);valid=np.zeros((height,width),dtype=bool)
        if x1>x0 and y1>y0:
            rgb[y0:y1,x0:x1]=resized[y0-y:y1-y,x0-x:x1-x];valid[y0:y1,x0:x1]=True
        b=rgb[:,:,0].astype(np.int16);g=rgb[:,:,1].astype(np.int16);r=rgb[:,:,2].astype(np.int16)
        diff=g-np.maximum(r,b);threshold=42-strength*.35
        visible=valid & ~((g>=55)&(diff>=threshold+14))
        ys,xs=np.where(visible)
        if len(xs)==0:
            samples.append({'visible_percent':0,'box_percent':0,'centered':False,'clipped':False,'bounds':None});continue
        left,right,top,bottom=int(xs.min()),int(xs.max())+1,int(ys.min()),int(ys.max())+1
        centered=left<=width*.5<=right and top<=height*.5<=bottom and abs((left+right)/2-width/2)<=width*.10 and abs((top+bottom)/2-height/2)<=height*.10
        samples.append({'visible_percent':round(100*len(xs)/(width*height),2),'box_percent':round(100*(right-left)*(bottom-top)/(width*height),2),'centered':bool(centered),'clipped':bool(left<=0 or top<=0 or right>=width or bottom>=height),'bounds':[left,top,right,bottom]})
    if len(samples)<5:return {'state':'error','message':'Не удалось проверить все кадры баннера.'}
    return {'state':'ok','duration':round(duration,3),'samples':samples,'sample_count':len(samples),'min_visible_percent':min(s['visible_percent'] for s in samples),'min_box_percent':min(s['box_percent'] for s in samples),'centered':all(s['centered'] for s in samples),'clipped':any(s['clipped'] for s in samples)}


def inspect_banner(path,strength=50,scale_percent=100,scale_y_percent=None,offset_x=0,offset_y=0):
    frames,duration=_banner_frames(path)
    if frames is None:return {'state':'error','message':'Не удалось прочитать баннер.'}
    return _measure_banner(frames,duration,strength,scale_percent,scale_y_percent,offset_x,offset_y)


def fit_banner(path,strength=50):
    frames,duration=_banner_frames(path)
    if frames is None:return {'state':'error','message':'Не удалось прочитать баннер.'}
    base=_measure_banner(frames,duration,strength)
    if base['state']!='ok':return base
    boxes=[s['bounds'] for s in base['samples'] if s['bounds']]
    if not boxes:
        return {'state':'manual','message':'Баннер не виден после удаления зелёного. Проверьте файл и настройки хромакея.','inspection':base}
    left=min(b[0] for b in boxes);top=min(b[1] for b in boxes);right=max(b[2] for b in boxes);bottom=max(b[3] for b in boxes)
    max_x=max(50,min(170,int(100*356/max(1,right-left))))
    max_y=max(50,min(170,int(100*636/max(1,bottom-top))))
    positive=[s['visible_percent'] for s in base['samples'] if s['visible_percent']>0]
    typical=float(np.median(positive)) if positive else 0
    targets=[base['min_visible_percent'],typical]
    for strict,area in enumerate(targets):
        if area<=0:continue
        product=26.0/area*10000;candidates=[]
        for sx in range(50,max_x+1):
            sy=max(50,math.ceil(product/sx))
            if sy<=max_y and max(sx,sy)/min(sx,sy)<=1.15:
                candidates.append((abs(math.log(sx/sy))+.0001*abs(sx+sy-200),sx,sy))
        candidates.sort()
        for _,sx,sy in candidates[:12]:
            ox=round(-(left+right-360)/2*(sx/100)/360*100,2)
            oy=round(-(top+bottom-640)/2*(sy/100)/640*100,2)
            result=_measure_banner(frames,duration,strength,sx,sy,ox,oy)
            good=sum(s['visible_percent']>=25 and s['centered'] for s in result.get('samples',[]))
            visible_centered=all(s['centered'] for s in result.get('samples',[]) if s['visible_percent']>0)
            if result['state']=='ok' and not result['clipped'] and visible_centered and (good==len(result['samples']) if strict==0 else good>=len(result['samples'])*.65):
                state='ok' if good==len(result['samples']) else 'partial'
                message='Размер подобран, но в части кадров исходная анимация меньше 25%; одной общей подгонкой гарантировать условие не удалось.' if state=='partial' else ''
                return {'state':state,'message':message,'scale_x':sx,'scale_y':sy,'offset_x':ox,'offset_y':oy,'inspection':result,'adjusted_aspect':abs(sx-sy)>1}
    # Even if an animation cannot satisfy every sampled frame, fit it without cropping.
    sx=sy=min(max_x,max_y)
    ox=round(-(left+right-360)/2*(sx/100)/360*100,2);oy=round(-(top+bottom-640)/2*(sy/100)/640*100,2)
    result=_measure_banner(frames,duration,strength,sx,sy,ox,oy)
    if result['state']=='ok' and not result['clipped']:
        return {'state':'partial','message':'Баннер увеличен без обрезки, но часть кадров меньше 25%; проверьте исходную анимацию.','scale_x':sx,'scale_y':sy,'offset_x':ox,'offset_y':oy,'inspection':result,'adjusted_aspect':False}
    return {'state':'manual','message':'Не удалось надёжно подобрать размер без обрезки. Проверьте баннер вручную.','inspection':base}
