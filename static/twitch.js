(() => {
  const el=id=>document.getElementById(id), panel=el('twitchPanel'), video=el('twitchVideo');
  let clips=[], tab='pending', currentId=null, busy=false, active=false, timer=null, firstLoad=true;
  let movedByUser=false;
  async function api(url,options){
    const response=await fetch(url,options);let data=null;
    if(response.status!==204){try{data=await response.json();}catch(_){} }
    if(!response.ok)throw new Error(data?.error||'Не удалось выполнить действие.');
    return response.status===204?true:data;
  }
  const visible=()=>clips.filter(c=>c.status===tab);
  const current=()=>visible().find(c=>c.id===currentId)||null;
  function render(){
    const list=visible();
    if(!list.some(c=>c.id===currentId))currentId=list[0]?.id||null;
    const clip=current(), idx=clip?list.findIndex(c=>c.id===clip.id): -1;
    el('twitchPendingCount').textContent=clips.filter(c=>c.status==='pending').length;
    el('twitchApprovedCount').textContent=clips.filter(c=>c.status==='approved').length;
    for(const [name,id] of [['pending','twitchPending'],['approved','twitchApproved']]){
      el(id).classList.toggle('active',tab===name);el(id).setAttribute('aria-pressed',String(tab===name));
    }
    el('twitchIndex').textContent=clip?`${idx+1} / ${list.length}`:'0 / 0';
    el('twitchTitle').textContent=clip?.title||'Выбери клип';
    el('twitchDuration').textContent=clip?`${Math.round(clip.duration||0)} сек.`:'';
    el('twitchEmpty').hidden=!!clip;
    el('twitchEmpty').innerHTML=tab==='pending'?'Пока нет клипов.<br>Нажми «Найти клипы».':'Здесь появятся отобранные клипы.';
    el('twitchPlay').disabled=busy||!clip;
    el('twitchPrev').disabled=busy||!clip||idx===0;
    el('twitchNext').disabled=busy||!clip||idx>=list.length-1;
    el('twitchSelect').disabled=busy||!clip;
    el('twitchReject').hidden=tab!=='pending';el('twitchReject').disabled=busy||!clip;
    const original=el('twitchOriginal');original.hidden=true;
    if(clip){try{const u=new URL(clip.url);if(u.protocol==='https:'&&(u.hostname==='twitch.tv'||u.hostname.endsWith('.twitch.tv'))){original.href=u.href;original.hidden=false;}}catch(_){}}
    if(video.dataset.clipId!==(clip?.id||'')){
      video.pause();video.dataset.clipId=clip?.id||'';
      if(clip){video.src=`/api/twitch/clips/${encodeURIComponent(clip.id)}/video`;video.load();video.playbackRate=Number(el('twitchSpeed').value)||1;if(movedByUser)video.play().catch(()=>{});}
      else{video.removeAttribute('src');video.load();}
      movedByUser=false;
    }
  }
  async function refresh(){
    try{
      const data=await api('/api/twitch/status');clips=data.clips||[];active=!!data.active;
      if(firstLoad){if(!clips.some(c=>c.status==='pending')&&clips.some(c=>c.status==='approved'))tab='approved';firstLoad=false;}
      el('twitchStatus').textContent=data.message||'';el('twitchWarning').textContent=data.warning||'';el('twitchWarning').hidden=!data.warning;
      el('twitchStart').hidden=active;el('twitchStop').hidden=!active;el('twitchStart').disabled=busy;el('twitchStop').disabled=busy;
      render();
    }catch(e){el('twitchStatus').textContent=e.message;}
    clearTimeout(timer);timer=setTimeout(refresh,active?1500:6000);
  }
  function move(delta){const list=visible(),idx=list.findIndex(c=>c.id===currentId),next=idx+delta;if(next>=0&&next<list.length){currentId=list[next].id;movedByUser=true;render();}}
  el('twitchPrev').onclick=()=>move(-1);el('twitchNext').onclick=()=>move(1);
  for(const [name,id] of [['pending','twitchPending'],['approved','twitchApproved']])el(id).onclick=()=>{tab=name;currentId=null;movedByUser=false;render();};
  el('twitchSpeed').onchange=()=>{video.playbackRate=Number(el('twitchSpeed').value)||1;};
  el('twitchPlay').onclick=()=>{if(video.paused)video.play().catch(()=>{});else video.pause();};
  for(const event of ['play','pause','ended'])video.addEventListener(event,()=>{el('twitchPlay').textContent=video.paused?'▶':'❚❚';el('twitchPlay').setAttribute('aria-label',video.paused?'Воспроизвести клип':'Пауза');});
  video.addEventListener('play',()=>{if(typeof window.pauseComposition==='function')window.pauseComposition();});
  for(const id of ['play','subtitlePlay'])el(id).addEventListener('click',()=>video.pause());
  async function action(url,method='POST'){
    if(busy)return null;busy=true;render();el('twitchStart').disabled=true;el('twitchStop').disabled=true;
    let error='';
    try{return await api(url,{method});}catch(e){error=e.message;return null;}
    finally{busy=false;await refresh();if(error){el('twitchWarning').textContent=error;el('twitchWarning').hidden=false;}}
  }
  el('twitchStart').onclick=()=>{tab='pending';currentId=null;render();return action('/api/twitch/search');};
  el('twitchStop').onclick=()=>action('/api/twitch/stop');
  function releaseVideo(){video.pause();video.removeAttribute('src');video.load();}
  el('twitchReject').onclick=async()=>{
    const clip=current();if(!clip)return;
    releaseVideo();const result=await action(`/api/twitch/clips/${encodeURIComponent(clip.id)}/reject`);
    if(!result){video.dataset.clipId='';render();}
  };
  el('twitchSelect').onclick=async()=>{
    const clip=current();if(!clip||busy)return;
    if(window.SplitClipCanLoadSource&&!window.SplitClipCanLoadSource()){el('twitchWarning').textContent='Дождись окончания экспорта.';el('twitchWarning').hidden=false;return;}
    releaseVideo();const result=await action(`/api/twitch/clips/${encodeURIComponent(clip.id)}/select`);
    if(!result){video.dataset.clipId='';render();return;}
    try{
      el('sourceStatus').textContent='Добавляем клип в редактор…';
      await window.SplitClipLoadSource(result);
      el('sourceStatus').textContent=`Готово: ${result.name}`;
      el('canvas').scrollIntoView({behavior:'smooth',block:'center'});
    }catch(e){el('sourceStatus').textContent='Не удалось добавить клип';el('twitchWarning').textContent=e.message;el('twitchWarning').hidden=false;}
  };
  panel.addEventListener('keydown',e=>{
    if(e.target.matches('input,select,textarea,video'))return;
    if(e.key==='ArrowLeft'){e.preventDefault();move(-1);}
    else if(e.key==='ArrowRight'){e.preventDefault();move(1);}
    else if(e.key==='Enter'&&e.target===panel){e.preventDefault();el('twitchSelect').click();}
  });
  panel.tabIndex=0;
  refresh();
})();
