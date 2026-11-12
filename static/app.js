const $ = id => document.getElementById(id);
const source = $('source'), background = $('background'), adVideo = $('adVideo'), canvas = $('canvas'), ctx = canvas.getContext('2d');
const composition = window.SplitClipComposition;
const cropCanvas = $('cropCanvas'), cropCtx = cropCanvas.getContext('2d');
const keyCanvas=document.createElement('canvas');const keyCtx=keyCanvas.getContext('2d',{willReadFrequently:true});
let loaded = false, recording = false, customURL = null, adURL = null, crop = null, cropReliable = false, bandDirty = false, dragStart = null, sourceVersion = 0, cropRevision = 0, activeRecorder = null, exportCancelled = false, exportFailed = false;
let phase='source', adIndex=0, activeAdAt=0, playing=false, adAt=0, adReady=false, timingRevision=0, seekRevision=0, transitioning=false;
let automaticAdTiming=true, suggestedAdTime=null;
let audioContext=null, audioMix=null, sourceGain=null, adGain=null, monitorGain=null, monitorMuted=false;
let sourceAudio={state:'pending'}, adAudio={state:'pending'}, adInspection=null, adServerName=null, adVersion=0, inspectionVersion=0, inspectionTimer=null;
let fitVersion=0, fitTimer=null, autoFit=true, adAspect=1, adOffsetX=0, adOffsetY=0;
let cachedAdFrame=-1, cachedKeyStrength=-1;
let gpuChroma=null, gpuChromaTried=false;
let subtitles = [], subtitleState = 'idle', subtitleVersion = 0, selectedSubtitle = null, subtitleUndoStack = [];
let colorProfile={state:'idle',value:null};
let lastExportURL = null, lastExportBlob = null, lastExportName = null, exportJob = null, exportAbort = null;
let exportVisuals=null, exportSourceTime=0, exportAdTime=0, backgroundUploadFile=null;
const blur=window.SplitClipBlur.create({get:$,source:()=>source,loaded:()=>loaded,recording:()=>recording,playing:()=>playing,fmt:n=>fmt(n),pause:()=>pauseComposition(),seek:time=>seekSourceOnSubtitleTrack(time),toggle:()=>$('play').click()});
const captionFontReady=document.fonts&&document.fonts.load?document.fonts.load('900 64px SplitclipCaption').catch(()=>{}):Promise.resolve();
const headlineFontReady=document.fonts&&document.fonts.load?document.fonts.load('64px SplitclipHeadline').catch(()=>{}):Promise.resolve();
const message = text => $('message').textContent = text;
const fmt = n => Number.isFinite(n) ? `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(Math.floor(n % 60)).padStart(2,'0')}` : '00:00';
function setBusy(busy, text) { $('import').disabled = busy; $('import').textContent = busy ? 'Загрузка…' : 'Загрузить ↗'; if (text) $('sourceStatus').textContent = text; }
function setEditingDisabled(disabled) {
  for (const id of ['import','sourceFile','backgroundFile','removeBackground','adFile','detect','zoom','x','y','seek','resetCrop','colorEnabled','headlineText','headlineSize','headlineOffset','subtitleEnabled','subtitleSize','subtitleOffset','subtitleColor','subtitleLanguage','subtitleRetry','adEnabled','adTime','adCurrent','adAutoTime','keyStrength','adScale','adAutoFit','quality']) $(id).disabled = disabled || (['detect','seek','resetCrop','subtitleRetry','adTime','adCurrent','adAutoTime'].includes(id) && !loaded) || (id==='removeBackground'&&!customURL) || (id==='adEnabled'&&!adReady) || (id==='adAutoFit'&&!adServerName) || (id==='subtitleRetry' && ['queued','loading','transcribing'].includes(subtitleState));
  $('colorStrength').disabled=disabled||!$('colorEnabled').checked;
  document.querySelectorAll('.subtitle-text, .subtitle-time, .subtitle-boundary, .subtitle-delete').forEach(el => el.disabled = disabled);
  $('subtitleAdd').disabled=disabled||!loaded; $('subtitleClear').disabled=disabled||!loaded||!subtitles.length; $('subtitleTrackZoom').disabled=disabled||!loaded; $('subtitleTrackToPlayhead').disabled=disabled||!loaded; $('subtitleUndo').disabled=disabled||!loaded||!subtitleUndoStack.length; $('subtitlePlay').disabled=disabled||!loaded; $('subtitleBack').disabled=disabled||!loaded; document.querySelectorAll('.subtitle-clip').forEach(el=>el.disabled=disabled);
  $('subtitleLengthen').disabled=disabled||!loaded||!subtitles.length;
  $('cropDetails').classList.toggle('locked', disabled);
  blur.update();
  updateOriginalControls();
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
  cropReliable=rect.confidence!=='face'&&rect.confidence!=='full';
  cropRevision++;
  resetAdjustment();
  updateOriginalControls();
}
function updateOriginalControls(){
  const unavailable=recording||!loaded||!!customURL,bandUnavailable=recording||!loaded;
  $('originalControls').hidden=false;$('mirrorCameraControl').hidden=!!customURL;$('gameDetails').hidden=!!customURL;
  $('mirrorCamera').disabled=unavailable;$('removeOriginalText').disabled=bandUnavailable;
  $('captionBandControls').hidden=!$('removeOriginalText').checked;
  $('bandTop').disabled=bandUnavailable||!$('removeOriginalText').checked;$('bandBottom').disabled=bandUnavailable||!$('removeOriginalText').checked;
  $('bandTopValue').textContent=(Number($('bandTop').value)/10).toFixed(1)+'%';$('bandBottomValue').textContent=(Number($('bandBottom').value)/10).toFixed(1)+'%';
  const split=gameSplit(),gameUnavailable=unavailable||!split||split.bottom>=source.videoHeight;
  for(const id of ['gameZoom','gameX','gameY','resetGame'])$(id).disabled=gameUnavailable;
  $('gameStatus').textContent=gameUnavailable?'Найди камеру на всю ширину или включи обрезку старых субтитров, чтобы настроить игру.':'Игра заполняет оставшуюся высоту. Увеличь масштаб, чтобы сместить её в кадре.';
}
function setCaptionBand(band,detected=false){
  const h=source.videoHeight;if(!h)return;
  const seam=crop?crop.y+crop.height:h*.4;
  const top=band?band.top:Math.max(0,seam-h*.03),bottom=band?band.bottom:Math.min(h,seam+h*.03);
  $('bandTop').value=Math.max(0,Math.min(999,Math.round(top/h*1000)));
  $('bandBottom').value=Math.max(Number($('bandTop').value)+1,Math.min(1000,Math.round(bottom/h*1000)));
  $('removeOriginalText').checked=!!band;
  $('bandStatus').textContent=detected?'Похоже, старая надпись найдена и вырезана. Проверь границы в разделе «Поправить границы камеры».':'Если старая надпись мешает, включи обрезку и установи её границы.';
  updateOriginalControls();
}
function currentCaptionBand(){
  if(!$('removeOriginalText').checked||!source.videoHeight)return null;
  const top=source.videoHeight*Number($('bandTop').value)/1000,bottom=source.videoHeight*Number($('bandBottom').value)/1000;
  return bottom>top?{top,bottom}:null;
}
function cameraRegionForBackground(){
  if(!crop)return null;
  const band=currentCaptionBand(),bottom=crop.y+crop.height;
  if(!band||band.bottom<=crop.y||band.top>=bottom)return crop;
  // Keep only the camera pixels above a detected strip that crosses its edge.
  if(band.top>crop.y+1)return {...crop,height:band.top-crop.y};
  return crop;
}
function gameSplit(){
  const band=currentCaptionBand();if(band)return band;
  const w=source.videoWidth,h=source.videoHeight;
  if(!crop||!cropReliable||!w||!h||crop.x>w*.01||crop.y>h*.01||crop.width<w*.98)return null;
  const seam=crop.y+crop.height;if(seam<=0||seam>=h)return null;
  return {top:seam,bottom:seam};
}
function updateGameValues(){$('gameZoomValue').textContent=Number($('gameZoom').value).toFixed(1)+'×';$('gameXValue').textContent=$('gameX').value+'%';$('gameYValue').textContent=$('gameY').value+'%';}
function resetGameAdjustments(){$('gameZoom').value=1;$('gameX').value=50;$('gameY').value=50;updateGameValues();}
for(const id of ['gameZoom','gameX','gameY'])$(id).oninput=updateGameValues;
$('resetGame').onclick=()=>{if(!recording)resetGameAdjustments();};
for(const id of ['bandTop','bandBottom'])$(id).oninput=()=>{bandDirty=true;let top=Number($('bandTop').value),bottom=Number($('bandBottom').value);if(top>=bottom){if(id==='bandTop'){top=Math.min(999,top);bottom=top+1;}else{bottom=Math.max(1,bottom);top=bottom-1;}}$('bandTop').value=top;$('bandBottom').value=bottom;updateOriginalControls();};
$('removeOriginalText').onchange=()=>{bandDirty=true;updateOriginalControls();};
function sourceColorFilter(){return $('colorEnabled').checked&&colorProfile.state==='ready'?composition.colorFilter(colorProfile.value,Number($('colorStrength').value)):'none';}
$('colorEnabled').onchange=()=>{$('colorStrength').disabled=recording||!$('colorEnabled').checked;};
$('colorStrength').oninput=()=>{$('colorStrengthValue').textContent=$('colorStrength').value+'%';};
function waitForColorVideo(video){return new Promise((resolve,reject)=>{
  let timer;const clean=()=>{clearTimeout(timer);video.removeEventListener('loadeddata',done);video.removeEventListener('error',fail);};
  const done=()=>{clean();resolve();},fail=()=>{clean();reject(new Error('Не удалось прочитать кадры.'));};
  video.addEventListener('loadeddata',done,{once:true});video.addEventListener('error',fail,{once:true});timer=setTimeout(fail,12000);
  if(video.readyState>=2)done();
});}
async function analyzeSourceColor(version,url){
  colorProfile={state:'analyzing',value:null};$('colorStatus').textContent='Анализируем цвет нескольких кадров…';
  const sample=document.createElement('video');sample.muted=true;sample.playsInline=true;sample.preload='auto';
  try{
    const ready=waitForColorVideo(sample);sample.src=url;sample.load();await ready;
    if(version!==sourceVersion)return;
    const probe=document.createElement('canvas'),pctx=probe.getContext('2d',{willReadFrequently:true});
    if(!pctx||!sample.videoWidth||!sample.videoHeight)throw new Error('Не удалось прочитать кадры.');
    const scale=Math.min(128/sample.videoWidth,128/sample.videoHeight);
    probe.width=Math.max(1,Math.round(sample.videoWidth*scale));probe.height=Math.max(1,Math.round(sample.videoHeight*scale));
    const duration=sample.duration,frames=[];
    const times=Number.isFinite(duration)&&duration>.2?[.08,.24,.40,.56,.72,.88].map(f=>Math.min(duration-.05,duration*f)):[0];
    for(const time of times){
      await seekTo(sample,Math.max(0,time));if(version!==sourceVersion)return;
      pctx.drawImage(sample,0,0,probe.width,probe.height);frames.push(pctx.getImageData(0,0,probe.width,probe.height).data);
    }
    const value=composition.estimateColor(frames);if(!value)throw new Error('Кадры слишком тёмные или пустые.');
    colorProfile={state:'ready',value};$('colorStatus').textContent='Цвет подобран по нескольким кадрам. Сравни результат с оригиналом и при необходимости измени силу.';
  }catch(e){if(version===sourceVersion){colorProfile={state:'error',value:null};$('colorStatus').textContent='Не удалось подобрать цвет автоматически — исходные цвета сохранены.';}}
  finally{sample.pause();sample.removeAttribute('src');sample.load();}
}
function waitForSourceMetadata(url){
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{source.removeEventListener('loadedmetadata',done);source.removeEventListener('error',fail);};
    const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(new Error('Браузер не смог открыть видео.'));};
    source.addEventListener('loadedmetadata',done,{once:true});source.addEventListener('error',fail,{once:true});source.src=url;source.load();
  });
}
async function openSourceWithFallback(result,version){
  try{await waitForSourceMetadata(result.url);return;}
  catch(error){
    if(version!==sourceVersion)return;
    $('sourceStatus').textContent='Подготавливаем видео для браузера… Это может занять несколько минут.';
    const name=decodeURIComponent(new URL(result.url,location.href).pathname.split('/').pop());
    const response=await fetch('/api/prepare-source',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    let data;try{data=await response.json();}catch(_){throw new Error('Не удалось подготовить видео. Перезапусти приложение и попробуй снова.');}
    if(!response.ok)throw new Error(data.error||'Не удалось преобразовать видео.');
    if(version!==sourceVersion)return;
    try{await waitForSourceMetadata(data.url);}catch(_){throw new Error('Даже после преобразования браузер не смог открыть видео. Попробуй Chrome или Edge.');}
  }
}
async function loadSource(result) {
  const version=++sourceVersion;
  pauseComposition(); loaded=false;
  await openSourceWithFallback(result,version);
  if(version!==sourceVersion)return;
  loaded=true; blur.reset(); crop=null; cropReliable=false;bandDirty=false;cropRevision++;resetAdjustment();resetGameAdjustments();setCaptionBand(null);$('empty').style.display='none';$('sourceStatus').textContent=`Готово: ${result.name}`;
  $('detect').disabled=false; $('play').disabled=false; $('subtitlePlay').disabled=false; $('subtitleBack').disabled=false; $('export').disabled=false; $('resetCrop').disabled=false;
  phase='source';adIndex=0;automaticAdTiming=true;suggestedAdTime=null;applyAutomaticAdTime();$('adTime').disabled=false;$('adCurrent').disabled=false;$('adAutoTime').disabled=false;updateTimeline();
  sourceAudio={state:'pending'};inspectAudio(decodeURIComponent(new URL(source.src).pathname.split('/').pop()),'source',version);
  syncBackground(true);message('');subtitles=[];selectedSubtitle=null;subtitleUndoStack=[];subtitleList();analyzeSourceColor(version,source.src);$('detect').click();startSubtitles();suggestAdMoment(version);renderValidation();
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
  background.pause();if(customURL)URL.revokeObjectURL(customURL);backgroundUploadFile=file;customURL=URL.createObjectURL(file);background.src=customURL;background.load();
  $('backgroundStatus').textContent=`Свой фон: ${file.name}`;$('removeBackground').hidden=false;$('removeBackground').disabled=false;
  updateOriginalControls();
  if(loaded&&!crop&&!$('detect').disabled)$('detect').click();
  e.target.value='';
};
$('removeBackground').onclick=()=>{if(recording||!customURL)return;background.pause();URL.revokeObjectURL(customURL);customURL=null;backgroundUploadFile=null;background.removeAttribute('src');background.load();$('removeBackground').hidden=true;$('removeBackground').disabled=true;$('backgroundStatus').textContent='Без фона используется исходное видео.';updateOriginalControls();if(loaded&&!crop&&!$('detect').disabled)$('detect').click();};
background.onloadedmetadata=()=>{if(loaded&&playing&&phase==='source'){const revision=seekRevision;seekBackgroundToSource().then(()=>{if(revision===seekRevision&&playing&&phase==='source')return background.play();}).catch(()=>{});}else syncBackground(true);};
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
function applyAutomaticAdTime(){
  if(!loaded||!automaticAdTiming)return;
  const result=composition.automaticAdPlacement(source.duration,hasAd()?adVideo.duration:5,suggestedAdTime);
  if(!result)return;
  setAdTime(result.time);adIndex=completedAt(source.currentTime);
  $('adMomentStatus').textContent=Number.isFinite(suggestedAdTime)?'Момент выбран по длительности исходного ролика и найденной паузе. Проверь условия ниже и при необходимости измени его.':'Момент предварительно выбран по длительности исходного ролика. Проверь условия ниже.';
  updateTimeline();renderValidation();
}
async function suggestAdMoment(version){
  const revision=++timingRevision;
  try{
    const response=await fetch('/api/ad-moment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:decodeURIComponent(new URL(source.src).pathname.split('/').pop())})});
    const data=await response.json();if(!response.ok)throw new Error(data.error);
    if(version!==sourceVersion||revision!==timingRevision||!automaticAdTiming)return;
    suggestedAdTime=Number.isFinite(data.time)?data.time:null;applyAutomaticAdTime();
  }catch(e){if(version===sourceVersion&&revision===timingRevision&&automaticAdTiming){applyAutomaticAdTime();$('adMomentStatus').textContent='Не удалось найти паузу автоматически. Проверь выбранный момент вручную.';}}
}
$('adAutoTime').onclick=()=>{if(!loaded||recording)return;pauseComposition();phase='source';automaticAdTiming=true;applyAutomaticAdTime();suggestAdMoment(sourceVersion);};
$('adTime').oninput=()=>{if(!loaded||recording)return;automaticAdTiming=false;timingRevision++;pauseComposition();setAdTime(source.duration*Number($('adTime').value)/1000);phase='source';adIndex=completedAt(source.currentTime);$('adMomentStatus').textContent='Момент выбран вручную.';updateTimeline();renderValidation();};
$('adCurrent').onclick=()=>{if(!loaded||recording)return;automaticAdTiming=false;timingRevision++;pauseComposition();setAdTime(source.currentTime);adIndex=0;phase='source';$('adMomentStatus').textContent='Баннер появится в текущем моменте.';updateTimeline();renderValidation();};
$('keyStrength').oninput=()=>{$('keyValue').textContent=$('keyStrength').value+'%';cachedAdFrame=-1;++fitVersion;clearTimeout(fitTimer);if(autoFit&&adServerName){adInspection=null;renderValidation();$('adFitStatus').textContent='Пересчитываем размер…';fitTimer=setTimeout(autoFitBanner,400);}else queueBannerInspection();};
$('adScale').oninput=()=>{autoFit=false;++fitVersion;clearTimeout(fitTimer);$('adScaleValue').textContent=$('adScale').value+'%';$('adFitStatus').textContent='Размер настроен вручную. Проверь всю анимацию.';cachedAdFrame=-1;queueBannerInspection();};
$('adAutoFit').onclick=()=>{clearTimeout(fitTimer);autoFitBanner();};
$('adEnabled').onchange=()=>{pauseComposition();phase='source';if(hasAd())applyAutomaticAdTime();adIndex=completedAt(source.currentTime);updateTimeline();updateAudioStatus();renderValidation();};
$('adFile').onchange=async e=>{const file=e.target.files[0];if(!file||recording)return;const version=++adVersion;++inspectionVersion;++fitVersion;clearTimeout(inspectionTimer);clearTimeout(fitTimer);autoFit=true;adAspect=1;adOffsetX=0;adOffsetY=0;$('adScale').value=100;$('adScaleValue').textContent='100%';$('adAutoFit').disabled=true;$('adFitStatus').textContent='Подготавливаем автоматический подбор…';pauseComposition();phase='source';adIndex=0;adReady=false;adServerName=null;adAudio={state:'pending'};adInspection=null;cachedAdFrame=-1;$('adEnabled').disabled=true;adVideo.pause();if(adURL)URL.revokeObjectURL(adURL);adURL=URL.createObjectURL(file);adVideo.src=adURL;adVideo.load();$('adStatus').textContent=`Загружаем баннер: ${file.name}`;e.target.value='';renderValidation();try{const result=await upload(file);if(version!==adVersion)return;adServerName=decodeURIComponent(new URL(result.url,location.href).pathname.split('/').pop());$('adAutoFit').disabled=false;inspectAudio(adServerName,'ad',version);if(autoFit)autoFitBanner();else queueBannerInspection();}catch(err){if(version===adVersion){adAudio={state:'error'};adInspection={state:'error'};$('adFitStatus').textContent='Не удалось проверить файл. Проверь размер вручную.';updateAudioStatus();renderValidation();}}};
adVideo.onloadedmetadata=()=>{adReady=Number.isFinite(adVideo.duration)&&adVideo.duration>0;adVideo.playbackRate=1;$('adEnabled').disabled=!adReady;$('adEnabled').checked=adReady;$('adStatus').textContent=adReady?`Баннер готов · ${fmt(adVideo.duration)}. Зелёный фон удаляется автоматически.`:'Не удалось определить длительность баннера.';if(adReady)applyAutomaticAdTime();adIndex=loaded?completedAt(source.currentTime):0;updateTimeline();updateAudioStatus();renderValidation();};
adVideo.onerror=()=>{adReady=false;$('adEnabled').disabled=true;$('adStatus').textContent='Не удалось открыть баннер. Попробуй видео MP4 или WebM.';updateTimeline();renderValidation();};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('previewPhone').requestFullscreen();}catch(e){message('Полноэкранный режим недоступен в этом браузере.');}};
canvas.onclick=()=>{if(document.fullscreenElement===$('previewPhone')&&loaded&&!recording)$('play').click();};
function updateValues(){$('zoomValue').textContent=Number($('zoom').value).toFixed(1)+'×';$('xValue').textContent=$('x').value+'%';$('yValue').textContent=$('y').value+'%';}
['zoom','x','y'].forEach(id=>$(id).oninput=updateValues);
function updateHeadlineValues(){$('headlineSizeValue').textContent=$('headlineSize').value;$('headlineOffsetValue').textContent=$('headlineOffset').value;}
['headlineSize','headlineOffset'].forEach(id=>$(id).oninput=updateHeadlineValues);
function stopSubtitleRecognition(){
  if(['queued','loading','transcribing'].includes(subtitleState)){
    ++subtitleVersion;subtitleState='manual';$('subtitleStatus').textContent='Автораспознавание остановлено для текущего редактора. Ручные правки сохранены.';
    $('subtitleRetry').disabled=!loaded||recording;
  }
}
function subtitleSnapshot(){return {items:subtitles.map(item=>({...item})),selected:subtitles.indexOf(selectedSubtitle)};}
function rememberSubtitleEdit(before=subtitleSnapshot()){
  subtitleUndoStack.push(before);if(subtitleUndoStack.length>100)subtitleUndoStack.shift();
  $('subtitleUndo').disabled=recording||!loaded;
}
function undoSubtitleEdit(){
  if(!loaded||recording||!subtitleUndoStack.length)return;
  stopSubtitleRecognition();const previous=subtitleUndoStack.pop();subtitles=previous.items.map(item=>({...item}));selectedSubtitle=subtitles[previous.selected]||null;subtitleList();
}
$('subtitleUndo').onclick=undoSubtitleEdit;
function subtitleEditorStatus(){
  const ordered=[...subtitles].sort((a,b)=>a.start-b.start);let lastEnd=-1,overlaps=0,shortWords=0;
  for(const caption of ordered){if(caption.start<lastEnd-.001)overlaps++;lastEnd=Math.max(lastEnd,caption.end);const letters=String(caption.text||'').replace(/[^\p{L}\p{N}]/gu,'');if(letters.length>0&&letters.length<=2&&caption.end-caption.start<.27)shortWords++;}
  $('subtitleCount').textContent=`${subtitles.length} ${subtitles.length%10===1&&subtitles.length%100!==11?'слово':subtitles.length%10>=2&&subtitles.length%10<=4&&!(subtitles.length%100>=12&&subtitles.length%100<=14)?'слова':'слов'}`;
  $('subtitleAdd').disabled=recording||!loaded; $('subtitleClear').disabled=recording||!loaded||!subtitles.length; $('subtitleLengthen').disabled=recording||!loaded||!subtitles.length; $('subtitleUndo').disabled=recording||!loaded||!subtitleUndoStack.length;
  $('subtitleEditStatus').textContent=!loaded?'Загрузи видео, чтобы редактировать субтитры.':overlaps?'Некоторые слова пересекаются по времени. Поправь начало или конец, чтобы каждое было видно.':shortWords?'Некоторые короткие слова всё ещё быстро сменяются. Нажми «Удлинить короткие слова»; при очень быстрой речи настрой время вручную.':subtitles.length?'Изменения сразу видны в предпросмотре и попадут в экспорт.':'Добавь слово вручную или запусти распознавание.';
}
function updateSubtitleAppearance(){ $('subtitleSizeValue').textContent=$('subtitleSize').value; $('subtitleOffsetValue').textContent=$('subtitleOffset').value; }
for(const id of ['subtitleSize','subtitleOffset'])$(id).oninput=updateSubtitleAppearance;
function subtitleTrackScale(){
  return Number($('subtitleTrackZoom').value)||100;
}
function updateSubtitlePlayhead(){
  const seconds=loaded&&Number.isFinite(source.currentTime)?source.currentTime:0;
  $('subtitlePlayhead').style.left=`${seconds*subtitleTrackScale()}px`; $('subtitlePlayhead').setAttribute('aria-valuenow',String(Math.round(seconds*100)/100));$('subtitlePlayhead').setAttribute('aria-valuemax',String(loaded?source.duration||0:0));$('subtitleListenTime').textContent=fmt(seconds);
}
function scrollSubtitleIntoView(caption){
  if(!caption)return;const viewport=$('subtitleTrackViewport'),position=caption.start*subtitleTrackScale();
  if(position<viewport.scrollLeft||position>viewport.scrollLeft+viewport.clientWidth-50)viewport.scrollLeft=Math.max(0,position-viewport.clientWidth*.3);
}
function updateSubtitleClipText(caption){
  const index=subtitles.indexOf(caption),clip=$('subtitleTrackLane').children[index];
  if(clip){clip.querySelector('.subtitle-clip-label').textContent=caption.text.trim()||'Новое слово';clip.setAttribute('aria-label',`Субтитр: ${caption.text.trim()||'новое слово'}, ${caption.start.toFixed(2)}–${caption.end.toFixed(2)} сек.`);}
}
function updateSubtitleClipSelection(){
  Array.from($('subtitleTrackLane').children).forEach((clip,index)=>{clip.classList.toggle('selected',subtitles[index]===selectedSubtitle);clip.setAttribute('aria-pressed',String(subtitles[index]===selectedSubtitle));});
}
function seekSourceOnSubtitleTrack(time){
  if(!loaded||recording)return;const at=Math.max(0,Math.min(source.duration,time));
  return seekComposition(at+completedAt(at)*(hasAd()?adVideo.duration:0));
}
function renderSubtitleTrack(){
  const duration=loaded&&Number.isFinite(source.duration)?source.duration:0,scale=subtitleTrackScale(),width=Math.max(1,duration*scale);
  const content=$('subtitleTrackContent'),ruler=$('subtitleTrackRuler'),lane=$('subtitleTrackLane');
  content.style.width=duration?`${width}px`:'100%';ruler.style.width=duration?`${width}px`:'100%';lane.style.width=duration?`${width}px`:'100%';$('subtitleVideoTrack').style.width=duration?`${width}px`:'100%';ruler.replaceChildren();lane.replaceChildren();
  if(!duration){updateSubtitlePlayhead();return;}
  const minStep=Math.max(1,Math.ceil(85/scale),Math.ceil(duration/300));const step=[1,2,5,10,15,30,60,120,300,600].find(n=>n>=minStep)||Math.ceil(minStep/600)*600;
  for(let t=0;t<=duration;t+=step){const tick=document.createElement('span');tick.className='subtitle-tick';tick.style.left=`${t*scale}px`;tick.textContent=fmt(t);ruler.append(tick);}
  subtitles.forEach((caption,index)=>{
    const clip=document.createElement('button');clip.type='button';clip.className='subtitle-clip';clip.disabled=recording;
    clip.style.left=`${caption.start*scale}px`;clip.style.width=`${Math.max(4,(caption.end-caption.start)*scale)}px`;
    clip.setAttribute('aria-label',`Субтитр: ${caption.text.trim()||'новое слово'}, ${caption.start.toFixed(2)}–${caption.end.toFixed(2)} сек.`);
    clip.setAttribute('aria-pressed',String(caption===selectedSubtitle));clip.classList.toggle('selected',caption===selectedSubtitle);
    const start=document.createElement('span');start.className='subtitle-clip-handle start';start.dataset.mode='start';
    const label=document.createElement('span');label.className='subtitle-clip-label';label.textContent=caption.text.trim()||'Новое слово';
    const end=document.createElement('span');end.className='subtitle-clip-handle end';end.dataset.mode='end';clip.append(start,label,end);
    clip.onclick=e=>{if(e.detail===0&&!recording){selectedSubtitle=caption;subtitleList(false);seekSourceOnSubtitleTrack(caption.start);}};
    clip.onpointerdown=e=>{
      if(recording||e.button!==0)return;e.preventDefault();e.stopPropagation();selectedSubtitle=caption;subtitleList(false);
      const mode=e.target.dataset.mode||'move',initialX=e.clientX,originalStart=caption.start,originalEnd=caption.end,pointer=e.pointerId;let moved=false,pending={start:originalStart,end:originalEnd};
      try{clip.setPointerCapture(pointer);}catch(_){}
      clip.onpointermove=event=>{if(event.pointerId!==pointer)return;const dx=event.clientX-initialX;if(!moved&&Math.abs(dx)<3)return;
        if(!moved){moved=true;stopSubtitleRecognition();pauseComposition();}
        pending=composition.moveSubtitle(originalStart,originalEnd,dx/scale,duration,mode);clip.style.left=`${pending.start*scale}px`;clip.style.width=`${Math.max(4,(pending.end-pending.start)*scale)}px`;
      };
      const finish=event=>{if(event.pointerId!==pointer)return;const cancelled=event.type==='pointercancel';clip.onpointermove=null;clip.onpointerup=null;clip.onpointercancel=null;
        if(!subtitles.includes(caption)||recording)return;
        if(moved&&!cancelled){if(Math.abs(caption.start-pending.start)>.0001||Math.abs(caption.end-pending.end)>.0001)rememberSubtitleEdit();caption.start=pending.start;caption.end=pending.end;subtitleList();}else if(moved){subtitleList();}else seekSourceOnSubtitleTrack(caption.start);
      };
      clip.onpointerup=finish;clip.onpointercancel=finish;
    };
    lane.append(clip);
  });
  $('subtitleTrackZoom').disabled=recording||!loaded;$('subtitleTrackToPlayhead').disabled=recording||!loaded;subtitleTrackPreviousScale=scale;updateSubtitlePlayhead();
}
$('subtitleTrackZoom').oninput=()=>{
  if(!loaded||recording)return;const viewport=$('subtitleTrackViewport'),oldScale=subtitleTrackPreviousScale||subtitleTrackScale(),center=(viewport.scrollLeft+viewport.clientWidth/2)/oldScale;
  renderSubtitleTrack();viewport.scrollLeft=Math.max(0,center*subtitleTrackScale()-viewport.clientWidth/2);subtitleTrackPreviousScale=subtitleTrackScale();
};
let subtitleTrackPreviousScale=0;
$('subtitleTrackToPlayhead').onclick=()=>{if(!loaded||recording)return;const viewport=$('subtitleTrackViewport');viewport.scrollLeft=Math.max(0,source.currentTime*subtitleTrackScale()-viewport.clientWidth/2);};
for(const id of ['subtitleTrackRuler','subtitleVideoTrack','subtitleTrackLane'])$(id).onclick=e=>{
  if(!loaded||recording||e.target!==$(id))return;const rect=$('subtitleTrackContent').getBoundingClientRect();seekSourceOnSubtitleTrack((e.clientX-rect.left)/subtitleTrackScale());
};
// Coalesce rapid pointer updates so the latest requested frame is always reached.
let pendingSubtitleSeek=null,subtitleSeekRunning=false;
async function queueSubtitleSeek(time){
  pendingSubtitleSeek={time,version:sourceVersion};if(subtitleSeekRunning)return;
  subtitleSeekRunning=true;
  try{while(pendingSubtitleSeek){const next=pendingSubtitleSeek;pendingSubtitleSeek=null;if(next.version===sourceVersion&&loaded&&!recording)await seekSourceOnSubtitleTrack(next.time);}}
  finally{subtitleSeekRunning=false;}
}
const subtitlePlayhead=$('subtitlePlayhead');
subtitlePlayhead.onpointerdown=e=>{
  if(!loaded||recording||e.button!==0)return;e.preventDefault();e.stopPropagation();pauseComposition();
  const pointer=e.pointerId,original=source.currentTime,at=event=>Math.max(0,Math.min(source.duration,(event.clientX-$('subtitleTrackContent').getBoundingClientRect().left)/subtitleTrackScale()));
  try{subtitlePlayhead.setPointerCapture(pointer);}catch(_){}
  const move=event=>{if(event.pointerId!==pointer)return;const time=at(event);subtitlePlayhead.style.left=`${time*subtitleTrackScale()}px`;queueSubtitleSeek(time);};
  subtitlePlayhead.onpointermove=move;
  const finish=event=>{if(event.pointerId!==pointer)return;subtitlePlayhead.onpointermove=null;subtitlePlayhead.onpointerup=null;subtitlePlayhead.onpointercancel=null;queueSubtitleSeek(event.type==='pointercancel'?original:at(event));};
  subtitlePlayhead.onpointerup=finish;subtitlePlayhead.onpointercancel=finish;
};
$('subtitleTrackViewport').addEventListener('wheel',e=>{
  if(!loaded||recording||!(e.ctrlKey||e.metaKey)||!e.deltaY)return;
  e.preventDefault();const viewport=$('subtitleTrackViewport'),rect=viewport.getBoundingClientRect(),x=Math.max(0,Math.min(viewport.clientWidth,e.clientX-rect.left));
  const oldScale=subtitleTrackScale(),anchor=(viewport.scrollLeft+x)/oldScale;
  const next=Math.max(40,Math.min(240,oldScale+(e.deltaY<0?10:-10)));if(next===oldScale)return;
  $('subtitleTrackZoom').value=String(next);renderSubtitleTrack();viewport.scrollLeft=Math.max(0,anchor*next-x);
},{passive:false});
document.addEventListener('keydown',e=>{
  if(!loaded||recording||e.isComposing||e.defaultPrevented)return;
  const target=e.target,tag=(target&&target.tagName||'').toLowerCase(),editable=!!(target&&target.isContentEditable)||['input','textarea','select'].includes(tag);
  if(editable)return;
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='z'){
    if(subtitleUndoStack.length){e.preventDefault();undoSubtitleEdit();}return;
  }
  if(target&&target.id==='subtitlePlayhead'&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){
    e.preventDefault();pauseComposition();queueSubtitleSeek(source.currentTime+(e.key==='ArrowRight'?.1:-.1));return;
  }
  if((e.code==='Space'||e.key===' ')&&!e.repeat&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey){
    if(tag==='button'&&!(target.classList&&target.classList.contains('subtitle-clip')))return;
    e.preventDefault();$('play').onclick();
  }
});
function subtitleList(renderTrack=true){
  const list=$('subtitleList');list.replaceChildren();
  subtitles.sort((a,b)=>a.start-b.start);
  if(selectedSubtitle&&!subtitles.includes(selectedSubtitle))selectedSubtitle=null;
  const selectedIndex=subtitles.indexOf(selectedSubtitle);
  $('subtitleSelection').textContent=selectedIndex<0?'Выбери слово на дорожке для точной правки.':`Выбрано слово ${selectedIndex+1} из ${subtitles.length}`;
  subtitles.forEach((caption,index)=>{
    if(caption!==selectedSubtitle)return;
    const row=document.createElement('div');row.className='subtitle-row';
    const time=document.createElement('button');time.type='button';time.className='subtitle-time';time.textContent='▶';time.title='Перейти к слову';time.disabled=recording;time.setAttribute('aria-label',`Перейти к слову ${index+1}`);time.onclick=()=>{if(!recording)seekComposition(caption.start+completedAt(caption.start)*(hasAd()?adVideo.duration:0));};
    let textEditBefore=null;const input=document.createElement('input');input.type='text';input.className='subtitle-text';input.value=caption.text;input.placeholder='Слово';input.disabled=recording;input.setAttribute('aria-label',`Текст субтитра ${index+1}`);input.oninput=()=>{if(recording)return;if(!textEditBefore)textEditBefore=subtitleSnapshot();stopSubtitleRecognition();caption.text=input.value;updateSubtitleClipText(caption);};
    input.onchange=()=>{if(recording)return;if(textEditBefore&&textEditBefore.items[textEditBefore.selected]?.text!==input.value)rememberSubtitleEdit(textEditBefore);textEditBefore=null;const words=input.value.trim().split(/\s+/).filter(Boolean);if(words.length>1){const length=(caption.end-caption.start)/words.length;const items=words.map((word,i)=>({start:caption.start+length*i,end:i===words.length-1?caption.end:caption.start+length*(i+1),text:word}));subtitles.splice(subtitles.indexOf(caption),1,...items);selectedSubtitle=items[0];subtitleList();}else{caption.text=words[0]||'';input.value=caption.text;subtitleEditorStatus();}};
    const timing=document.createElement('div');timing.className='subtitle-timing';
    for(const [key,label] of [['start','Начало'],['end','Конец']]){
      const field=document.createElement('label');field.textContent=label;
      const number=document.createElement('input');number.type='number';number.className='subtitle-boundary';number.min='0';number.step='0.01';number.max=String(source.duration||0);number.value=String(Math.round(caption[key]*1000)/1000);number.disabled=recording;number.setAttribute('aria-label',`${label} слова ${index+1}, секунды`);
      number.onchange=()=>{if(recording)return;const value=number.value.trim()===''?NaN:Number(number.value);if(!Number.isFinite(value)||value<0||value>source.duration||(key==='start'?value>=caption.end:value<=caption.start)){number.value=String(Math.round(caption[key]*1000)/1000);$('subtitleEditStatus').textContent='Проверь время: начало должно быть раньше конца и находиться в пределах видео.';return;}if(value!==caption[key])rememberSubtitleEdit();stopSubtitleRecognition();caption[key]=value;subtitleList();};
      field.append(number);timing.append(field);
    }
    const remove=document.createElement('button');remove.type='button';remove.className='subtitle-delete';remove.textContent='✕';remove.title='Удалить слово';remove.disabled=recording;remove.setAttribute('aria-label',`Удалить слово ${index+1}`);remove.onclick=()=>{if(recording)return;rememberSubtitleEdit();stopSubtitleRecognition();const index=subtitles.indexOf(caption);subtitles.splice(index,1);selectedSubtitle=subtitles[Math.min(index,subtitles.length-1)]||null;subtitleList();};
    row.append(time,input,timing,remove);list.append(row);
  });
  subtitleEditorStatus();if(renderTrack)renderSubtitleTrack();else updateSubtitleClipSelection();
}
$('subtitleAdd').onclick=()=>{
  if(!loaded||recording||!Number.isFinite(source.duration)||source.duration<=0)return;
  rememberSubtitleEdit();stopSubtitleRecognition();const start=Math.max(0,Math.min(source.currentTime,Math.max(0,source.duration-.01))),end=Math.min(source.duration,start+.7);
  const caption={start,end,text:''};subtitles.push(caption);selectedSubtitle=caption;$('subtitleEnabled').checked=true;$('subtitleDetails').open=true;subtitleList();
  const inputs=$('subtitleList').querySelectorAll('.subtitle-text');if(inputs[0])inputs[0].focus();scrollSubtitleIntoView(caption);
};
$('subtitleClear').onclick=()=>{if(!loaded||recording||!subtitles.length)return;if(!window.confirm('Удалить все субтитры?'))return;rememberSubtitleEdit();stopSubtitleRecognition();subtitles=[];selectedSubtitle=null;subtitleList();};
$('subtitleLengthen').onclick=()=>{if(!loaded||recording||!subtitles.length)return;rememberSubtitleEdit();stopSubtitleRecognition();const index=subtitles.indexOf(selectedSubtitle);subtitles=composition.lengthenShortWords(subtitles,source.duration);selectedSubtitle=subtitles[index]||null;subtitleList();};
async function startSubtitles(){
  if(!loaded||recording)return;
  const version=++subtitleVersion, mediaVersion=sourceVersion;
  subtitleState='queued';subtitleList();$('subtitleRetry').disabled=true;$('subtitleStatus').textContent='Подготавливаем субтитры…';
  try{
    const result=await fetch('/api/subtitles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:decodeURIComponent(new URL(source.src).pathname.split('/').pop()),language:$('subtitleLanguage').value})});
    const data=await result.json();if(!result.ok)throw new Error(data.error||'Не удалось запустить распознавание.');
    while(version===subtitleVersion&&mediaVersion===sourceVersion){
      const response=await fetch(`/api/subtitles/${encodeURIComponent(data.job_id)}`);const job=await response.json();if(!response.ok)throw new Error(job.error||'Не удалось получить субтитры.');
      if(version!==subtitleVersion||mediaVersion!==sourceVersion)return;
      subtitleState=job.state;$('subtitleStatus').textContent=job.message+(job.state==='transcribing'&&job.progress>0?` ${job.progress}%`:'');
      if(job.state==='done'){if(subtitles.length)rememberSubtitleEdit();subtitles=composition.lengthenShortWords(job.segments||[],source.duration);selectedSubtitle=null;subtitleList();break;}
      if(job.state==='error'||job.state==='empty')break;
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
  }catch(e){if(version===subtitleVersion&&mediaVersion===sourceVersion){subtitleState='error';$('subtitleStatus').textContent=e.message||'Не удалось распознать речь.';}}
  finally{if(version===subtitleVersion&&mediaVersion===sourceVersion&&!recording)$('subtitleRetry').disabled=false;}
}
$('subtitleRetry').onclick=()=>{if(subtitles.length&&!window.confirm('Распознать заново? Текущие субтитры будут заменены после успешного распознавания.'))return;startSubtitles();};
$('subtitleLanguage').onchange=()=>{if(loaded&&!recording){stopSubtitleRecognition();$('subtitleStatus').textContent='Язык выбран. Нажми «Распознать заново», чтобы применить его.';}};
$('detect').onclick=async()=>{
  if(!loaded||recording)return;
  const version=sourceVersion, revision=cropRevision; $('detect').disabled=true;$('detectStatus').textContent='Ищем лицо и границы камеры…';
  try{
    const response=await fetch('/api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:decodeURIComponent(new URL(source.src).pathname.split('/').pop()),time:source.currentTime})});
    const region=await response.json();if(!response.ok)throw new Error(region.error);if(version!==sourceVersion||revision!==cropRevision||recording)return;
    setCrop(region);
    if(!bandDirty)setCaptionBand(region.caption_band||null,!!region.caption_band);
    $('detectStatus').textContent=region.confidence==='border'?'Границы камеры найдены. Проверьте рамку ниже.':'Найдено лицо, но границы камеры приблизительные. Выдели камеру вручную, чтобы отразить её без фона.';
  }catch(e){if(version===sourceVersion){$('detectStatus').textContent=e.message||'Не удалось найти камеру. Выделите область вручную.';$('cropDetails').open=true;}}
  finally{if(version===sourceVersion&&!recording)$('detect').disabled=false;}
};
function cover(video,dx,dy,dw,dh,region,zoom=1,px=.5,py=.5,pixels=video){
  if(video.readyState<2||!video.videoWidth)return;
  const r=region||{x:0,y:0,width:video.videoWidth,height:video.videoHeight};
  const ratio=dw/dh;let sw=r.width,sh=sw/ratio;if(sh>r.height){sh=r.height;sw=sh*ratio;}sw/=zoom;sh/=zoom;
  ctx.drawImage(pixels,r.x+(r.width-sw)*px,r.y+(r.height-sh)*py,sw,sh,dx,dy,dw,dh);
}
function drawBackground(){
  ctx.save();ctx.translate(0,640);ctx.beginPath();ctx.rect(0,0,720,640);ctx.clip();
  ctx.fillStyle='#10120f';ctx.fillRect(0,0,720,640);
  if(background.readyState>=2)cover(background,0,0,720,640,undefined,1,.5,.5,exportVisuals?.background||background);
  ctx.restore();
}
function drawOriginal(pixels=exportVisuals?.source||source){
  if(source.readyState<2||!source.videoWidth||!source.videoHeight)return;
  const w=source.videoWidth,h=source.videoHeight,band=currentCaptionBand(),split=gameSplit();
  const zoom=Math.max(1,Number($('gameZoom').value)||1),adjustGame=!!split&&(!!band||zoom>1);
  const scale=Math.min(720/w,1280/h),width=w*scale,left=(720-width)/2;
  const mirror=(partTop,partBottom,dx,dy)=>{
    if(!crop||!cropReliable||!$('mirrorCamera').checked)return;
    const x0=Math.max(0,crop.x),x1=Math.min(w,crop.x+crop.width),y0=Math.max(partTop,crop.y),y1=Math.min(partBottom,crop.y+crop.height);
    if(x1>x0&&y1>y0){const x=dx+x0*scale,y=dy+(y0-partTop)*scale;ctx.save();ctx.translate(x+(x1-x0)*scale,y);ctx.scale(-1,1);ctx.drawImage(pixels,x0,y0,x1-x0,y1-y0,0,0,(x1-x0)*scale,(y1-y0)*scale);ctx.restore();}
  };
  ctx.save();ctx.filter=sourceColorFilter();
  if(!adjustGame){
    const y=(1280-h*scale)/2;ctx.drawImage(pixels,0,0,w,h,left,y,width,h*scale);mirror(0,h,left,y);
  }else{
    const upperHeight=split.top*scale;
    if(split.top>0){ctx.drawImage(pixels,0,0,w,split.top,left,0,width,upperHeight);mirror(0,split.top,left,0);}
    const gameSourceHeight=h-split.bottom,gameHeight=1280-upperHeight;
    if(gameSourceHeight>0&&gameHeight>0){
      const sw=w/zoom,sh=gameSourceHeight/zoom;
      const px=Math.max(0,Math.min(1,Number($('gameX').value)/100)),py=Math.max(0,Math.min(1,Number($('gameY').value)/100));
      ctx.drawImage(pixels,(w-sw)*px,split.bottom+(gameSourceHeight-sh)*py,sw,sh,0,upperHeight,720,gameHeight);
    }
  }
  ctx.restore();
}
function drawAd(){
  if(phase!=='ad'||!hasAd()||adVideo.readyState<2)return;
  const frame=exportVisuals?exportAdTime:adVideo.currentTime,pixels=exportVisuals?.ad||adVideo,strength=Number($('keyStrength').value);
  if(!gpuChromaTried){gpuChromaTried=true;try{gpuChroma=window.SplitClipChroma?window.SplitClipChroma.create():null;}catch(e){gpuChroma=null;}}
  if(gpuChroma){
    try{
      if(frame!==cachedAdFrame||strength!==cachedKeyStrength){gpuChroma.render(pixels,strength);cachedAdFrame=frame;cachedKeyStrength=strength;}
      const base=Math.min(720/adVideo.videoWidth,1280/adVideo.videoHeight);
      const dw=adVideo.videoWidth*base*Number($('adScale').value)/100,dh=adVideo.videoHeight*base*adScaleY()/100;
      ctx.drawImage(gpuChroma.canvas,(720-dw)/2+adOffsetX*720/100,(1280-dh)/2+adOffsetY*1280/100,dw,dh);
    }catch(e){gpuChroma=null;cachedAdFrame=-1;}
  }
  if(!gpuChroma){
    const w=keyCanvas.width,h=keyCanvas.height;
    if(frame!==cachedAdFrame||strength!==cachedKeyStrength){
      keyCtx.clearRect(0,0,w,h);
      const base=Math.min(w/adVideo.videoWidth,h/adVideo.videoHeight);
      const dw=adVideo.videoWidth*base*Number($('adScale').value)/100,dh=adVideo.videoHeight*base*adScaleY()/100;
      keyCtx.drawImage(pixels,(w-dw)/2+adOffsetX*w/100,(h-dh)/2+adOffsetY*h/100,dw,dh);
      const imageData=keyCtx.getImageData(0,0,w,h);
      composition.keyGreen(imageData.data,strength);
      keyCtx.putImageData(imageData,0,0);cachedAdFrame=frame;cachedKeyStrength=strength;
    }
    ctx.drawImage(keyCanvas,0,0,720,1280);
  }
  const progress=composition.bannerProgress(exportVisuals?exportAdTime:adVideo.currentTime,adVideo.duration);
  ctx.save();ctx.fillStyle='#ffe500';ctx.fillRect(0,0,720*progress,8);ctx.restore();
}
function drawCropEditor(){
  if(!$('cropDetails').open||!loaded||source.readyState<2)return;
  const maxWidth=720,maxHeight=720,scale=Math.min(maxWidth/source.videoWidth,maxHeight/source.videoHeight,1);
  const w=Math.max(1,Math.round(source.videoWidth*scale)),h=Math.max(1,Math.round(source.videoHeight*scale));
  if(cropCanvas.width!==w||cropCanvas.height!==h){cropCanvas.width=w;cropCanvas.height=h;}
  cropCtx.drawImage(source,0,0,w,h);
  let sx,sy,sw,sh;
  if(crop){
    sx=crop.x*w/source.videoWidth;sy=crop.y*h/source.videoHeight;sw=crop.width*w/source.videoWidth;sh=crop.height*h/source.videoHeight;
    cropCtx.fillStyle='#0009';cropCtx.fillRect(0,0,w,sy);cropCtx.fillRect(0,sy,sx,sh);cropCtx.fillRect(sx+sw,sy,w-sx-sw,sh);cropCtx.fillRect(0,sy+sh,w,h-sy-sh);
  }
  const band=currentCaptionBand();if(band){const a=band.top*h/source.videoHeight,b=band.bottom*h/source.videoHeight;cropCtx.fillStyle='#ffcc0066';cropCtx.fillRect(0,a,w,b-a);cropCtx.strokeStyle='#ffe500';cropCtx.lineWidth=2;cropCtx.strokeRect(1,a,Math.max(0,w-2),Math.max(1,b-a));}
  if(!crop)return;
  const k=cropScreenScale();
  cropCtx.strokeStyle='rgba(255,255,255,.7)';cropCtx.lineWidth=Math.max(1,k);cropCtx.strokeRect(sx+k/2,sy+k/2,Math.max(0,sw-k),Math.max(0,sh-k));
  const t=3*k,len=Math.min(22*k,sw/2,sh/2);
  cropCtx.strokeStyle='#fff';cropCtx.lineWidth=t;cropCtx.lineCap='butt';cropCtx.lineJoin='miter';
  for(const [cx,cy,dx,dy] of [[sx,sy,1,1],[sx+sw,sy,-1,1],[sx,sy+sh,1,-1],[sx+sw,sy+sh,-1,-1]]){
    cropCtx.beginPath();cropCtx.moveTo(cx+dx*len,cy+dy*t/2);cropCtx.lineTo(cx+dx*t/2,cy+dy*t/2);cropCtx.lineTo(cx+dx*t/2,cy+dy*len);cropCtx.stroke();
  }
}
function cropScreenScale(){const r=cropCanvas.getBoundingClientRect();return r.width>0?cropCanvas.width/r.width:1;}
function cropRaw(e){const r=cropCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*source.videoWidth,y:(e.clientY-r.top)/r.height*source.videoHeight,r};}
function cropClamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function cropHit(e){
  if(!crop)return null;
  const r=cropCanvas.getBoundingClientRect();if(!r.width||!r.height)return null;
  const kx=r.width/source.videoWidth,ky=r.height/source.videoHeight;
  const L=r.left+crop.x*kx,T=r.top+crop.y*ky,R=L+crop.width*kx,B=T+crop.height*ky;
  const px=e.clientX,py=e.clientY;
  const tol=Math.max(8,Math.min(e.pointerType==='mouse'?14:26,(R-L)/3,(B-T)/3));
  const dl=Math.abs(px-L),dr=Math.abs(px-R),dt=Math.abs(py-T),db=Math.abs(py-B);
  const inX=px>=L-tol&&px<=R+tol,inY=py>=T-tol&&py<=B+tol;
  const hx=inY&&Math.min(dl,dr)<=tol?(dl<=dr?'l':'r'):'';
  const hy=inX&&Math.min(dt,db)<=tol?(dt<=db?'t':'b'):'';
  if(hx||hy)return{type:'resize',hx,hy};
  if(px>L&&px<R&&py>T&&py<B)return{type:'move',hx:'',hy:''};
  return null;
}
function updateCropCursor(e){
  if(recording||!loaded){cropCanvas.style.cursor='';return;}
  const h=cropHit(e);
  cropCanvas.style.cursor=!h?'crosshair':h.type==='move'?'move':({tl:'nwse-resize',br:'nwse-resize',tr:'nesw-resize',bl:'nesw-resize',l:'ew-resize',r:'ew-resize',t:'ns-resize',b:'ns-resize'})[h.hy+h.hx];
}
cropCanvas.onpointerdown=e=>{
  if(!loaded||recording)return;
  const hit=cropHit(e),p=cropRaw(e);
  dragStart={mode:hit?hit.type:'new',hx:hit?hit.hx:'',hy:hit?hit.hy:'',p,cx:e.clientX,cy:e.clientY,active:false,changed:false,
    rect:crop?{x0:crop.x,y0:crop.y,x1:crop.x+crop.width,y1:crop.y+crop.height}:null};
  cropCanvas.setPointerCapture(e.pointerId);e.preventDefault();
};
cropCanvas.onpointermove=e=>{
  const d=dragStart;
  if(!d){updateCropCursor(e);return;}
  if(!d.active){if(Math.hypot(e.clientX-d.cx,e.clientY-d.cy)<3)return;d.active=true;}
  const W=source.videoWidth,H=source.videoHeight,p=cropRaw(e);
  const minW=Math.min(W,32*W/p.r.width),minH=Math.min(H,32*H/p.r.height);
  const dx=p.x-d.p.x,dy=p.y-d.p.y;let x0,y0,x1,y1;
  if(d.mode==='move'){
    const a=d.rect,w=a.x1-a.x0,h=a.y1-a.y0;
    x0=cropClamp(a.x0+dx,0,W-w);y0=cropClamp(a.y0+dy,0,H-h);x1=x0+w;y1=y0+h;
  }else if(d.mode==='resize'){
    const a=d.rect;x0=a.x0;y0=a.y0;x1=a.x1;y1=a.y1;
    if(d.hx==='l')x0=cropClamp(a.x0+dx,0,a.x1-minW);
    if(d.hx==='r')x1=cropClamp(a.x1+dx,a.x0+minW,W);
    if(d.hy==='t')y0=cropClamp(a.y0+dy,0,a.y1-minH);
    if(d.hy==='b')y1=cropClamp(a.y1+dy,a.y0+minH,H);
  }else{
    const sx=cropClamp(d.p.x,0,W),sy=cropClamp(d.p.y,0,H),ex=cropClamp(p.x,0,W),ey=cropClamp(p.y,0,H);
    if(Math.abs(ex-sx)<=4||Math.abs(ey-sy)<=4)return;
    x0=Math.min(sx,ex);y0=Math.min(sy,ey);x1=Math.max(sx,ex);y1=Math.max(sy,ey);
  }
  d.changed=true;
  setCrop({x:x0,y:y0,width:x1-x0,height:y1-y0});
};
cropCanvas.onpointerup=e=>{
  if(!dragStart)return;
  if(dragStart.changed)$('detectStatus').textContent='Границы камеры выбраны вручную.';
  dragStart=null;updateCropCursor(e);
};
cropCanvas.onpointercancel=()=>{dragStart=null;};
$('resetCrop').onclick=()=>{if(loaded&&!recording){setCrop({...fullCrop(),confidence:'full'});$('detectStatus').textContent='Выбран весь исходный кадр. Потяните за уголки рамки, чтобы оставить только камеру.';}};
function headlineY(){
  let seam=640;
  if(!customURL&&source.videoWidth&&source.videoHeight){
    const scale=Math.min(720/source.videoWidth,1280/source.videoHeight),split=gameSplit();
    if(split&&(currentCaptionBand()||Number($('gameZoom').value)>1))seam=split.top*scale;
    else if(crop&&cropReliable)seam=(1280-source.videoHeight*scale)/2+(crop.y+crop.height)*scale;
  }
  return Math.max(40,Math.min(1240,seam+(Number($('headlineOffset').value)||0)));
}
function drawHeadline(){
  const text=$('headlineText').value.trim();if(!text)return;
  ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
  let font=Math.max(28,Math.min(130,Number($('headlineSize').value)||72)),lines=[];
  do{
    ctx.font=`${font}px SplitclipHeadline, Impact, sans-serif`;lines=[];
    for(const paragraph of text.split(/\r?\n/)){let line='';for(const word of paragraph.trim().split(/\s+/).filter(Boolean)){const next=line?`${line} ${word}`:word;if(line&&ctx.measureText(next).width>650){lines.push(line);line=word;}else line=next;}if(line)lines.push(line);}
    if(lines.length<=3&&lines.every(line=>ctx.measureText(line).width<=650))break;font-=4;
  }while(font>28);
  ctx.font=`${font}px SplitclipHeadline, Impact, sans-serif`;ctx.lineWidth=Math.max(3,font*.12);ctx.strokeStyle='#111';ctx.fillStyle='#fff';
  const lineHeight=font*1.1,startY=headlineY()-(lines.length-1)*lineHeight/2;
  lines.forEach((line,i)=>{ctx.strokeText(line,360,startY+i*lineHeight,650);ctx.fillText(line,360,startY+i*lineHeight,650);});ctx.restore();
}
function drawSubtitles(t){
  if(!$('subtitleEnabled').checked||(customURL&&!crop))return;
  const caption=subtitles.find(item=>t>=item.start&&t<item.end);if(!caption||!caption.text.trim())return;
  const stretch=composition.captionStretch(t,caption.start,caption.end);
  const offset=Number($('subtitleOffset').value)||0;const subtitleY=640+offset;
  ctx.save();ctx.translate(360,subtitleY);ctx.scale(stretch.x,stretch.y);ctx.textAlign='center';ctx.textBaseline='middle';
  let font=Number($('subtitleSize').value)||64,lines=[];const words=caption.text.trim().split(/\s+/);
  do{ctx.font=`900 ${font}px SplitclipCaption, Arial, sans-serif`;lines=[];let line='';for(const word of words){const test=line?`${line} ${word}`:word;if(line&&ctx.measureText(test).width>660){lines.push(line);line=word;}else line=test;}if(line)lines.push(line);if(lines.length<=2&&lines.every(text=>ctx.measureText(text).width<=660))break;font-=4;}while(font>24);
  ctx.font=`900 ${font}px SplitclipCaption, Arial, sans-serif`;ctx.fillStyle=$('subtitleColor').value==='yellow'?'#ffe500':'#fff';ctx.shadowColor='rgba(0,0,0,.8)';ctx.shadowBlur=8;ctx.shadowOffsetY=3;
  const lineHeight=font*1.18,startY=-(lines.length-1)*lineHeight/2;
  lines.forEach((line,i)=>ctx.fillText(line,0,startY+i*lineHeight,660));ctx.restore();
}
function drawComposition(){ctx.fillStyle='#131512';ctx.fillRect(0,0,720,1280);if(loaded){const pixels=blur.pixels(exportVisuals?.source||source,exportVisuals?exportSourceTime:source.currentTime);if(customURL){if(crop){ctx.save();ctx.filter=sourceColorFilter();cover(source,0,0,720,640,cameraRegionForBackground(),Number($('zoom').value),Number($('x').value)/100,Number($('y').value)/100,pixels);ctx.restore();}drawBackground();}else drawOriginal(pixels);drawHeadline();drawSubtitles(exportVisuals?exportSourceTime:source.currentTime);drawAd();}}
function render(){drawComposition();drawCropEditor();blur.renderEditor();if(loaded&&playing&&!transitioning&&phase==='source'&&hasAd()&&adIndex<schedule().length&&source.currentTime>=schedule()[adIndex])beginAd();requestAnimationFrame(render);}requestAnimationFrame(render);
function syncBackground(force=false){
  if(background.readyState<1||!Number.isFinite(background.duration)||background.duration<=0)return;
  const target=(source.currentTime||0)%background.duration;
  if(!background.seeking&&Math.abs(background.currentTime-target)>(force?.01:.3))try{background.currentTime=target;}catch(e){}
}
function totalDuration(){return Math.max(0,source.duration||0)+schedule().length*(hasAd()?adVideo.duration:0);}
function currentTime(){return phase==='ad'&&hasAd()?activeAdAt+adIndex*adVideo.duration+adVideo.currentTime:(source.currentTime||0)+(hasAd()?adIndex*adVideo.duration:0);}
function updateTimeline(){const total=totalDuration(),now=Math.min(total,currentTime());$('time').textContent=fmt(now);$('duration').textContent=fmt(total);$('seek').value=total?now/total*1000:0;updateSubtitlePlayhead();}
function updatePlaybackButtons(){const icon=playing?'❚❚':'▶',label=playing?'Пауза':'Воспроизвести видео';for(const id of ['play','subtitlePlay']){$(id).textContent=icon;$(id).setAttribute('aria-label',label);}}
function pauseComposition(){playing=false;seekRevision++;source.pause();background.pause();adVideo.pause();transitioning=false;updatePlaybackButtons();}
function updateMonitorVolume(){const volume=monitorMuted?0:Number($('monitorVolume').value)/100;if(monitorGain)monitorGain.gain.setTargetAtTime(volume,audioContext.currentTime,.03);$('monitorMute').textContent=volume===0?'🔇':'🔊';$('monitorMute').setAttribute('aria-pressed',String(monitorMuted));$('monitorMute').setAttribute('aria-label',monitorMuted?'Включить звук предпросмотра':'Выключить звук предпросмотра');}
$('monitorVolume').oninput=()=>{monitorMuted=false;updateMonitorVolume();};
$('monitorMute').onclick=()=>{monitorMuted=!monitorMuted;updateMonitorVolume();};
async function setupAudio(){
  if(!audioContext){
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio){$('monitorMute').disabled=true;$('monitorVolume').disabled=true;return null;}
    audioContext=new Audio();audioMix=audioContext.createMediaStreamDestination();
    const limiter=audioContext.createDynamicsCompressor();limiter.threshold.value=-6;limiter.knee.value=0;limiter.ratio.value=12;limiter.attack.value=.003;limiter.release.value=.25;monitorGain=audioContext.createGain();limiter.connect(monitorGain);monitorGain.connect(audioContext.destination);limiter.connect(audioMix);updateMonitorVolume();
    sourceGain=audioContext.createGain();adGain=audioContext.createGain();sourceGain.connect(limiter);adGain.connect(limiter);
    audioContext.createMediaElementSource(source).connect(sourceGain);audioContext.createMediaElementSource(adVideo).connect(adGain);updateAudioStatus();
  }
  if(audioContext.state==='suspended')await audioContext.resume();
  return audioMix;
}
async function playComposition(){
  if(!loaded)return;
  try{
    await setupAudio();playing=true;updatePlaybackButtons();
    if(phase==='ad')await adVideo.play();
    else{if(source.ended){await seekTo(source,0);adIndex=0;}await playSourceInSync();}
  }catch(e){pauseComposition();message('Не удалось воспроизвести видео: '+e.message);throw e;}
}
function seekTo(video,time){return new Promise((resolve,reject)=>{const atTarget=Math.abs(video.currentTime-time)<.001;if(atTarget&&!video.seeking)return resolve();let timer;const clean=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',fail);};const done=()=>{clean();resolve();};const fail=()=>{clean();reject(new Error('Не удалось перемотать видео.'));};video.addEventListener('seeked',done,{once:true});video.addEventListener('error',fail,{once:true});timer=setTimeout(fail,10000);if(!atTarget)video.currentTime=time;});}
function seekBackgroundToSource(){if(!customURL||background.readyState<1||!Number.isFinite(background.duration)||background.duration<=0)return Promise.resolve();return seekTo(background,(source.currentTime||0)%background.duration);}
async function playSourceInSync(){const revision=seekRevision;await seekBackgroundToSource();if(revision!==seekRevision||!playing||phase!=='source')return;const starts=[source.play()];if(customURL&&background.readyState>=2)starts.push(background.play());await Promise.all(starts);}
async function seekComposition(t){
  if(!loaded||recording)return;
  const wasPlaying=playing,revision=++seekRevision;transitioning=true;source.pause();background.pause();adVideo.pause();
  const target=composition.mapRepeated(t,source.duration,adVideo.duration||0,adAt,hasAd());phase=target.phase;adIndex=target.completed;activeAdAt=target.adAt??0;
  try{await seekTo(source,target.sourceTime);await seekBackgroundToSource();if(hasAd())await seekTo(adVideo,Math.min(target.adTime,Math.max(0,adVideo.duration-.01)));if(revision!==seekRevision)return;transitioning=false;updateTimeline();if(wasPlaying){if(phase==='ad')await adVideo.play();else await playSourceInSync();}}
  catch(e){if(revision===seekRevision){pauseComposition();message(e.message);}}
}
async function beginAd(){
  if(transitioning||!playing||!hasAd()||adIndex>=schedule().length)return;
  activeAdAt=schedule()[adIndex];
  const revision=++seekRevision;transitioning=true;source.pause();background.pause();
  try{await seekTo(source,activeAdAt);await seekBackgroundToSource();await seekTo(adVideo,0);if(revision!==seekRevision)return;phase='ad';transitioning=false;updateTimeline();if(playing)await adVideo.play();}
  catch(e){if(revision===seekRevision){exportFailed=recording;pauseComposition();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();message('Не удалось воспроизвести баннер: '+e.message);}}
}
adVideo.onended=async()=>{
  if(phase!=='ad'||!playing)return;const revision=++seekRevision;transitioning=true;phase='source';adIndex++;
  try{await seekTo(source,activeAdAt);if(revision!==seekRevision)return;transitioning=false;updateTimeline();if(playing)await playSourceInSync();}
  catch(e){if(revision===seekRevision){exportFailed=recording;pauseComposition();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();message('Не удалось продолжить ролик: '+e.message);}}
};
$('play').onclick=async()=>{if(!loaded||recording)return;if(playing)pauseComposition();else try{await playComposition();}catch(e){}};
$('subtitlePlay').onclick=()=>$('play').onclick();
$('subtitleBack').onclick=()=>{if(loaded&&!recording)seekSourceOnSubtitleTrack(Math.max(0,source.currentTime-3));};
source.onpause=()=>{if(source.paused)background.pause();};
source.onended=()=>{if(phase!=='source')return;if(playing&&hasAd()&&adIndex<schedule().length){beginAd();return;}playing=false;updatePlaybackButtons();background.pause();updateTimeline();if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();};
source.ontimeupdate=()=>{updateTimeline();if(playing&&phase==='source'&&!transitioning&&!source.paused){syncBackground();if(hasAd()&&adIndex<schedule().length&&source.currentTime>=schedule()[adIndex])beginAd();}};
adVideo.ontimeupdate=()=>updateTimeline();
adVideo.onseeked=()=>{cachedAdFrame=-1;};
$('seek').oninput=()=>{if(loaded&&!recording)seekComposition(totalDuration()*Number($('seek').value)/1000);};
function finishExport(){recording=false;activeRecorder=null;setEditingDisabled(false);$('export').disabled=false;$('play').disabled=false;$('saveAs').disabled=!lastExportBlob;$('cancelExport').hidden=true;$('export').innerHTML='<span>↓</span> Экспортировать видео <b>↗</b>';}
function appendDownloadLink(auto=false){if(!lastExportURL)return;const a=document.createElement('a');a.href=lastExportURL;a.download=lastExportName;a.textContent='Скачать видео через браузер';$('message').append(a);if(auto)a.click();}
$('saveAs').onclick=async()=>{
  if(!lastExportBlob||recording)return;
  if(typeof window.showSaveFilePicker!=='function'){message('Браузер сохранит видео в папку загрузок или предложит выбрать место: ');appendDownloadLink(true);return;}
  $('saveAs').disabled=true;$('export').disabled=true;let writable;
  try{
    const mp4=lastExportName.endsWith('.mp4'),type=mp4?'video/mp4':'video/webm',extension=mp4?'.mp4':'.webm';
    const handle=await window.showSaveFilePicker({suggestedName:lastExportName,types:[{description:mp4?'Видео MP4':'Видео WebM',accept:{[type]:[extension]}}]});
    writable=await handle.createWritable();await writable.write(lastExportBlob);await writable.close();message(`Видео сохранено: ${handle.name}`);
  }catch(e){
    if(writable&&typeof writable.abort==='function')try{await writable.abort();}catch(_){}
    if(e.name==='AbortError')message('Сохранение отменено. Готовое видео можно сохранить позже.');
    else{message('Не удалось сохранить в выбранное место. Попробуй ещё раз или ');appendDownloadLink();}
  }finally{$('saveAs').disabled=false;$('export').disabled=false;}
};
$('cancelExport').onclick=()=>{exportCancelled=true;if(exportAbort)exportAbort.abort();if(exportJob)fetch(`/api/export/${exportJob}`,{method:'DELETE'}).catch(()=>{});};
function exportFrameBlob(){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось подготовить кадр.')),'image/jpeg',.95));}
async function exportRequest(url,options){
  const response=await fetch(url,options);
  if(!response.ok){let data;try{data=await response.json();}catch(_){}throw new Error(data?.error||'Ошибка экспорта видео.');}
  return response;
}
$('export').onclick=async()=>{
  if(!loaded||recording)return;if(customURL&&!crop)return message('Сначала выделите область камеры в исходном кадре.');if(customURL&&background.readyState<2)return message('Дождитесь загрузки фонового видео или уберите фон.');if($('colorEnabled').checked&&colorProfile.state==='analyzing')return message('Дождитесь подбора цвета или отключите цветокоррекцию.');if($('subtitleEnabled').checked&&['queued','loading','transcribing'].includes(subtitleState))return message('Дождитесь готовности субтитров или отключите их перед экспортом.');if(sourceAudio.state==='pending'||(hasAd()&&adAudio.state==='pending'))return message('Дождитесь проверки и выравнивания громкости.');if(hasAd()&&!adInspection)return message('Дождитесь автоматического подбора и проверки размера баннера.');
  recording=true;exportCancelled=false;timingRevision++;setEditingDisabled(true);$('export').disabled=true;$('saveAs').disabled=true;$('play').disabled=true;$('cancelExport').hidden=false;$('export').textContent='Готовим видео…';message('Собираем видео покадрово. Это может занять больше времени, чем длительность ролика. Держите вкладку открытой.');
  exportAbort=new AbortController();let job=null;
  try{
    pauseComposition();await Promise.all([captionFontReady,headlineFontReady]);
    const enabled=hasAd(),adTimes=enabled?schedule():[],duration=source.duration,adDuration=enabled?adVideo.duration:0;
    const name=decodeURIComponent(new URL(source.src,location.href).pathname.split('/').pop());
    let backgroundName=null;
    if(customURL){if(!backgroundUploadFile)throw new Error('Загрузи фоновое видео заново.');const uploaded=await upload(backgroundUploadFile);backgroundName=decodeURIComponent(new URL(uploaded.url,location.href).pathname.split('/').pop());}
    const settings={protocol:2,source:name,ad:enabled?adServerName:null,background:backgroundName,duration,adDuration,schedule:adTimes,sourceGain:sourceAudio.state==='ok'?sourceAudio.gain:1,adGain:adAudio.state==='ok'?adAudio.gain:1};
    if(enabled&&!adServerName)throw new Error('Дождитесь загрузки баннера.');
    const created=await (await exportRequest('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).json();
    job=exportJob=created.job;
    if(exportCancelled)throw new DOMException('Cancelled','AbortError');
    if(created.protocol!==2||created.fps!==60)throw new Error('Версии страницы и сервера не совпадают. Перезапусти сервер и обнови страницу.');
    const fps=created.fps,frames=created.frames,images={},indices={};exportVisuals=images;
    async function getInput(kind,time){
      const index=Math.max(0,Math.floor(time*fps+1e-7));if(indices[kind]===index)return;
      const response=await exportRequest(`/api/export/${job}/input/${kind}?index=${index}`,{signal:exportAbort.signal});
      const bitmap=await createImageBitmap(await response.blob());if(images[kind])images[kind].close();images[kind]=bitmap;indices[kind]=index;
    }
    for(let i=0;i<frames;i++){
      if(exportCancelled)throw new DOMException('Cancelled','AbortError');
      const target=composition.mapRepeated(i/fps,duration,adDuration,adAt,enabled);
      phase=target.phase;adIndex=target.completed;activeAdAt=target.adAt??0;exportSourceTime=target.sourceTime;exportAdTime=target.adTime;
      await getInput('source',Math.min(target.sourceTime,Math.max(0,duration-.001)));
      if(customURL)await getInput('background',target.sourceTime%background.duration);
      if(phase==='ad')await getInput('ad',Math.min(target.adTime,Math.max(0,adDuration-.001)));
      if(exportCancelled)throw new DOMException('Cancelled','AbortError');
      drawComposition();const blob=await exportFrameBlob();
      await exportRequest(`/api/export/${job}/frame`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob,signal:exportAbort.signal});
      if(i%15===0||i===frames-1){const percent=Math.floor((i+1)/frames*100);$('export').textContent=`Обрабатываем кадры: ${percent}%`;message(`Собираем видео покадрово: ${percent}%. Держите вкладку открытой.`);}
    }
    $('export').textContent='Собираем звук…';message('Кадры готовы. Добавляем звук и сохраняем видео…');
    const result=await (await exportRequest(`/api/export/${job}/finish`,{method:'POST',signal:exportAbort.signal})).json();
    const blob=await (await exportRequest(result.url,{signal:exportAbort.signal})).blob();
    if(exportCancelled)throw new DOMException('Cancelled','AbortError');
    if(lastExportURL)URL.revokeObjectURL(lastExportURL);lastExportBlob=blob;lastExportURL=URL.createObjectURL(blob);lastExportName='splitclip.mp4';$('saveAs').hidden=false;
    if(typeof window.showSaveFilePicker==='function'){$('saveAs').textContent='Выбрать место и сохранить';message('Видео готово. Нажми «Выбрать место и сохранить».');}else{$('saveAs').textContent='Скачать видео снова';message('Видео готово. Браузер скачивает файл; выбор папки зависит от его настроек: ');appendDownloadLink(true);}
  }catch(e){
    if(job)fetch(`/api/export/${job}`,{method:'DELETE'}).catch(()=>{});
    message(exportCancelled||e.name==='AbortError'?'Экспорт отменён.':'Не удалось собрать видео: '+e.message);
  }finally{if(exportVisuals){for(const bitmap of Object.values(exportVisuals))bitmap.close();exportVisuals=null;}cachedAdFrame=-1;exportJob=null;exportAbort=null;phase='source';adIndex=completedAt(source.currentTime);finishExport();updateTimeline();}
};
renderValidation();
