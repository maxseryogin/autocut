import asyncio
import re
import cv2
import numpy as np

class CaptionCheck:
    def __init__(self):
        from winsdk.windows.media.ocr import OcrEngine
        from winsdk.windows.globalization import Language
        self.engine=OcrEngine.try_create_from_language(Language('ru'))
        if self.engine is None: raise RuntimeError('Русский пакет распознавания текста Windows не установлен')
    async def _recognize(self, frame):
        from winsdk.windows.graphics.imaging import SoftwareBitmap,BitmapPixelFormat,BitmapAlphaMode
        from winsdk.windows.storage.streams import DataWriter
        im=cv2.resize(frame,(540,960)); im=cv2.cvtColor(im,cv2.COLOR_BGR2BGRA)
        writer=DataWriter(); writer.write_bytes(im.tobytes()); buf=writer.detach_buffer()
        bitmap=SoftwareBitmap.create_copy_from_buffer(buf,BitmapPixelFormat.BGRA8,540,960,BitmapAlphaMode.IGNORE)
        try: result=await self.engine.recognize_async(bitmap)
        finally: bitmap.close()
        found=[]
        for line in result.lines:
            if not line.words: continue
            boxes=[x.bounding_rect for x in line.words]
            top=min(x.y for x in boxes); height=max(x.height for x in boxes)
            left=min(x.x for x in boxes); right=max(x.x+x.width for x in boxes)
            center=(left+right)/2
            text=re.sub(r'[^а-яёa-z0-9]','',line.text.casefold())
            if 0.44*960<top<0.82*960 and height>0.028*960 and 0.25*540<center<0.75*540 and len(text)>=3:
                found.append(text)
        return found
    def check(self,path):
        cap=cv2.VideoCapture(str(path)); fps=cap.get(cv2.CAP_PROP_FPS) or 25
        duration=cap.get(cv2.CAP_PROP_FRAME_COUNT)/fps
        frames=[]
        for t in np.linspace(max(.2,duration*.12),max(.3,duration*.88),5):
            cap.set(cv2.CAP_PROP_POS_MSEC,float(t)*1000); ok,image=cap.read()
            if ok: frames.append(image)
        cap.release()
        async def run():
            result=[]
            for frame in frames: result.append(await self._recognize(frame))
            return result
        words=asyncio.run(run())
        hits=[set(x) for x in words if x]
        unique=set().union(*hits) if hits else set()
        return len(hits)>=2 and len(unique)>=2, len(hits)
