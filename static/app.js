const $ = id => document.getElementById(id);
const source = $('source'), background = $('background'), adVideo = $('adVideo'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const composition = window.SplitClipComposition;
const cropCanvas = $('cropCanvas'), cropCtx = cropCanvas.getContext('2d');
const keyCanvas=document.createElement('canvas');const keyCtx=keyCanvas.getContext('2d',{willReadFrequently:true});
let loaded = false, recording = false, customURL = null, adURL = null, crop = null, dragStart = null, sourceVersion = 0, cropRevision = 0, activeRecorder = null, exportCancelled = false, exportFailed = false;
let phase='source', adIndex=0, activeAdAt=0, playing=false, adAt=0, adReady=false, timingRevision=0, seekRevision=0, transitioning=false;
let audioContext=null, audioMix=null, sourceGain=null, adGain=null;
let sourceAudio={state:'pending'}, adAudio={state:'pending'}, adInspection=null, adServerName=null, adVersion=0, inspectionVersion=0, inspectionTimer=null;
let fitVersion=0, fitTimer=null, autoFit=true, adAspect=1, adOffsetX=0, adOffsetY=0;
let cachedAdFrame=-1, cachedKeyStrength=-1;
let subtitles = [], subtitleState = 'idle', subtitleVersion = 0;
let lastExportURL = null;
const message = text => $('message').textContent = text;
const fmt = n => Number.isFinite(n) ? `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(Math.floor(n % 60)).padStart(2,'0')}` : '00:00';
function setBusy(busy, text) { $('import').disabled = busy; $('import').textContent = busy ? 'Загрузка…' : 'Загрузить ↗'; if (text) $('sourceStatus').textContent = text; }
function setEditingDisabled(disabled) {
  for (const id of ['import','sourceFile','backgroundFile','removeBackground','adFile','detect','zoom','x','y','seek','resetCrop','subtitleEnabled','subtitleLanguage','subtitleRetry','adEnabled','adTime','adCurrent','keyStrength','adScale','adAutoFit','quality']) $(id).disabled = disabled || (['detect','seek','resetCrop','subtitleRetry','adTime','adCurrent'].includes(id) && !loaded) || (id==='removeBackground'&&!customURL) || (id==='adEnabled'&&!adReady) || (id==='adAutoFit'&&!adServerName) || (id==='subtitleRetry' && ['queued','loading','transcribing'].includes(subtitleState));
  document.querySelectorAll('.subtitle-text, .subtitle-time').forEach(el => el.disabled = disabled);
  $('cropDetails').classList.toggle('locked', disabled);
}
function fullCrop() { return {x:0, y:0, width:source.videoWidth, height:source.videoHeight}; }
function setRenderQuality(){
  const width=$('quality').value==='720'?720:1080,scale=width/720;
  canvas.width=width;canvas.height=Math.round(1280*scale);ctx.setTransform(scale,0,0,scale,0,0);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  keyCanvas.width=canvas.width;keyCanvas.height=canvas.height;keyCtx.imageSmoothingEnabled=true;keyCtx.imageSmoothingQuality='high';cachedAdFrame=-1;
}
$('quality').onchange=()=>{if(!recording)setRenderQuality();};
setRenderQuality();
function resetAdjustment() { $('zoom').value=1; $('x').value=50; $('y').value=50; updateValues(); }
function setCrop(rect) {
  const w=source.videoWidth,h=source.videoHeight;
  const x=Math.max(0,Math.min(w-1,rect.x)), y=Math.max(0,Math.min(h-1,rect.y));
  crop={x,y,width:Math.max(1,Math.min(w-x,rect.width)),height:Math.max(1,Math.min(h-y,rect.height))};
  cropRevision++;
  resetAdjustment();
}
async function loadSource(result) {
  const version=++sourceVersion;
  pauseComposition(); loaded=false; source.src=result.url; source.load();
  await new Promise((resolve,reject)=>{source.onloadedmetadata=resolve;source.onerror=()=>reject(new Error('Браузер не смог открыть это видео. Попробуйте MP4.'));});
  if(version!==sourceVersion)return;
  loaded=true; crop=null; cropRevision++; resetAdjustment(); $('empty').style.display='none'; $('sourceStatus').textContent=`Готово: ${result.name}`;
  $('detect').disabled=false; $('play').disabled=false; $('export').disabled=false; $('resetCrop').disabled=false;
  phase='source';adIndex=0;adAt=source.duration*.5;setAdTime(adAt);$('adTime').disabled=false;$('adCurrent').disabled=false;updateTimeline();
  sourceAudio={state:'pending'};inspectAudio(decodeURIComponent(new URL(source.src).pathname.split('/').pop()),'source',version);
  syncBackground(true); message(''); if(customURL)$('detect').click();else $('detectStatus').textContent='Без фона исходный ролик показывается целиком. Для режима с фоном можно выбрать камеру.'; startSubtitles();suggestAdMoment(version);renderValidation();
}
$('import').onclick=async()=>{
  const url=$('url').value.trim(); if(!url)return message('Вставьте ссылку на видео TikTok.');
  setBusy(true,'Загружаем видео из TikTok…'); message('');
  try { const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}); const data=await r.json(); if(!r.ok)throw new Error(data.error); await loadSource(data); }
  catch(e){$('sourceStatus').textContent='Видео не загружено'; message(e.message);} finally{setBusy(false);}
};
async function upload(file){const data=new FormData();data.append('file',file);const r=await fetch('/api/upload',{method:'POST',body:data});const json=await r.json();if(!r.ok)throw new Error(json.error);return json;}
$('sourceFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;setBusy(true,'Загружаем файл…');try{await loadSource(await upload(file));}catch(err){message(err.message);}finally{setBusy(false);e.target.value='';}};
$('backgroundFile').onchange=e=>{
  const file=e.target.files[0];if(!file)return;
  background.pause();if(customURL)URL.revokeObjectURL(customURL);customURL=URL.createObjectURL(file);background.src=customURL;background.load();
  $('backgroundStatus').textContent=`Свой фон: ${file.name}`;$('removeBackground').hidden=false;$('removeBackground').disabled=false;
  if(loaded&&!crop&&!$('detect').disabled)$('detect').click();
  e.target.value='';
};
$('removeBackground').onclick=()=>{if(recording||!customURL)return;background.pause();URL.revokeObjectURL(customURL);customURL=null;background.removeAttribute('src');background.load();$('removeBackground').hidden=true;$('removeBackground').disabled=true;$('backgroundStatus').textContent='Без фона исходное видео показывается целиком с лёгкой цветокоррекцией.';};
background.onloadedmetadata=()=>{syncBackground(true);if(loaded&&playing&&phase==='source')background.play().catch(()=>{});};
background.onerror=()=>{if(customURL)$('backgroundStatus').textContent='Не удалось открыть фоновое видео. Попробуйте MP4 или WebM.';};
async function inspectRequest(name,kind,extra={}){const r=await fetch('/api/inspect-media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,kind,...extra})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
function updateAudioStatus(){
  if(sourceAudio.state==='pending'||(hasAd()&&adAudio.state==='pending'))$('audioStatus').textContent='Измеряем громкость исходника и баннера…';
  else if(sourceAudio.state==='ok'&&(!hasAd()||adAudio.state==='ok'))$('audioStatus').textContent=(sourceAudio.limited||(hasAd()&&adAudio.limited))?'Усиление ограничено: громкость может различаться, проверь на слух.':'Громкость выравнивается автоматически; громкие пики ограничиваются.';
  else $('audioStatus').textContent='Не удалось выровнять звук: проверь слышимость и аудиодорожки исходника и баннера.';
  if(sourceGain)sourceGain.gain.setTargetAtTime(sourceAudio.state==='ok'?sourceAudio.gain:1,audioContext.currentTime,.03);
  if(adGain)adGain.gain.setTargetAtTime(adAudio.state==='ok'?adAudio.gain:1,audioContext.currentTime,.03);
}
async function inspectAudio(name,kind,version){
  try{const result=await inspectRequest(name,'audio');if((kind==='source'&&version!==sourceVersion)||(kind==='ad'&&version!==adVersion))return;if(kind==='source')sourceAudio=result;else adAudio=result;}
  catch(e){if((kind==='source'&&version!==sourceVersion)||(kind==='ad'&&version!==adVersion))return;if(kind==='source')sourceAudio={state:'error'};else adAudio={state:'error'};}
  updateAudioStatus();renderValidation();
}
function adScaleY(){return Math.max(50,Math.min(170,Number($('adScale').value)*adAspect));}
function queueBannerInspection(){
  const version=++inspectionVersion;clearTimeout(inspectionTimer);adInspection=null;renderValidation();if(!adServerName)return;
  inspectionTimer=setTimeout(async()=>{try{const result=await inspectRequest(adServerName,'banner',{strength:Number($('keyStrength').value),scale:Number($('adScale').value),scale_y:adScaleY(),offset_x:adOffsetX,offset_y:adOffsetY});if(version!==inspectionVersion)return;adInspection=result;}catch(e){if(version!==inspectionVersion)return;adInspection={state:'error'};}renderValidation();},400);
}
async function autoFitBanner(){
  if(!adServerName||recording)return;
  autoFit=true;const version=++fitVersion,mediaVersion=adVersion;const inspect=++inspectionVersion;clearTimeout(inspectionTimer);
  $('adFitStatus').textContent='Подбираем положение и размер…';adInspection=null;renderValidation();
  try{
    const result=await inspectRequest(adServerName,'banner-fit',{strength:Number($('keyStrength').value)});
    if(version!==fitVersion||mediaVersion!==adVersion||inspect!==inspectionVersion)return;
    if(result.state==='ok'||result.state==='partial'){
      $('adScale').value=result.scale_x;adAspect=result.scale_y/result.scale_x;adOffsetX=result.offset_x;adOffsetY=result.offset_y;
      $('adScaleValue').textContent=result.scale_x+'%';cachedAdFrame=-1;adInspection=result.inspection;
      const aspect=result.adjusted_aspect?' Пропорции по высоте изменены, чтобы не обрезать края.':'';
      $('adFitStatus').textContent=result.state==='partial'?'Размер подобран, но в части кадров баннер меньше 25%; одной общей подгонкой гарантировать условие не удалось.'+aspect:(result.adjusted_aspect?'Размер и центр подобраны; высота немного изменена, чтобы сохранить края и достичь 25%. Проверь всю анимацию.':'Размер и центр подобраны автоматически. Проверь всю анимацию.');
    }else{$('adFitStatus').textContent=result.message||'Не удалось подобрать размер автоматически. Попробуй настроить вручную.';queueBannerInspection();}
  }catch(e){if(version!==fitVersion||mediaVersion!==adVersion)return;adInspection={state:'error'};$('adFitStatus').textContent='Не удалось подобрать размер автоматически. Попробуй настроить вручную.';}
  renderValidation();
}
function drawChecks(container,items){container.replaceChildren();for(const item of items){const row=document.createElement('div');row.className=`validation-item ${item.state}`;row.textContent=({pass:'✓ ',fail:'! ',pending:'… ',manual:'○ '})[item.state]+item.message;container.append(row);}}
function renderValidation(){
  drawChecks($('validationList'),composition.validateProject({duration:loaded?source.duration:NaN,adAt,adEnabled:hasAd(),adDuration:adVideo.duration||0,adInspection,adAudio,sourceAudio}));
}
function hasAd(){return adReady&&$('adEnabled').checked&&Number.isFinite(adVideo.duration)&&adVideo.duration>0;}
function schedule(){return composition.adSchedule(source.duration||0,adAt,hasAd());}
function completedAt(time){return schedule().filter(point=>point<=time).length;}
function setAdTime(value){adAt=Math.max(0,Math.min(Math.max(0,(source.duration||0)-.1),value));$('adTime').value=source.duration?adAt/source.duration*1000:500;$('adTimeValue').textContent=fmt(adAt);}
async function suggestAdMoment(version){
  const revision=++timingRevision;$('adMomentStatus').textContent='Ищем паузу перед более громким моментом…';
  try{const response=await fetch('/api/ad-moment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:decodeURIComponent(new URL(source.src).pathname.split('/').pop())})});const data=await response.json();if(!response.ok)throw new Error(data.error);if(version!==sourceVersion||revision!==timingRevision)return;const low=source.duration<=20?0:10,high=source.duration<=20?source.duration/2:Math.min(15,source.duration/2);setAdTime(Math.max(low,Math.min(high,data.time)));$('adMomentStatus').textContent='Выбран момент с учётом длительности; проверь его перед экспортом.';adIndex=completedAt(source.currentTime);updateTimeline();renderValidation();}catch(e){if(version===sourceVersion&&revision===timingRevision)$('adMomentStatus').textContent='Не удалось найти момент автоматически. Выбери его ползунком.';}
}
$('adTime').oninput=()=>{if(!loaded||recording)return;timingRevision++;pauseComposition();setAdTime(source.duration*Number($('adTime').value)/1000);phase='source';adIndex=completedAt(source.currentTime);$('adMomentStatus').textContent='Момент выбран вручную.';updateTimeline();renderValidation();};
$('adCurrent').onclick=()=>{if(!loaded||recording)return;timingRevision++;pauseComposition();setAdTime(source.currentTime);adIndex=0;phase='source';$('adMomentStatus').textContent='Баннер появится в текущем моменте.';updateTimeline();renderValidation();};
$('keyStrength').oninput=()=>{$('keyValue').textContent=$('keyStrength').value+'%';cachedAdFrame=-1;++fitVersion;clearTimeout(fitTimer);if(autoFit&&adServerName){adInspection=null;renderValidation();$('adFitStatus').textContent='Пересчитываем размер…';fitTimer=setTimeout(autoFitBanner,400);}else queueBannerInspection();};
$('adScale').oninput=()=>{autoFit=false;++fitVersion;clearTimeout(fitTimer);$('adScaleValue').textContent=$('adScale').value+'%';$('adFitStatus').textContent='Размер настроен вручную. Проверь всю анимацию.';cachedAdFrame=-1;queueBannerInspection();};
$('adAutoFit').onclick=()=>{clearTimeout(fitTimer);autoFitBanner();};
$('adEnabled').onchange=()=>{pauseComposition();phase='source';adIndex=completedAt(source.currentTime);updateTimeline();updateAudioStatus();renderValidation();};
$('adFile').onchange=async e=>{const file=e.target.files[0];if(!file||recording)return;const version=++adVersion;++inspectionVersion;++fitVersion;clearTimeout(inspectionTimer);clearTimeout(fitTimer);autoFit=true;adAspect=1;adOffsetX=0;adOffsetY=0;$('adScale').value=100;$('adScaleValue').textContent='100%';$('adAutoFit').disabled=true;$('adFitStatus').textContent='Подготавливаем автоматический подбор…';pauseComposition();phase='source';adIndex=0;adReady=false;adServerName=null;adAudio={state:'pending'};adInspection=null;cachedAdFrame=-1;$('adEnabled').disabled=true;adVideo.pause();if(adURL)URL.revokeObjectURL(adURL);adURL=URL.createObjectURL(file);adVideo.src=adURL;adVideo.load();$('adStatus').textContent=`Загружаем баннер: ${file.name}`;e.target.value='';renderValidation();try{const result=await upload(file);if(version!==adVersion)return;adServerName=decodeURIComponent(new URL(result.url,location.href).pathname.split('/').pop());$('adAutoFit').disabled=false;inspectAudio(adServerName,'ad',version);if(autoFit)autoFitBanner();else queueBannerInspection();}catch(err){if(version===adVersion){adAudio={state:'error'};adInspection={state:'error'};$('adFitStatus').textContent='Не удалось проверить файл. Проверь размер вручную.';updateAudioStatus();renderValidation();}}};
adVideo.onloadedmetadata=()=>{adReady=Number.isFinite(adVideo.duration)&&adVideo.duration>0;adVideo.playbackRate=1;$('adEnabled').disabled=!adReady;$('adEnabled').checked=adReady;$('adStatus').textContent=adReady?`Баннер готов · ${fmt(adVideo.duration)}. Зелёный фон удаляется автоматически.`:'Не удалось определить длительность баннера.';adIndex=loaded?completedAt(source.currentTime):0;updateTimeline();updateAudioStatus();renderValidation();};
adVideo.onerror=()=>{adReady=false;$('adEnabled').disabled=true;$('adStatus').textContent='Не удалось открыть баннер. Попробуй видео MP4 или WebM.';updateTimeline();renderValidation();};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('previewPhone').requestFullscreen();}catch(e){message('Полноэкранный режим недоступен в этом браузере.');}};
canvas.onclick=()=>{if(document.fullscreenElement===$('previewPhone')&&loaded&&!recording)$('play').click();};
function updateValues(){$('zoomValue').textContent=Number($('zoom').value).toFixed(1)+'×';$('xValue').textContent=$('x').value+'%';$('yValue').textContent=$('y').value+'%';}
['zoom','x','y'].forEach(id=>$(id).oninput=updateValues);
function subtitleList(){
  const list=$('subtitleList');list.replaceChildren();
  subtitles.forEach((caption,index)=>{
    const row=document.createElement('div');row.className='subtitle-row';
    const time=document.createElement('button');time.type='button';time.className='subtitle-time';time.textContent=fmt(caption.start);time.setAttribute('aria-label',`Перейти к ${fmt(caption.start)}`);time.onclick=()=>{if(!recording)seekComposition(caption.start+completedAt(caption.start)*(hasAd()?adVideo.duration:0));};
    const input=document.createElement('textarea');input.className='subtitle-text';input.rows=1;input.value=caption.text;input.setAttribute('aria-label',`Текст субтитра ${index+1}`);input.oninput=()=>{caption.text=input.value;};
    row.append(time,input);list.append(row);
  });
  $('subtitleDetails').hidden=subtitles.length===0;
}
async function startSubtitles(){
  if(!loaded||recording)return;
  const version=++subtitleVersion, mediaVersion=sourceVersion;
  subtitles=[];subtitleState='queued';subtitleList();$('subtitleRetry').disabled=true;$('subtitleStatus').textContent='Подготавливаем субтитры…';
  try{
    const result=await fetch('/api/subtitles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:decodeURIComponent(new URL(source.src).pathname.split('/').pop()),language:$('subtitleLanguage').value})});
    const data=await result.json();if(!result.ok)throw new Error(data.error||'Не удалось запустить распознавание.');
    while(version===subtitleVersion&&mediaVersion===sourceVersion){
      const response=await fetch(`/api/subtitles/${encodeURIComponent(data.job_id)}`);const job=await response.json();if(!response.ok)throw new Error(job.error||'Не удалось получить субтитры.');
      if(version!==subtitleVersion||mediaVersion!==sourceVersion)return;
      subtitleState=job.state;$('subtitleStatus').textContent=job.message+(job.state==='transcribing'&&job.progress>0?` ${job.progress}%`:'');
      if(job.state==='done'){subtitles=job.segments||[];subtitleList();break;}
      if(job.state==='error'||job.state==='empty')break;
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
  }catch(e){if(version===subtitleVersion&&mediaVersion===sourceVersion){subtitleState='error';$('subtitleStatus').textContent=e.message||'Не удалось распознать речь.';}}
  finally{if(version===subtitleVersion&&mediaVersion===sourceVersion&&!recording)$('subtitleRetry').disabled=false;}
}
$('subtitleRetry').onclick=()=>startSubtitles();
$('subtitleLanguage').onchange=()=>{if(loaded&&!recording)startSubtitles();};
$('detect').onclick=async()=>{
  if(!loaded||recording)return;
  const version=sourceVersion, revision=cropRevision; $('detect').disabled=true;$('detectStatus').textContent='Ищем лицо и границы камеры…';
  try{
    const response=await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:decodeURIComponent(new URL(source.src).pathname.split('/').pop()),time:source.currentTime})});
    const region=await response.json();if(!response.ok)throw new Error(region.error);if(version!==sourceVersion||revision!==cropRevision)return;
    setCrop(region);
    $('detectStatus').textContent=region.confidence==='border'?'Границы камеры найдены. Проверьте рамку ниже.':'Найдено лицо, границы определены приблизительно. Проверьте рамку ниже.';
  }catch(e){if(version===sourceVersion){$('detectStatus').textContent=e.message||'Не удалось найти камеру. Выделите область вручную.';$('cropDetails').open=true;}}
  finally{if(version===sourceVersion&&!recording)$('detect').disabled=false;}
};
function cover(video,dx,dy,dw,dh,region,zoom=1,px=.5,py=.5){
  if(video.readyState<2||!video.videoWidth)return;
  const r=region||{x:0,y:0,width:video.videoWidth,height:video.videoHeight};
  const ratio=dw/dh;let sw=r.width,sh=sw/ratio;if(sh>r.height){sh=r.height;sw=sh*ratio;}sw/=zoom;sh/=zoom;
  ctx.drawImage(video,r.x+(r.width-sw)*px,r.y+(r.height-sh)*py,sw,sh,dx,dy,dw,dh);
}
function drawBackground(){
  ctx.save();ctx.translate(0,640);ctx.beginPath();ctx.rect(0,0,720,640);ctx.clip();
  ctx.fillStyle='#10120f';ctx.fillRect(0,0,720,640);
  if(background.readyState>=2)cover(background,0,0,720,640);
  ctx.restore();
}
function drawOriginal(){
  if(source.readyState<2||!source.videoWidth||!source.videoHeight)return;
  const scale=Math.min(720/source.videoWidth,1280/source.videoHeight),width=source.videoWidth*scale,height=source.videoHeight*scale;
  ctx.save();ctx.filter='saturate(1.08) contrast(1.04) hue-rotate(4deg) brightness(1.01)';
  ctx.drawImage(source,0,0,source.videoWidth,source.videoHeight,(720-width)/2,(1280-height)/2,width,height);ctx.restore();
}
function drawAd(){
  if(phase!=='ad'||!hasAd()||adVideo.readyState<2)return;
  const w=keyCanvas.width,h=keyCanvas.height;
  const frame=Math.floor(adVideo.currentTime*30),strength=Number($('keyStrength').value);
  if(frame!==cachedAdFrame||strength!==cachedKeyStrength){
    keyCtx.clearRect(0,0,w,h);
    const base=Math.min(w/adVideo.videoWidth,h/adVideo.videoHeight);
    const dw=adVideo.videoWidth*base*Number($('adScale').value)/100,dh=adVideo.videoHeight*base*adScaleY()/100;
    keyCtx.drawImage(adVideo,(w-dw)/2+adOffsetX*w/100,(h-dh)/2+adOffsetY*h/100,dw,dh);
    const pixels=keyCtx.getImageData(0,0,w,h);
    composition.keyGreen(pixels.data,strength);
    keyCtx.putImageData(pixels,0,0);cachedAdFrame=frame;cachedKeyStrength=strength;
  }
  ctx.drawImage(keyCanvas,0,0,720,1280);
}
function drawCropEditor(){
  if(!$('cropDetails').open||!loaded||source.readyState<2)return;
  const maxWidth=720,maxHeight=720,scale=Math.min(maxWidth/source.videoWidth,maxHeight/source.videoHeight,1);
  const w=Math.max(1,Math.round(source.videoWidth*scale)),h=Math.max(1,Math.round(source.videoHeight*scale));
  if(cropCanvas.width!==w||cropCanvas.height!==h){cropCanvas.width=w;cropCanvas.height=h;}
  cropCtx.drawImage(source,0,0,w,h); if(!crop)return;
  const sx=crop.x*w/source.videoWidth,sy=crop.y*h/source.videoHeight,sw=crop.width*w/source.videoWidth,sh=crop.height*h/source.videoHeight;
  cropCtx.fillStyle='#0009';cropCtx.fillRect(0,0,w,sy);cropCtx.fillRect(0,sy,sx,sh);cropCtx.fillRect(sx+sw,sy,w-sx-sw,sh);cropCtx.fillRect(0,sy+sh,w,h-sy-sh);
  cropCtx.strokeStyle='#d4fa64';cropCtx.lineWidth=3;cropCtx.strokeRect(sx+1,sy+1,Math.max(0,sw-2),Math.max(0,sh-2));
}
function pointerPosition(e){const r=cropCanvas.getBoundingClientRect();return{x:Math.max(0,Math.min(source.videoWidth,(e.clientX-r.left)/r.width*source.videoWidth)),y:Math.max(0,Math.min(source.videoHeight,(e.clientY-r.top)/r.height*source.videoHeight))};}
cropCanvas.onpointerdown=e=>{if(!loaded||recording)return;dragStart=pointerPosition(e);cropCanvas.setPointerCapture(e.pointerId);};
cropCanvas.onpointermove=e=>{if(!dragStart)return;const p=pointerPosition(e);const w=Math.abs(p.x-dragStart.x),h=Math.abs(p.y-dragStart.y);if(w>4&&h>4)setCrop({x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),width:w,height:h});};
cropCanvas.onpointerup=e=>{if(!dragStart)return;const p=pointerPosition(e);if(Math.abs(p.x-dragStart.x)>8&&Math.abs(p.y-dragStart.y)>8){setCrop({x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),width:Math.abs(p.x-dragStart.x),height:Math.abs(p.y-dragStart.y)});$('detectStatus').textContent='Границы камеры выбраны вручную.';}dragStart=null;};
cropCanvas.onpointercancel=()=>{dragStart=null;};
$('resetCrop').onclick=()=>{if(loaded&&!recording){setCrop(fullCrop());$('detectStatus').textContent='Выбран весь исходный кадр. Выделите только камеру на изображении.';}};
function drawSubtitles(t){
  if(!$('subtitleEnabled').checked||(customURL&&!crop))return;
  const caption=subtitles.find(item=>t>=item.start&&t<item.end);if(!caption||!caption.text.trim())return;
  ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
  let font=64,lines=[];const words=caption.text.trim().split(/\s+/);
  do{ctx.font=`900 ${font}px Arial, sans-serif`;lines=[];let line='';for(const word of words){const test=line?`${line} ${word}`:word;if(line&&ctx.measureText(test).width>660){lines.push(line);line=word;}else line=test;}if(line)lines.push(line);if(lines.length<=2&&lines.every(text=>ctx.measureText(text).width<=660))break;font-=4;}while(font>24);
  ctx.font=`900 ${font}px Arial, sans-serif`;ctx.lineWidth=Math.max(5,font*.2);ctx.strokeStyle='#080808';ctx.fillStyle='#fff05c';
  const lineHeight=font*1.18,startY=640-(lines.length-1)*lineHeight/2;
  lines.forEach((line,i)=>{ctx.strokeText(line,360,startY+i*lineHeight,660);ctx.fillText(line,360,startY+i*lineHeight,660);});ctx.restore();
}
function render(){ctx.fillStyle='#131512';ctx.fillRect(0,0,720,1280);if(loaded){if(customURL){if(crop)cover(source,0,0,720,640,crop,Number($('zoom').value),Number($('x').value)/100,Number($('y').value)/100);drawBackground();}else drawOriginal();drawSubtitles(source.currentTime);drawAd();}drawCropEditor();if(loaded&&playing&&!transitioning&&phase==='source'&&hasAd()&&adIndex<schedule().length&&source.currentTime>=schedule()[adIndex])beginAd();requestAnimationFrame(render);}requestAnimationFrame(render);
function syncBackground(force=false){
  if(background.readyState<1||!Number.isFinite(background.duration)||background.duration<=0)return;
  const target=(source.currentTime||0)%background.duration;
  if(force||Math.abs(background.currentTime-target)>.3)try{background.currentTime=target;}catch(e){}
}
function totalDuration(){return Math.max(0,source.duration||0)+schedule().length*(hasAd()?adVideo.duration:0);}
function currentTime(){return phase==='ad'&&hasAd()?activeAdAt+adIndex*adVideo.duration+adVideo.currentTime:(source.currentTime||0)+(hasAd()?adIndex*adVideo.duration:0);}
function updateTimeline(){const total=totalDuration(),now=Math.min(total,currentTime());$('time').textContent=fmt(now);$('duration').textContent=fmt(total);$('seek').value=total?now/total*1000:0;}
function pauseComposition(){playing=false;seekRevision++;source.pause();background.pause();adVideo.pause();transitioning=false;$('play').textContent='▶';}
async function setupAudio(){
  if(!audioContext){
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)return null;
    audioContext=new Audio();audioMix=audioContext.createMediaStreamDestination();
    const limiter=audioContext.createDynamicsCompressor();limiter.threshold.value=-6;limiter.knee.value=0;limiter.ratio.value=12;limiter.attack.value=.003;limiter.release.value=.25;limiter.connect(audioContext.destination);limiter.connect(audioMix);
    sourceGain=audioContext.createGain();adGain=audioContext.createGain();sourceGain.connect(limiter);adGain.connect(limiter);
    audioContext.createMediaElementSource(source).connect(sourceGain);audioContext.createMediaElementSource(adVideo).connect(adGain);updateAudioStatus();
  }
  if(audioContext.state==='suspended')await audioContext.resume();
  return audioMix;
}
async function playComposition(){
  if(!loaded)return;
  try{
    await setupAudio();playing=true;$('play').textContent='❚❚';
    if(phase==='ad')await adVideo.play();
    else{if(source.ended){await seekTo(source,0);adIndex=0;}syncBackground(true);await source.play();}
  }catch(e){pauseComposition();message('Не удалось воспроизвести видео: '+e.message);throw e;}
}
function seekTo(video,time){return new Promise((resolve,reject)=>{if(Math.abs(video.currentTime-time)<.01&&!video.seeking)return resolve();let timer;const clean=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',fail);};const done=()=>{clean();resolve();};const fail=()=>{clean();reject(new Error('Не удалось перемотать видео.'));};video.addEventListener('seeked',done,{once:true});video.addEventListener('error',fail,{once:true});timer=setTimeout(fail,10000);video.currentTime=time;});}
async function seekComposition(t){
  if(!loaded||recording)return;
  const wasPlaying=playing,revision=++seekRevision;transitioning=true;source.pause();background.pause();adVideo.pause();
  const target=composition.mapRepeated(t,source.duration,adVideo.duration||0,adAt,hasAd());phase=target.phase;adIndex=target.completed;activeAdAt=target.adAt??0;
  try{await seekTo(source,target.sourceTime);if(hasAd())await seekTo(adVideo,Math.min(target.adTime,Math.max(0,adVideo.duration-.01)));if(revision!==seekRevision)return;syncBackground(true);transitioning=false;updateTimeline();if(wasPlaying){if(phase==='ad')await adVideo.play();else await source.play();}}
  catch(e){if(revision===seekRevision){pauseComposition();message(e.message);}}
}
async function beginAd(){
  if(transitioning||!playing||!hasAd()||adIndex>=schedule().length)return;
  activeAdAt=schedule()[adIndex];
  const revision=++seekRevision;transitioning=true;source.pause();background.pause();
  try{await seekTo(source,activeAdAt);await seekTo(adVideo,0);if(revision!==seekRevision)return;phase='ad';transitioning=false;updateTimeline();if(playing)await adVideo.play();}
  catch(e){if(revision===seekRevision){exportFailed=recording;pauseComposition();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();message('Не удалось воспроизвести баннер: '+e.message);}}
}
adVideo.onended=async()=>{
  if(phase!=='ad'||!playing)return;const revision=++seekRevision;transitioning=true;phase='source';adIndex++;
  try{await seekTo(source,activeAdAt);if(revision!==seekRevision)return;transitioning=false;updateTimeline();if(playing)await source.play();}
  catch(e){if(revision===seekRevision){exportFailed=recording;pauseComposition();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();message('Не удалось продолжить ролик: '+e.message);}}
};
$('play').onclick=async()=>{if(!loaded||recording)return;if(playing)pauseComposition();else try{await playComposition();}catch(e){}};
source.onplay=()=>{if(playing&&phase==='source'){syncBackground(true);if(background.src)background.play().catch(()=>{});}};
source.onpause=()=>{background.pause();syncBackground(true);};
source.onended=()=>{if(phase!=='source')return;if(playing&&hasAd()&&adIndex<schedule().length){beginAd();return;}playing=false;$('play').textContent='▶';background.pause();updateTimeline();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();};
source.onseeking=()=>syncBackground(true);
source.ontimeupdate=()=>{updateTimeline();if(playing&&phase==='source'){syncBackground();if(hasAd()&&adIndex<schedule().length&&source.currentTime>=schedule()[adIndex])beginAd();}};
adVideo.ontimeupdate=()=>updateTimeline();
adVideo.onseeked=()=>{cachedAdFrame=-1;};
$('seek').oninput=()=>{if(loaded&&!recording)seekComposition(totalDuration()*Number($('seek').value)/1000);};
function finishExport(){recording=false;activeRecorder=null;setEditingDisabled(false);$('export').disabled=false;$('play').disabled=false;$('cancelExport').hidden=true;$('export').innerHTML='<span>↓</span> Экспортировать видео <b>↗</b>';}
$('cancelExport').onclick=()=>{exportCancelled=true;pauseComposition();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();};
$('export').onclick=async()=>{
  if(!loaded||recording)return;if(customURL&&!crop)return message('Сначала выделите область камеры в исходном кадре.');if(customURL&&background.readyState<2)return message('Дождитесь загрузки фонового видео или уберите фон.');if($('subtitleEnabled').checked&&['queued','loading','transcribing'].includes(subtitleState))return message('Дождитесь готовности субтитров или отключите их перед экспортом.');if(sourceAudio.state==='pending'||(hasAd()&&adAudio.state==='pending'))return message('Дождитесь проверки и выравнивания громкости.');if(hasAd()&&!adInspection)return message('Дождитесь автоматического подбора и проверки размера баннера.');if(!window.MediaRecorder||!canvas.captureStream)return message('Этот браузер не поддерживает экспорт. Откройте приложение в Chrome или Edge.');
  const formats=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].filter(x=>MediaRecorder.isTypeSupported(x));if(!formats.length)return message('Этот браузер не поддерживает запись MP4 или WebM.');
  recording=true;exportCancelled=false;exportFailed=false;setEditingDisabled(true);$('export').disabled=true;$('play').disabled=true;$('cancelExport').hidden=false;$('export').textContent='Записываем видео…';message('Идёт запись в реальном времени. Держите вкладку открытой.');
  let stream;
  try{
    pauseComposition();phase='source';adIndex=0;const mix=await setupAudio();if(hasAd()&&!mix)throw new Error('Браузер не поддерживает объединение звука баннера и ролика.');await seekTo(source,0);if(exportCancelled){finishExport();message('Запись отменена.');return;}if(customURL)await seekTo(background,0);if(hasAd())await seekTo(adVideo,0);if(exportCancelled){finishExport();message('Запись отменена.');return;}
    stream=canvas.captureStream(30);if(mix){const audioTrack=mix.stream.getAudioTracks()[0];if(audioTrack)stream.addTrack(audioTrack.clone());}else{const sourceStream=source.captureStream?source.captureStream():null;if(sourceStream)sourceStream.getAudioTracks().forEach(track=>stream.addTrack(track));}
    const chunks=[];let recorder,mime;
    for(const format of formats){try{recorder=new MediaRecorder(stream,{mimeType:format,videoBitsPerSecond:canvas.width>=1080?16000000:8000000,audioBitsPerSecond:192000});mime=format;break;}catch(e){}}
    if(!recorder)throw new Error('Браузер не смог запустить запись видео.');activeRecorder=recorder;
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onerror=()=>{exportFailed=true;if(recorder.state!=='inactive')recorder.stop();};
    recorder.onstop=()=>{if(exportCancelled)message('Запись отменена.');else if(exportFailed||!chunks.length)message('Не удалось записать видео. Попробуйте ещё раз.');else{const actual=recorder.mimeType||mime,blob=new Blob(chunks,{type:actual});if(lastExportURL)URL.revokeObjectURL(lastExportURL);lastExportURL=URL.createObjectURL(blob);const a=document.createElement('a');a.href=lastExportURL;a.download=actual.startsWith('video/mp4')?'splitclip.mp4':'splitclip.webm';a.textContent='Скачать видео';message('Готово! Если загрузка не началась, нажмите: ');$('message').append(a);a.click();}stream.getTracks().forEach(t=>t.stop());finishExport();};
    recorder.start();await playComposition();
  }catch(e){exportFailed=true;if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();else{if(stream)stream.getTracks().forEach(t=>t.stop());finishExport();}message('Не удалось записать видео: '+e.message);}
};
renderValidation();
