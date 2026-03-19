/* Diffusion for Dummies – Interactives
 * - Forward process: x_t = sqrt(ᾱ_t) x0 + sqrt(1-ᾱ_t) ε   (t: 0→1 means clean→noise)
 * - Reverse (toy): iterative blur-as-denoiser to show the “feel” of stepping back.
 */

(function(){
    const IMG_SRC = "/cover.jpg"; // put a bright, high-contrast image here
  
    // ---------- helpers ----------
    const clamp01 = (x)=> Math.max(0, Math.min(1, x));
    const lerp = (a,b,t)=> a + (b-a)*t;
  
    function fitDraw(ctx, img, W, H){
      const iw=img.naturalWidth, ih=img.naturalHeight, ir=iw/ih, cr=W/H;
      let w,h,x=0,y=0;
      if (ir>cr){ w=W; h=Math.round(W/ir); y=(H-h)/2; }
      else { h=H; w=Math.round(H*ir); x=(W-w)/2; }
      ctx.clearRect(0,0,W,H);
      ctx.drawImage(img,x,y,w,h);
    }
  
    function imageDataFromImage(ctx, img){
      const {width:W, height:H} = ctx.canvas;
      fitDraw(ctx, img, W, H);
      return ctx.getImageData(0,0,W,H);
    }
  
    function makeGaussianNoise(W,H){
      const id = new ImageData(W,H);
      const d = id.data;
      for(let i=0;i<d.length;i+=4){
        const v = (Math.random()*255)|0;
        d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
      }
      return id;
    }
  
    // Blend: out = sqrt(aBar)*image + sqrt(1-aBar)*noise (per-channel, 0..255)
    function mixWithAlphaBar(out, clean, noise, aBar){
      const A = Math.sqrt(aBar), B = Math.sqrt(1-aBar);
      const o=out.data, c=clean.data, n=noise.data;
      for(let i=0;i<o.length;i+=4){
        o[i]   = A*c[i]   + B*n[i];
        o[i+1] = A*c[i+1] + B*n[i+1];
        o[i+2] = A*c[i+2] + B*n[i+2];
        o[i+3] = 255;
      }
    }
  
    // ---------- schedules ----------
    // β_t in [β_min, β_max], T steps. We map slider t∈[0,1] to step k = round(t*(T-1))
    function makeSchedule(T, kind="linear", betaMin=1e-4, betaMax=0.02){
      const beta = new Array(T);
      if (kind==="linear"){
        for(let t=0;t<T;t++){
          beta[t] = lerp(betaMin, betaMax, t/(T-1));
        }
      } else if (kind==="cosine"){
        // Nichol & Dhariwal cosine schedule (approximate, simple form)
        // ᾱ_t ≈ cos^2( (t/T + s)/(1+s) * π/2 ), with small s
        const s = 0.008;
        // We'll back out β from α via α = ᾱ_t / ᾱ_{t-1}
        const abar = new Array(T).fill(0);
        for(let t=0;t<T;t++){
          const ft = (t/T + s) / (1+s);
          abar[t] = Math.cos((ft*Math.PI)/2)**2;
        }
        for(let t=0;t<T;t++){
          const a = t===0 ? abar[0] : abar[t]/abar[t-1];
          beta[t] = 1 - a;
        }
      } else {
        throw new Error("unknown schedule: "+kind);
      }
      const alpha = beta.map(b=>1-b);
      const abar = new Array(T);
      let prod = 1;
      for(let t=0;t<T;t++){ prod *= alpha[t]; abar[t] = prod; }
      return {beta, alpha, abar};
    }
  
    // Draw ᾱ plot on a tiny canvas
    function plotAlphaBar(canvas, abar){
      const ctx = canvas.getContext("2d");
      const W=canvas.width, H=canvas.height;
      ctx.clearRect(0,0,W,H);
      ctx.fillStyle = "#0b0c12";
      ctx.fillRect(0,0,W,H);
      // axes
      ctx.strokeStyle="#2a2c33"; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(40,10); ctx.lineTo(40,H-20); ctx.lineTo(W-10,H-20); ctx.stroke();
      // curve
      ctx.strokeStyle="#7aa8ff"; ctx.lineWidth=2;
      ctx.beginPath();
      for(let i=0;i<abar.length;i++){
        const x = 40 + (i/(abar.length-1))*(W-50);
        const y = (H-20) - abar[i]*(H-30);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
      // labels
      ctx.fillStyle="#a9acb2"; ctx.font="12px ui-sans-serif";
      ctx.fillText("ᾱ", 8, 16);
      ctx.fillText("t", W-18, H-6);
    }
  
    // ---------- Intro: reverse intuition slider (0=noise, 1=image) ----------
    (function intro(){
      const c = document.getElementById("noiseCanvas");
      const s = document.getElementById("noiseSlider");
      if(!c || !s) return;
      const ctx = c.getContext("2d", {willReadFrequently:true});
      const W=c.width, H=c.height;
  
      const img = new Image();
      img.src = IMG_SRC;
      let cleanID=null, noiseID=null, out = new ImageData(W,H);
  
      function redraw(){
        if(!cleanID || !noiseID) return;
        const t = parseInt(s.value,10)/1000; // right = more image (reverse intuition)
        const aBar = t;                       // here we *treat* t as ᾱ for intuition
        mixWithAlphaBar(out, cleanID, noiseID, aBar);
        ctx.putImageData(out,0,0);
      }
  
      img.onload = ()=>{
        cleanID = imageDataFromImage(ctx, img);
        noiseID = makeGaussianNoise(W,H);
        s.value = 0; // start at pure noise feel
        redraw();
      };
      s.addEventListener("input", redraw);
    })();
  
    // ---------- Forward process (0=clean → 1=noise) with schedule + plot ----------
    (function forward(){
      const c = document.getElementById("forwardCanvas");
      const s = document.getElementById("forwardSlider");
      const sel = document.getElementById("schedule");
      const tLab = document.getElementById("tLabel");
      const plot = document.getElementById("schedulePlot");
      if(!c||!s||!sel||!tLab||!plot) return;
  
      const ctx = c.getContext("2d", {willReadFrequently:true});
      const W=c.width, H=c.height;
      const img = new Image(); img.src = IMG_SRC;
  
      const T = 100; // conceptual steps
      let sched = makeSchedule(T, sel.value);
      plotAlphaBar(plot, sched.abar);
  
      let cleanID=null, noiseID=null, out = new ImageData(W,H);
  
      function redraw(){
        if(!cleanID || !noiseID) return;
        const t = parseInt(s.value,10)/1000;        // right = MORE noise (correct forward)
        const k = Math.max(0, Math.min(T-1, Math.round(t*(T-1)))); // discrete step
        const aBar = sched.abar[k];
        tLab.textContent = `t = ${k} / ${T-1}`;
        mixWithAlphaBar(out, cleanID, noiseID, aBar);
        ctx.putImageData(out,0,0);
      }
  
      img.onload = ()=>{
        cleanID = imageDataFromImage(ctx, img);
        noiseID = makeGaussianNoise(W,H);
        s.value = 0; // t=0 clean
        redraw();
      };
      s.addEventListener("input", redraw);
      sel.addEventListener("change", ()=>{ sched = makeSchedule(T, sel.value); plotAlphaBar(plot, sched.abar); redraw(); });
    })();
  
    // ---------- Reverse process (toy denoiser) ----------
    (function reverseToy(){
      const c = document.getElementById("reverseCanvas");
      const btn = document.getElementById("reverseRun");
      const lab = document.getElementById("reverseLabel");
      if(!c||!btn||!lab) return;
  
      const ctx = c.getContext("2d", {willReadFrequently:true});
      const W=c.width, H=c.height;
      const img = new Image(); img.src = IMG_SRC;
  
      let x = null; // current image (ImageData)
  
      function put(id){ ctx.putImageData(id,0,0); }
      function cloneID(id){ return new ImageData(new Uint8ClampedArray(id.data), id.width, id.height); }
  
      // simple box blur acts as a "denoiser proxy"
      function blur1(id){
        const w=id.width,h=id.height, src=id.data, out=new ImageData(w,h), dst=out.data;
        const k=[1,1,1,1,1,1,1,1,1]; // 3x3 box
        for(let y=1;y<h-1;y++){
          for(let x=1;x<w-1;x++){
            let r=0,g=0,b=0, idx=0;
            for(let dy=-1; dy<=1; dy++){
              for(let dx=-1; dx<=1; dx++){
                const i=((y+dy)*w + (x+dx))*4;
                r+=src[i]; g+=src[i+1]; b+=src[i+2];
                idx++;
              }
            }
            const o=(y*w+x)*4;
            dst[o]=r/idx; dst[o+1]=g/idx; dst[o+2]=b/idx; dst[o+3]=255;
          }
        }
        return out;
      }
  
      function step(){
        // toy reverse: x_{t-1} ≈ blur(x_t)
        x = blur1(x);
        put(x);
      }
  
      img.onload = ()=>{
        // start from pure noise (x_T)
        x = makeGaussianNoise(W,H);
        lab.textContent = "status: noisy start (x_T)";
        put(x);
      };
  
      btn.addEventListener("click", async ()=>{
        lab.textContent = "status: running 25 toy steps…";
        for(let i=0;i<25;i++){
          await new Promise(r=>requestAnimationFrame(r));
          step();
        }
        lab.textContent = "status: finished 25 blur-steps (toy reverse)";
      });
    })();
  
  })();