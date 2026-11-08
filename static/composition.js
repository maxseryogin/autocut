(function(root){
  function projectDuration(sourceDuration,adDuration,enabled){return Math.max(0,sourceDuration||0)+(enabled?Math.max(0,adDuration||0):0);}
  function mapTime(time,sourceDuration,adDuration,at,enabled){
    const total=projectDuration(sourceDuration,adDuration,enabled),t=Math.max(0,Math.min(total,time||0));
    if(!enabled||adDuration<=0)return {phase:'source',sourceTime:Math.min(sourceDuration,t),adTime:0,adDone:false};
    at=Math.max(0,Math.min(sourceDuration,at));
    if(t<at)return {phase:'source',sourceTime:t,adTime:0,adDone:false};
    if(t<at+adDuration)return {phase:'ad',sourceTime:at,adTime:t-at,adDone:false};
    return {phase:'source',sourceTime:Math.min(sourceDuration,t-adDuration),adTime:adDuration,adDone:true};
  }
  function adSchedule(sourceDuration,at,enabled){
    if(!enabled||!(sourceDuration>0))return [];
    const first=Math.max(0,Math.min(sourceDuration-.01,at));
    const times=[first];
    for(let boundary=60;boundary<sourceDuration;boundary+=60)if(boundary>first+.01)times.push(boundary);
    return times;
  }
  function mapRepeated(time,sourceDuration,adDuration,at,enabled){
    const schedule=adSchedule(sourceDuration,at,enabled&&adDuration>0);
    const total=Math.max(0,sourceDuration)+schedule.length*adDuration,t=Math.max(0,Math.min(total,time||0));
    for(let i=0;i<schedule.length;i++){
      const start=schedule[i]+i*adDuration;
      if(t<start)return {phase:'source',sourceTime:t-i*adDuration,adTime:0,completed:i,adAt:null};
      if(t<start+adDuration)return {phase:'ad',sourceTime:schedule[i],adTime:t-start,completed:i,adAt:schedule[i]};
    }
    return {phase:'source',sourceTime:Math.min(sourceDuration,t-schedule.length*adDuration),adTime:0,completed:schedule.length,adAt:null};
  }
  function validateProject(data){
    const results=[];const add=(id,state,message)=>results.push({id,state,message});
    const d=data.duration,at=data.adAt;
    if(!Number.isFinite(d)||d<=0){add('duration','pending','Загрузите исходное видео.');return results;}
    add('duration',d>=10?'pass':'fail',d>=10?`Основное видео ${d.toFixed(1)} с — не меньше 10 с.`:`Основное видео ${d.toFixed(1)} с — нужно минимум 10 с без рекламы.`);
    if(!data.adEnabled){add('banner','fail','Выберите и включите рекламную вставку.');return results;}
    add('banner-duration','pass',`Вставка ${data.adDuration.toFixed(2)} с, проигрывается целиком.`);
    const early=d<=20 ? at<=d/2 : at>=10&&at<=15&&at<=d/2;
    add('placement',early?'pass':'fail',early?'Первая вставка находится в требуемом промежутке.':d<=20?'Для видео 10–20 с вставьте рекламу в первую половину основного видео.':'Первая вставка должна начинаться на 10–15 секунде и в первой половине основного видео.');
    const schedule=adSchedule(d,at,true),required=Math.ceil(d/60);
    const minutes=new Set(schedule.map(x=>Math.floor(x/60)));
    const frequencyOK=schedule.length===required&&minutes.size===required;
    const crossesBoundary=Math.ceil((d+schedule.length*data.adDuration)/60)>required;
    add('frequency',!frequencyOK?'fail':crossesBoundary?'manual':'pass',!frequencyOK?`Нужно по одной вставке на каждую начатую минуту основного видео: ${required}.`:crossesBoundary?`Вставок по длительности основного видео: ${schedule.length}. С рекламой ролик пересекает следующую минуту — уточните способ подсчёта.`:`Вставок: ${schedule.length}; по одной на каждую начатую минуту основного видео.`);
    if(!data.adInspection)add('size','pending','Измеряем размер и положение баннера.');
    else if(data.adInspection.state!=='ok')add('size','manual','Автоматически измерить баннер не удалось. Проверьте размер и положение вручную.');
    else {const a=data.adInspection;add('size',a.min_visible_percent>=25&&a.centered&&!a.clipped?'manual':'fail',a.min_visible_percent>=25&&a.centered&&!a.clipped?`В ${a.sample_count||20} проверенных кадрах видимая область не меньше ${a.min_visible_percent}% и по центру. Проверьте всю анимацию.`:`В части кадров баннер занимает от ${a.min_visible_percent}% экрана; нужно от 25%, по центру и без обрезки. Проверьте исходную анимацию.`);}
    if(!data.adAudio||data.adAudio.state==='pending')add('audio','pending','Проверяем звук баннера.');
    else if(data.adAudio.state==='error')add('audio','manual','Не удалось проверить звук автоматически; послушайте баннер.');
    else add('audio',data.adAudio.state==='ok'?'pass':'fail',data.adAudio.state==='ok'?'Звук баннера обнаружен.':'В баннере не найден слышимый звук.');
    if(data.sourceAudio&&data.sourceAudio.state==='ok'&&data.adAudio&&data.adAudio.state==='ok')add('loudness','manual',(data.sourceAudio.limited||data.adAudio.limited)?'Усиление ограничено. Проверьте громкость обоих фрагментов на слух.':'Громкость выровнена по средней громкости. Проверьте её на слух.');
    else if(data.sourceAudio&&data.sourceAudio.state!=='pending')add('loudness','manual','Не удалось выровнять обе дорожки. Проверьте громкость вручную.');
    add('review','manual','Проверьте весь баннер: текст читается, видео не обрезано, не ускорено и не заглушено; другой рекламы нет.');
    return results;
  }
  function keyGreen(data,strength){
    const threshold=42-Math.max(0,Math.min(100,strength))*0.35;
    for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];if(g<55)continue;const diff=g-Math.max(r,b);const amount=Math.max(0,Math.min(1,(diff-threshold)/28));if(amount){data[i+3]=Math.round(data[i+3]*(1-amount));if(amount<1)data[i+1]=Math.round(g-(diff*amount*.55));}}
    return data;
  }
  const api={projectDuration,mapTime,adSchedule,mapRepeated,validateProject,keyGreen};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SplitClipComposition=api;
})(typeof window!=='undefined'?window:globalThis);
