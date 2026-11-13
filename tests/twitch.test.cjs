const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const elements=new Map();
function el(id){
  if(!elements.has(id)){
    const e={id,textContent:'',innerHTML:'',value:id==='twitchSpeed'?'1':'',hidden:false,disabled:false,dataset:{},listeners:{},paused:true,src:'',
      classList:{toggle(){}},setAttribute(k,v){this[k]=v},removeAttribute(k){if(k==='src')this.src=''},
      addEventListener(k,fn){(this.listeners[k]??=[]).push(fn)},load(){},pause(){this.paused=true;(this.listeners.pause||[]).forEach(fn=>fn())},
      play(){this.paused=false;(this.listeners.play||[]).forEach(fn=>fn());return Promise.resolve()},scrollIntoView(){}};
    elements.set(id,e);
  }
  return elements.get(id);
}
let clips=[{id:'123',title:'Первый клип',duration:33,status:'pending',url:'https://www.twitch.tv/a/clip/123'},
           {id:'456',title:'Избранный',duration:40,status:'approved',url:'https://www.twitch.tv/a/clip/456'}];
let loaded=null;
const window={SplitClipLoadSource:async v=>{loaded=v},SplitClipCanLoadSource:()=>true,pauseComposition(){}};
const fetch=async(url,opts={})=>{
  if(url==='/api/twitch/status')return {ok:true,status:200,json:async()=>({active:false,clips,message:'Готово'})};
  if(url==='/api/twitch/clips/123/select'){
    clips=clips.map(x=>x.id==='123'?{...x,status:'approved'}:x);
    return {ok:true,status:200,json:async()=>({url:'/media/123.mp4',name:'Первый клип'})};
  }
  throw new Error('Unexpected request '+url);
};
const sandbox={document:{getElementById:el},window,fetch,URL,console,setTimeout:()=>1,clearTimeout(){}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync('static/twitch.js','utf8'),sandbox);
const wait=()=>new Promise(r=>setImmediate(r));
(async()=>{
  await wait();await wait();
  assert.equal(el('twitchPendingCount').textContent,1);assert.equal(el('twitchApprovedCount').textContent,1);
  assert.equal(el('twitchVideo').src,'/api/twitch/clips/123/video');assert.equal(el('twitchTitle').textContent,'Первый клип');
  el('twitchSpeed').value='1.5';el('twitchSpeed').onchange();assert.equal(el('twitchVideo').playbackRate,1.5);
  await el('twitchSelect').onclick();assert.equal(loaded.url,'/media/123.mp4');
  assert.equal(el('twitchPendingCount').textContent,0);assert.equal(el('twitchApprovedCount').textContent,2);
  el('twitchApproved').onclick();assert.equal(el('twitchVideo').src,'/api/twitch/clips/123/video');
  console.log('OK: Twitch picker, speed, selecting a clip and preserving favorites');
})().catch(e=>{console.error(e);process.exitCode=1});
