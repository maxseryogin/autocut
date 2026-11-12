(function(root){
  // Chromakey that removes ONLY the green screen around the subject.
  //
  // Two things protect the subject (including green parts of it, like a green
  // banner on a green screen):
  //  1. The key is "how close is this pixel to the real screen colour", not
  //     "is this pixel green". The screen colour is measured from the frame
  //     border, and closeness is compared in brightness-independent chromaticity,
  //     so dark / teal / lighter greens of the subject are not treated as screen.
  //  2. Only key-coloured pixels connected to the frame border are removed
  //     (flood fill on a low-res mask), so green enclosed by the subject stays.
  //
  // Pass 1 (GPU, small framebuffer): downscaled copy of the frame.
  // JS: measure screen colour from the border, flood fill -> outside region.
  // Pass 2 (GPU, full res): key by chromaticity distance * outside region.
  //
  // Options for create():
  //   edgeOnly : true (default) - remove only screen connected to the frame edge;
  //              false          - remove every pixel close to the screen colour.
  //   keyColor : [r,g,b] 0..255 - fixed screen colour; by default it is measured
  //              from the border of every frame (falls back to pure green).
  //   maskSize : longer side of the low-res mask in px (default 256).
  //   grow     : mask pixels to expand the region by, so the soft edge and spill
  //              around the subject are removed too (default 1).

  const VERTEX = 'attribute vec2 p; attribute vec2 uv; varying vec2 v; void main(){gl_Position=vec4(p,0.0,1.0);v=uv;}';

  // Pass 1: average of 3x3 taps per mask pixel (avoids aliasing when downscaling).
  const FRAGMENT_MASK = `
    precision mediump float;
    uniform sampler2D image;
    uniform float flipBitmap;
    uniform vec2 tapStep;
    varying vec2 v;
    vec3 tap(vec2 o){
      vec2 u=v+o;
      return texture2D(image,vec2(u.x,mix(u.y,1.0-u.y,flipBitmap))).rgb;
    }
    void main(){
      vec3 s=vec3(0.0);
      for(int i=-1;i<=1;i++){
        for(int j=-1;j<=1;j++){
          s+=tap(vec2(float(i),float(j))*tapStep);
        }
      }
      gl_FragColor=vec4(s/9.0,1.0);
    }`;

  // Pass 2: final image. Key amount = closeness to the screen colour,
  // limited to the outside region.
  const FRAGMENT_FINAL = `
    precision mediump float;
    uniform sampler2D image;
    uniform sampler2D region;
    uniform vec3 keyColor;
    uniform float tolerance;
    uniform float flipBitmap;
    varying vec2 v;
    float keyAmount(vec4 c){
      float s=c.r+c.g+c.b;
      if(s*255.0<60.0)return 0.0;
      vec3 k=keyColor/max(keyColor.r+keyColor.g+keyColor.b,0.001);
      float d=distance(c.rgb/s,k);
      return clamp((tolerance-d)/(tolerance*0.6),0.0,1.0);
    }
    void main(){
      vec2 uv=vec2(v.x,mix(v.y,1.0-v.y,flipBitmap));
      vec4 c=texture2D(image,uv);
      float amount=keyAmount(c)*texture2D(region,v).r;
      c.a*=1.0-amount;
      if(amount>0.0&&amount<1.0)c.g-=max(c.g-max(c.r,c.b),0.0)*amount*0.55;
      gl_FragColor=c;
    }`;

  // strength 0..100 -> how far (in chromaticity) from the screen colour still counts as screen.
  function toleranceFor(strength){
    return 0.12+Math.max(0,Math.min(100,Number(strength)||0))*0.0025;
  }

  // Same maths as the shader. r,g,b and key are 0..255.
  function keyAmount(r,g,b,key,tolerance){
    const s=r+g+b;
    if(s<60)return 0;
    const ks=(key[0]+key[1]+key[2])||1;
    const dr=r/s-key[0]/ks,dg=g/s-key[1]/ks,db=b/s-key[2]/ks;
    const d=Math.sqrt(dr*dr+dg*dg+db*db);
    return Math.min(1,Math.max(0,(tolerance-d)/(tolerance*0.6)));
  }

  // Screen colour = per-channel median of green-dominant pixels on the frame border.
  // Returns null if the border has no green screen.
  function estimateKey(src,w,h){
    const R=[],G=[],B=[];
    function add(i){
      const o=i*4,r=src[o],g=src[o+1],b=src[o+2];
      if(g-Math.max(r,b)>=40){R.push(r);G.push(g);B.push(b);}
    }
    for(let x=0;x<w;x++){add(x);add((h-1)*w+x);}
    for(let y=1;y<h-1;y++){add(y*w);add(y*w+w-1);}
    if(R.length<8)return null;
    function median(a){a.sort((x,y)=>x-y);return a[a.length>>1];}
    return [median(R),median(G),median(B)];
  }

  function regionState(n){
    return {cand:new Uint8Array(n),reg:new Uint8Array(n),queue:new Int32Array(n)};
  }

  // src: RGBA bytes of the downscaled frame, row-major, w*h pixels.
  // out: RGBA bytes, R = 255 where the pixel is "outside screen".
  function buildRegion(src,w,h,grow,st,out,key,tolerance){
    const n=w*h,cand=st.cand,reg=st.reg,queue=st.queue;
    for(let i=0;i<n;i++){
      const o=i*4;
      cand[i]=keyAmount(src[o],src[o+1],src[o+2],key,tolerance)>=0.5?1:0;
      reg[i]=0;
    }
    let head=0,tail=0;
    function push(i){if(cand[i]&&!reg[i]){reg[i]=1;queue[tail++]=i;}}
    // seeds: every key-coloured pixel on the frame border
    for(let x=0;x<w;x++){push(x);push((h-1)*w+x);}
    for(let y=0;y<h;y++){push(y*w);push(y*w+w-1);}
    // 4-connected flood fill
    while(head<tail){
      const i=queue[head++],x=i%w;
      if(x>0)push(i-1);
      if(x<w-1)push(i+1);
      if(i>=w)push(i-w);
      if(i<n-w)push(i+w);
    }
    // expand the region so soft edges / spill next to the screen are covered
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i=y*w+x;
        let on=reg[i];
        if(!on&&grow>0){
          search:
          for(let dy=-grow;dy<=grow;dy++){
            const ny=y+dy;
            if(ny<0||ny>=h)continue;
            for(let dx=-grow;dx<=grow;dx++){
              const nx=x+dx;
              if(nx<0||nx>=w)continue;
              if(reg[ny*w+nx]){on=1;break search;}
            }
          }
        }
        const o=i*4,val=on?255:0;
        out[o]=val;out[o+1]=val;out[o+2]=val;out[o+3]=255;
      }
    }
  }

  function create(options){
    options=options||{};
    const edgeOnly=options.edgeOnly!==false;
    const fixedKey=Array.isArray(options.keyColor)&&options.keyColor.length>=3?options.keyColor:null;
    const maskSize=Math.max(32,options.maskSize||256);
    const grow=options.grow===undefined?1:Math.max(0,options.grow|0);

    const canvas=document.createElement('canvas');
    const gl=canvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
    if(!gl)return null;

    function shader(type,source){
      const result=gl.createShader(type);
      gl.shaderSource(result,source);
      gl.compileShader(result);
      if(!gl.getShaderParameter(result,gl.COMPILE_STATUS)){
        gl.deleteShader(result);
        throw new Error('Chromakey shader could not be compiled');
      }
      return result;
    }
    const vertex=shader(gl.VERTEX_SHADER,VERTEX);
    function program(fragmentSource){
      const pr=gl.createProgram();
      gl.attachShader(pr,vertex);
      gl.attachShader(pr,shader(gl.FRAGMENT_SHADER,fragmentSource));
      gl.bindAttribLocation(pr,0,'p');
      gl.bindAttribLocation(pr,1,'uv');
      gl.linkProgram(pr);
      if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error('Chromakey program could not be linked');
      return pr;
    }
    const maskProgram=program(FRAGMENT_MASK);
    const finalProgram=program(FRAGMENT_FINAL);

    const buffer=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,0, 1,-1,1,0, -1,1,0,1, 1,1,1,1]),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0,2,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1,2,gl.FLOAT,false,16,8);

    function texture(unit){
      const t=gl.createTexture();
      gl.activeTexture(gl.TEXTURE0+unit);
      gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      return t;
    }
    const videoTexture=texture(0);   // unit 0: source frame
    const regionTexture=texture(1);  // unit 1: "outside screen" mask
    const maskTexture=texture(2);    // unit 2: framebuffer target for pass 1 (never sampled)
    const whiteTexture=texture(3);   // unit 3: 1x1 white, used when edgeOnly=false
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
    const fbo=gl.createFramebuffer();

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);

    gl.useProgram(maskProgram);
    const maskU={
      flipBitmap:gl.getUniformLocation(maskProgram,'flipBitmap'),
      tapStep:gl.getUniformLocation(maskProgram,'tapStep')
    };
    gl.uniform1i(gl.getUniformLocation(maskProgram,'image'),0);
    gl.useProgram(finalProgram);
    const finalU={
      keyColor:gl.getUniformLocation(finalProgram,'keyColor'),
      tolerance:gl.getUniformLocation(finalProgram,'tolerance'),
      flipBitmap:gl.getUniformLocation(finalProgram,'flipBitmap')
    };
    gl.uniform1i(gl.getUniformLocation(finalProgram,'image'),0);
    gl.uniform1i(gl.getUniformLocation(finalProgram,'region'),1);

    const maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let textureWidth=0,textureHeight=0;
    let mw=0,mh=0,maskPixels=null,regionPixels=null,state=null;

    function resizeMask(width,height){
      const scale=maskSize/Math.max(width,height);
      const w=Math.max(4,Math.round(width*scale)),h=Math.max(4,Math.round(height*scale));
      if(w===mw&&h===mh)return;
      mw=w;mh=h;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D,maskTexture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,mw,mh,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,maskTexture,0);
      const ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if(!ok)throw new Error('Chromakey mask framebuffer is incomplete');
      maskPixels=new Uint8Array(mw*mh*4);
      regionPixels=new Uint8Array(mw*mh*4);
      state=regionState(mw*mh);
    }

    return {canvas,render(video,strength){
      if(gl.isContextLost())throw new Error('Chromakey context was lost');
      const width=video.videoWidth||video.width,height=video.videoHeight||video.height;
      if(!width||!height||width>maxTextureSize||height>maxTextureSize)throw new Error('Unsupported banner dimensions');
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}

      const tolerance=toleranceFor(strength);
      // UNPACK_FLIP_Y_WEBGL is ignored for ImageBitmap, unlike video/canvas.
      const flip=typeof ImageBitmap!=='undefined'&&video instanceof ImageBitmap?1:0;

      // upload the source frame
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,videoTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      if(textureWidth!==width||textureHeight!==height){
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);
        if(gl.getError()!==gl.NO_ERROR)throw new Error('Banner texture could not be uploaded');
        textureWidth=width;textureHeight=height;
      }else gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,video);

      // pass 1: low-res copy of the frame
      resizeMask(width,height);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.viewport(0,0,mw,mh);
      gl.useProgram(maskProgram);
      gl.uniform1f(maskU.flipBitmap,flip);
      gl.uniform2f(maskU.tapStep,1/(3*mw),1/(3*mh));
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      gl.readPixels(0,0,mw,mh,gl.RGBA,gl.UNSIGNED_BYTE,maskPixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);

      // screen colour: fixed, or measured from the frame border
      const key=fixedKey||estimateKey(maskPixels,mw,mh)||[0,255,0];

      gl.activeTexture(gl.TEXTURE1);
      if(edgeOnly){
        // flood fill from the frame border -> outside screen only
        buildRegion(maskPixels,mw,mh,grow,state,regionPixels,key,tolerance);
        gl.bindTexture(gl.TEXTURE_2D,regionTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false); // mask rows are already bottom-up
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,mw,mh,0,gl.RGBA,gl.UNSIGNED_BYTE,regionPixels);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      }else gl.bindTexture(gl.TEXTURE_2D,whiteTexture);

      // pass 2: full-res key limited to the outside region
      gl.viewport(0,0,width,height);
      gl.useProgram(finalProgram);
      gl.uniform1f(finalU.flipBitmap,flip);
      gl.uniform1f(finalU.tolerance,tolerance);
      gl.uniform3f(finalU.keyColor,key[0]/255,key[1]/255,key[2]/255);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      gl.flush();
    }};
  }

  root.SplitClipChroma={create,buildRegion,regionState,keyAmount,estimateKey,toleranceFor};
})(window);