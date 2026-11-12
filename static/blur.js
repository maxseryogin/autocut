(function(root){
  function shape(ctx, region, width, height){
    ctx.beginPath();
    if(region.type==='free'){
      region.points.forEach((point,i)=>ctx[i?'lineTo':'moveTo'](point.x*width,point.y*height));
      ctx.closePath();
    }else{
      const x=Math.min(region.a.x,region.b.x)*width,y=Math.min(region.a.y,region.b.y)*height;
      const w=Math.abs(region.b.x-region.a.x)*width,h=Math.abs(region.b.y-region.a.y)*height;
      if(region.type==='ellipse')ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);
      else ctx.rect(x,y,w,h);
    }
  }
  function create(options){
    const $=options.get, editor=$('blurCanvas'), ectx=editor.getContext('2d');
    const result=document.createElement('canvas'),rctx=result.getContext('2d');
    const blurred=document.createElement('canvas'),bctx=blurred.getContext('2d');
    const mask=document.createElement('canvas'),mctx=mask.getContext('2d');
    let regions=[],selected=null,drawing=null,maskKey='';
    const clamp=n=>Math.max(0,Math.min(1,n));
    function point(e){const r=editor.getBoundingClientRect();return {x:clamp((e.clientX-r.left)/r.width),y:clamp((e.clientY-r.top)/r.height)};}
    function update(){
      const video=options.source(),duration=video.duration||0,disabled=!options.loaded()||options.recording();
      for(const id of ['blurTool','blurStrength','blurFeather','blurSeek','blurPlay'])$(id).disabled=disabled;
      $('blurDelete').disabled=disabled||!selected;
      $('blurStart').disabled=disabled||!selected;$('blurEnd').disabled=disabled||!selected;
      $('blurStartNow').disabled=disabled||!selected;$('blurEndNow').disabled=disabled||!selected;
      $('blurSelect').disabled=disabled||!regions.length;
      $('blurSeek').value=duration?Math.round(video.currentTime/duration*1000):0;
      $('blurTime').textContent=options.fmt(video.currentTime)+' / '+options.fmt(duration);
      $('blurPlay').textContent=options.playing()?'❚❚':'▶';
      $('blurStrengthValue').textContent=$('blurStrength').value+' px';$('blurFeatherValue').textContent=$('blurFeather').value+' px';
      $('blurCount').textContent=regions.length?`${regions.length} обл.`:'Необязательно';
      $('blurStatus').textContent=regions.length?'Выбери область в списке, чтобы изменить время или удалить её.':'Выбери форму и нарисуй область на кадре.';
      $('blurSelect').replaceChildren();
      regions.forEach((region,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`Область ${i+1} · ${region.type==='rect'?'прямоугольник':region.type==='ellipse'?'овал':'контур'}`;$('blurSelect').append(option);});
      if(selected){$('blurSelect').value=String(regions.indexOf(selected));$('blurStart').value=selected.start.toFixed(2);$('blurEnd').value=selected.end.toFixed(2);}
      else{$('blurStart').value='';$('blurEnd').value='';}
      $('blurStart').max=String(duration);$('blurEnd').max=String(duration);
    }
    function renderEditor(){
      if(!$('blurDetails').open||!options.loaded())return;
      const video=options.source();if(video.readyState<2||!video.videoWidth||!video.videoHeight)return;
      const scale=Math.min(1,640/video.videoWidth,640/video.videoHeight),w=Math.max(1,Math.round(video.videoWidth*scale)),h=Math.max(1,Math.round(video.videoHeight*scale));
      if(editor.width!==w||editor.height!==h){editor.width=w;editor.height=h;}
      ectx.drawImage(video,0,0,w,h);
      for(const region of [...regions,...(drawing?[drawing]:[])]){
        if(region.type==='free'&&region.points.length<2)continue;
        ectx.save();shape(ectx,region,w,h);ectx.fillStyle=region===selected?'#d4fa6444':'#ffc85033';ectx.fill();ectx.strokeStyle=region===selected?'#d4fa64':'#ffc850';ectx.lineWidth=2;ectx.stroke();ectx.restore();
      }
      $('blurSeek').value=video.duration?Math.round(video.currentTime/video.duration*1000):0;
      $('blurTime').textContent=options.fmt(video.currentTime)+' / '+options.fmt(video.duration);
      $('blurPlay').textContent=options.playing()?'❚❚':'▶';
    }
    function pixels(input,time){
      const video=options.source(),active=regions.filter(r=>time>=r.start&&time<r.end);
      if(!active.length||!video.videoWidth||!video.videoHeight)return input;
      const w=video.videoWidth,h=video.videoHeight,s=Math.min(.5,720/Math.max(w,h)),sw=Math.max(1,Math.round(w*s)),sh=Math.max(1,Math.round(h*s));
      if(result.width!==w||result.height!==h){result.width=w;result.height=h;}
      if(blurred.width!==sw||blurred.height!==sh){blurred.width=sw;blurred.height=sh;mask.width=sw;mask.height=sh;maskKey='';}
      const key=JSON.stringify([active,$('blurFeather').value,sw,sh]);
      if(key!==maskKey){
        mctx.clearRect(0,0,sw,sh);mctx.save();mctx.fillStyle='#fff';mctx.filter=`blur(${Number($('blurFeather').value)*s}px)`;
        for(const region of active){shape(mctx,region,sw,sh);mctx.fill();}mctx.restore();maskKey=key;
      }
      bctx.clearRect(0,0,sw,sh);bctx.save();bctx.filter=`blur(${Number($('blurStrength').value)*s}px)`;bctx.drawImage(input,0,0,sw,sh);bctx.restore();
      bctx.save();bctx.globalCompositeOperation='destination-in';bctx.drawImage(mask,0,0);bctx.restore();
      rctx.clearRect(0,0,w,h);rctx.drawImage(input,0,0,w,h);rctx.drawImage(blurred,0,0,w,h);return result;
    }
    editor.onpointerdown=e=>{
      if(!options.loaded()||options.recording()||(e.pointerType==='mouse'&&e.button!==0))return;
      e.preventDefault();options.pause();const p=point(e),type=$('blurTool').value;
      drawing={type,a:p,b:p,points:[p],start:0,end:options.source().duration};editor.setPointerCapture(e.pointerId);
    };
    editor.onpointermove=e=>{if(!drawing)return;const p=point(e);drawing.b=p;if(drawing.type==='free'&&drawing.points.length<500){const last=drawing.points[drawing.points.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)>.003)drawing.points.push(p);}};
    editor.onpointerup=e=>{
      if(!drawing)return;const region=drawing;drawing=null;
      if(region.type==='free'?region.points.length<3:Math.abs(region.b.x-region.a.x)<.01||Math.abs(region.b.y-region.a.y)<.01)return;
      regions.push(region);selected=region;maskKey='';update();
    };
    editor.onpointercancel=()=>{drawing=null;};
    $('blurSelect').onchange=()=>{selected=regions[Number($('blurSelect').value)]||null;update();};
    $('blurDelete').onclick=()=>{if(!selected||options.recording())return;regions=regions.filter(r=>r!==selected);selected=regions[0]||null;maskKey='';update();};
    function setTime(which,value){if(!selected||options.recording())return;const n=Number(value),d=options.source().duration;if(!Number.isFinite(n)||n<0||n>d||(which==='start'?n>=selected.end:n<=selected.start)){update();$('blurStatus').textContent='Начало должно быть раньше конца и находиться в пределах видео.';return;}selected[which]=n;maskKey='';update();}
    $('blurStart').onchange=()=>setTime('start',$('blurStart').value);
    $('blurEnd').onchange=()=>setTime('end',$('blurEnd').value);
    $('blurStartNow').onclick=()=>setTime('start',options.source().currentTime);
    $('blurEndNow').onclick=()=>setTime('end',options.source().currentTime);
    $('blurSeek').oninput=()=>options.seek(Number($('blurSeek').value)/1000*options.source().duration);
    $('blurPlay').onclick=()=>options.toggle();
    $('blurStrength').oninput=update;$('blurFeather').oninput=()=>{maskKey='';update();};
    return {pixels,renderEditor,update,reset(){regions=[];selected=null;drawing=null;maskKey='';update();}};
  }
  const api={create,shape};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SplitClipBlur=api;
})(typeof window!=='undefined'?window:globalThis);
