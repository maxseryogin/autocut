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
  function automaticAdPlacement(sourceDuration,adDuration,suggested){
    // Match the GitHub version: choose using the source duration and the detected pause.
    const d=Number(sourceDuration);
    if(!Number.isFinite(d)||d<=0)return null;
    const low=d<=20?0:10,high=d<=20?d/2:Math.min(15,d/2);
    const preferred=Number.isFinite(suggested)?suggested:d/2;
    return {time:Math.max(low,Math.min(high,preferred)),feasible:high>=low};
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
  function bannerProgress(time,duration){
    if(!Number.isFinite(time)||!Number.isFinite(duration)||duration<=0)return 0;
    const t=Math.max(0,Math.min(1,time/duration));
    if(t<=.5)return 4*t/3;
    const s=2*t-1;
    return 2*(1+s-s**3+s**4/2)/3;
  }
  function captionStretch(time,start,end){
    if(!Number.isFinite(time)||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return {x:1,y:1};
    const duration=Math.min(.18,(end-start)*.45);
    const t=Math.max(0,Math.min(1,(time-start)/duration));
    const eased=1-(1-t)**3;
    return {x:.86+.14*eased,y:1.03-.03*eased};
  }
  function estimateColor(frames){
    const percentile=(a,p)=>a[Math.min(a.length-1,Math.floor((a.length-1)*p))];
    const medians=[],lows=[],highs=[],saturations=[];
    for(const data of frames){
      const light=[],sat=[];
      for(let i=0;i+3<data.length;i+=4){
        if(data[i+3]<128)continue;
        const r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255,l=.2126*r+.7152*g+.0722*b;
        if(l<.035||l>.975)continue; // Ignore black bars and clipped highlights.
        const hi=Math.max(r,g,b),lo=Math.min(r,g,b);light.push(l);if(hi>.08)sat.push((hi-lo)/hi);
      }
      if(light.length<16)continue;
      light.sort((a,b)=>a-b);sat.sort((a,b)=>a-b);
      lows.push(percentile(light,.1));medians.push(percentile(light,.5));highs.push(percentile(light,.9));saturations.push(sat.length?percentile(sat,.5):0);
    }
    if(!medians.length)return null;
    const middle=a=>{a.sort((x,y)=>x-y);return percentile(a,.5);};
    const median=middle(medians),low=middle(lows),high=middle(highs),sat=middle(saturations);
    const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
    let brightness=clamp(1+(.46-median)*.35,.92,1.12);
    let contrast=clamp(1+(.62-(high-low))*.18,.96,1.10);
    if(high>.9)brightness=Math.min(brightness,1.02);
    if(low<.07||high>.93)contrast=Math.min(contrast,1.04);
    const saturation=sat<.025?1:clamp(1+(.42-sat)*.22,.94,1.10);
    return {brightness,contrast,saturation,samples:medians.length};
  }
  function colorFilter(profile,amount){
    if(!profile||!Number.isFinite(amount)||amount<=0)return 'none';
    const strength=Math.max(0,Math.min(1,amount/100));
    const value=name=>{const x=profile[name];return (1+(Number.isFinite(x)?x-1:0)*strength).toFixed(4);};
    return `brightness(${value('brightness')}) contrast(${value('contrast')}) saturate(${value('saturation')})`;
  }
  function validateProject(data){
    const results=[];const add=(id,state,message)=>results.push({id,state,message});
    const d=data.duration,at=data.adAt;
    if(!Number.isFinite(d)||d<=0){add('duration','pending','Загрузите исходное видео.');return results;}
    add('duration',d>=10?'pass':'fail',d>=10?`Основное видео ${d.toFixed(1)} с — не меньше 10 с.`:`Основное видео ${d.toFixed(1)} с — нужно минимум 10 с без рекламы.`);
    if(!data.adEnabled){add('banner','fail','Выберите и включите рекламную вставку.');return results;}
    const adDuration=data.adDuration;
    const fiveSeconds=Number.isFinite(adDuration)&&Math.abs(adDuration-5)<=.05;
    add('banner-duration',fiveSeconds?'pass':'fail',fiveSeconds?`Вставка ${adDuration.toFixed(2)} с, проигрывается целиком.`:`Вставка ${Number.isFinite(adDuration)?adDuration.toFixed(2):'неизвестной длительности'} с; нужна пятисекундная вставка целиком.`);
    const schedule=adSchedule(d,at,true),required=Math.ceil(d/60);
    const total=d+schedule.length*adDuration;
    const shortVideo=total<=20;
    const early=Number.isFinite(at)&&Number.isFinite(total)&&at>=0&&at+adDuration<=total/2+1e-9&&(shortVideo||(at>=10&&at<=15));
    add('placement',early?'pass':'fail',early?'Первая вставка целиком находится в первой половине итогового ролика.':shortVideo?'Для ролика 10–20 с разместите вставку целиком в первой половине итогового ролика.':'Вставка должна начинаться на 10–15 секунде и целиком находиться в первой половине итогового ролика.');
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
  function moveSubtitle(start,end,delta,duration,mode){
    if(!Number.isFinite(duration)||duration<=0)return {start,end};
    const minLength=Math.min(.05,duration),clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
    if(mode==='start')return {start:clamp(start+delta,0,end-minLength),end};
    if(mode==='end')return {start,end:clamp(end+delta,start+minLength,duration)};
    const length=end-start,next=clamp(start+delta,0,Math.max(0,duration-length));
    return {start:next,end:next+length};
  }
  function lengthenShortWords(items,duration){
    const words=items.map(item=>({...item}));
    if(!Number.isFinite(duration)||duration<=0||!words.length)return words;
    // Rebalance whole phrases rather than repeatedly stealing time from the next
    // short word. Long pauses remain empty; close words meet at one boundary.
    const groups=[];
    for(let i=0;i<words.length;i++){
      if(i===0||words[i].start-words[i-1].end>.45)groups.push([]);
      groups[groups.length-1].push(i);
    }
    for(const group of groups){
      const first=group[0],last=group[group.length-1];
      let start=Math.max(0,words[first].start),end=Math.min(duration,group.reduce((latest,i)=>Math.max(latest,words[i].end),0));
      const goals=group.map(i=>{
        const letters=String(words[i].text||'').replace(/[^\p{L}\p{N}]/gu,'');
        return letters.length&&letters.length<=2 ? .30 : .18;
      });
      const required=goals.reduce((a,b)=>a+b,0);
      let need=Math.max(0,required-(end-start));
      // Borrow a little neighbouring silence only when a phrase is too short.
      const leftLimit=first?Math.max(0,words[first-1].end):0;
      const rightLimit=last+1<words.length?Math.min(duration,words[last+1].start):duration;
      const leftRoom=Math.max(0,Math.min(.2,start-leftLimit-(first ? .46 : 0)));
      const rightRoom=Math.max(0,Math.min(.2,rightLimit-end-(last+1<words.length ? .46 : 0)));
      let left=Math.min(leftRoom,need/2),right=Math.min(rightRoom,need-left);
      left+=Math.min(leftRoom-left,need-left-right);start-=left;end+=right;
      const ratio=Math.min(1,Math.max(0,end-start)/required),minimums=goals.map(n=>n*ratio);
      let cursor=start,remaining=minimums.reduce((a,b)=>a+b,0);
      for(let j=0;j<group.length;j++){
        const index=group[j],word=words[index];remaining-=minimums[j];
        const preferred=j===group.length-1?end:(word.end+words[group[j+1]].start)/2;
        const boundary=j===group.length-1?end:Math.max(cursor+minimums[j],Math.min(end-remaining,preferred));
        word.start=Math.round(cursor*1000)/1000;word.end=Math.round(boundary*1000)/1000;cursor=boundary;
      }
    }
    return words;
  }
  const api={projectDuration,mapTime,adSchedule,automaticAdPlacement,mapRepeated,bannerProgress,captionStretch,estimateColor,colorFilter,validateProject,keyGreen,moveSubtitle,lengthenShortWords};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SplitClipComposition=api;
})(typeof window!=='undefined'?window:globalThis);
