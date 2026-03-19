// Noise → Image Scrubber (robust)
(() => {
    const $$ = (id) => document.getElementById(id);
  
    const canvas = $$('c');
    const slider = $$('r');
    const playBtn = $$('play');
    const tlabel = $$('tlabel');
    const src = $$('src');
    const loadBtn = $$('load');
  
    let ctx, W=0, H=0;
    let img = null;            // HTMLImageElement
    let imgData = null;        // ImageData of the fitted image
    let noiseData = null;      // ImageData random noise
    let playing = false;
    let raf = null;
  
    // --- utils ---
    function log(...a){ console.log('[scrubber]', ...a); }
    function clamp01(x){ return Math.max(0, Math.min(1, x)); }
  
    // Resize canvas to CSS size (with DPR)
    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // fallbacks in case rect hasn’t laid out yet
      const cssW = rect.width || 960;
      const cssH = rect.height || Math.round(cssW * 9/16);
  
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
  
      if (!ctx) ctx = canvas.getContext('2d', { willReadFrequently: true });
      W = canvas.width; H = canvas.height;
  
      // Redraw buffers to new size
      if (img) drawImageContainToBuffer();
      makeNoise();
      redraw();
    }
  
    function drawImageContainToBuffer() {
      if (!img || !ctx) return;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (!iw || !ih) { log('image has no dimensions yet'); return; }
  
      const ir = iw/ih, cr = W/H;
      let w,h,x=0,y=0;
      if (ir > cr) { w = W; h = Math.round(W/ir); y = Math.round((H-h)/2); }
      else { h = H; w = Math.round(H*ir); x = Math.round((W-w)/2); }
  
      ctx.clearRect(0,0,W,H);
      ctx.drawImage(img, x, y, w, h);
      imgData = ctx.getImageData(0,0,W,H);
      log('img drawn into buffer', {W,H, iw, ih});
    }
  
    // Deterministic-ish noise so Play looks stable each load
    let seed = 1337;
    function rand() { seed = (seed*1664525 + 1013904223) >>> 0; return (seed & 0xffff) / 0xffff; }
  
    function makeNoise() {
      if (!ctx) return;
      noiseData = ctx.createImageData(W, H);
      const d = noiseData.data;
      for (let i=0; i<d.length; i+=4) {
        const v = (rand()*255)|0;
        d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
      }
    }
  
    function redraw() {
      if (!ctx) return;
      const t = clamp01(parseInt(slider.value,10)/1000);
      tlabel.textContent = 't = ' + t.toFixed(2);
  
      if (!imgData) {
        // show a neutral fill so “blank” is never truly blank
        ctx.fillStyle = '#111';
        ctx.fillRect(0,0,W,H);
        return;
      }
      if (!noiseData) makeNoise();
  
      const out = ctx.createImageData(W, H);
      const a = imgData.data, b = noiseData.data, o = out.data;
      // Mix: out = (1-t)*noise + t*image
      for (let i=0; i<o.length; i+=4) {
        o[i]   = (1-t)*b[i]   + t*a[i];
        o[i+1] = (1-t)*b[i+1] + t*a[i+1];
        o[i+2] = (1-t)*b[i+2] + t*a[i+2];
        o[i+3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    }
  
    function start() {
      if (playing) return;
      playing = true;
      playBtn.textContent = 'Pause';
      const step = () => {
        if (!playing) return;
        const v = (parseInt(slider.value,10)/1000 + 0.5/60) % 1; // 0.5 cycles/sec
        slider.value = Math.round(v*1000);
        redraw();
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    function stop() {
      playing = false;
      playBtn.textContent = 'Play';
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }
  
    function loadImage(url) {
      stop();
      const im = new Image();
      im.crossOrigin = 'anonymous';  // fine for same-origin too
      im.onload = () => {
        img = im;
        log('loaded', url, img.naturalWidth, img.naturalHeight);
        resizeCanvas();          // sizes + rebuilds buffers
        drawImageContainToBuffer();
        makeNoise();
        // Force t=1 draw so user can immediately see the original
        slider.value = 1000;
        redraw();
      };
      im.onerror = () => {
        console.error('Failed to load image:', url);
        alert('Failed to load image: ' + url);
      };
      im.src = url;
    }
  
    // --- events ---
    window.addEventListener('resize', resizeCanvas);
    slider.addEventListener('input', redraw);
    playBtn.addEventListener('click', () => (playing ? stop() : start()));
    loadBtn.addEventListener('click', () => loadImage(src.value.trim() || '/cover.jpg'));
  
    // --- init ---
    // default to a root image to avoid relative path mistakes
    if (!src.value) src.value = '/cover.jpg';
    loadImage(src.value);
  })();