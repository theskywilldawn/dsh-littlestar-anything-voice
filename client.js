/**
 * dsh-littlestar-anything-voice —— 前端挂件（client bundle）
 *
 * 以 dsh.client bundle 格式加载（同 dsh-ime-selection-fix / dsh-meme）：
 *   package.json 需要 exports["./client"] + dsh.client.platform = "web"
 *   id 必须等于插件包名，否则 ModuleLoader 报 "loaded without registering ..."
 */
window.__ModuleLoader__.load({
  id: 'dsh-littlestar-anything-voice',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

;(function () {
  'use strict'
  if (window.__littlestarVoiceLoaded) return
  window.__littlestarVoiceLoaded = true

  const ROUTE = '/littlestar-voice'
  const POS_KEY = 'littlestar-voice:pos'
  const POLL_MS = 1200

  // ── 藏掉原版「自动朗读」按钮 ──────────────────────────────────────
  // 原插件用 React 渲染在 composer 工具条里，找不到稳定 class，
  // 所以按可见文字匹配：中文「自动朗读」/ 英文 Auto-read。
  const HIDE_TEXT = /^(自动朗读|Auto[- ]?read)$/i
  function hideLegacyButton() {
    try {
      const nodes = document.querySelectorAll('button, [role="button"], [role="switch"]')
      for (const el of nodes) {
        const t = (el.textContent || '').replace(/\s+/g, '')
        if (!t) continue
        if (HIDE_TEXT.test(t) || t === '自动朗读' || /^自动朗读/.test(t)) {
          if (el.dataset.lsvHidden === '1') continue
          el.dataset.lsvHidden = '1'
          el.style.display = 'none'
          el.setAttribute('aria-hidden', 'true')
        }
      }
    } catch { /* DOM 结构变了也不该影响别的 */ }
  }
  const mo = new MutationObserver(() => hideLegacyButton())
  const startHideLoop = () => {
    try {
      mo.observe(document.body, { childList: true, subtree: true })
      hideLegacyButton()
      setInterval(hideLegacyButton, 2000)
    } catch { /* ignore */ }
  }
  if (document.body) startLoopSafe()
  else document.addEventListener('DOMContentLoaded', startLoopSafe)
  function startLoopSafe() { setTimeout(startHideLoop, 800) }

  // ── 宿主容器 ──────────────────────────────────────────────────────
  const host = document.createElement('div')
  host.id = 'littlestar-voice-host'
  host.style.cssText = 'position:fixed;z-index:2147483000;right:22px;bottom:118px;user-select:none;'
  const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host

  const style = document.createElement('style')
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .wrap { position: relative; display: flex; flex-direction: column; align-items: center; }

    .pet {
      cursor: pointer; position: relative;
      transition: transform .18s cubic-bezier(.34,1.56,.64,1), filter .25s, opacity .25s;
      filter: drop-shadow(0 6px 16px rgba(0,0,0,.34));
      -webkit-tap-highlight-color: transparent;
    }
    .pet:hover { transform: translateY(-3px) scale(1.05); }
    .pet:active { transform: translateY(0) scale(.97); }
    .pet.bobbing { animation: bob 1.9s ease-in-out infinite; }
    @keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
    .pet img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
    .pet .fallback {
      width: 100%; height: 100%; border-radius: 50%;
      background: linear-gradient(160deg,#5b8cff,#8a63d2);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3px; color: #fff; text-align: center; padding: 0 8%;
    }
    .fallback .fb-char { font-size: 34px; line-height: 1; opacity: .94; }
    /* 没图时的那行小字（哥哥要的「本角色暂无图片，请添加」） */
    .fallback .fb-tip { font-size: 10px; line-height: 1.3; opacity: .82; letter-spacing: .2px; }
    .pet.off img { filter: grayscale(.85) brightness(.85); }
    .pet.off::after {
      content: ''; position: absolute; left: 10%; right: 10%; top: 50%;
      height: 3px; background: rgba(255,255,255,.85); border-radius: 2px;
      transform: rotate(-28deg); box-shadow: 0 0 5px rgba(0,0,0,.5);
    }
    /* 服务离线不再画那圈旋转红虚线（哥哥嫌一直转着难看），只靠下面那个红点提示 */

    /* ── 收起：缩成一枚圆形角标，点一下再展开 ─────────────────── */
    /* 常显不靠 hover —— 之前做成悬停才出现，哥哥根本没找到它。
       挪到左上角：右上角让给状态点，两个小圆才不会叠在一起。 */
    .collapse {
      position: absolute; left: -6px; top: -6px; z-index: 5;
      width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(circle at 34% 28%, rgba(92,124,186,.98), rgba(16,22,34,.98));
      border: 1px solid rgba(170,206,255,.8);
      box-shadow: 0 2px 10px rgba(0,0,0,.55), 0 0 0 3px rgba(120,170,255,.12),
                  inset 0 1px 0 rgba(255,255,255,.22);
      cursor: pointer; opacity: .92;
      transition: opacity .18s, transform .18s, box-shadow .18s;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      user-select: none;
    }
    .wrap:hover .collapse { opacity: 1; }
    .collapse::before {
      content: ''; width: 9px; height: 2px; border-radius: 2px;
      background: #cfe0ff; box-shadow: 0 0 6px rgba(150,190,255,.85);
    }
    .collapse:hover {
      transform: scale(1.18);
      box-shadow: 0 3px 12px rgba(110,160,255,.6), inset 0 1px 0 rgba(255,255,255,.24);
    }
    .wrap.collapsed .collapse { display: none; }

    /* 收起态：一枚圆头像，右下角挂状态点 */
    .wrap.collapsed .pet {
      width: 48px !important; height: 48px !important;
      border-radius: 50%; overflow: hidden;
      background: radial-gradient(circle at 50% 30%, #24314a, #10151f);
      box-shadow: 0 0 0 2px rgba(120,170,255,.38), 0 4px 14px rgba(0,0,0,.55);
    }
    .wrap.collapsed .pet:hover { transform: scale(1.06); }
    .wrap.collapsed .pet img { object-fit: cover; object-position: center 22%; }
    .wrap.collapsed .pet .fallback { border-radius: 50%; }
    .wrap.collapsed .pet .fallback .fb-char { font-size: 16px; }
    .wrap.collapsed .pet .fallback .fb-tip { display: none; }
    .wrap.collapsed .pet.off::after { display: none; }
    .wrap.collapsed .dot {
      display: block; position: absolute;
      right: 1px; bottom: 1px; top: auto; margin: 0;
      width: 10px; height: 10px;
      border: 2px solid rgba(14,19,30,.92);
      z-index: 4;
    }

    /* 状态点：贴着立绘右上角。原来吊在图片下方、还带 5px 间距，离得太远。 */
    .dot {
      position: absolute; right: 2px; top: 2px; z-index: 4;
      width: 10px; height: 10px; border-radius: 50%;
      border: 2px solid rgba(14,19,30,.9);
      background: #7fe38a;
      box-shadow: 0 0 8px rgba(127,227,138,.95);
      transition: background .2s, box-shadow .2s;
      pointer-events: none;
    }
    .dot.idle { background: #6b7280; box-shadow: none; }
    .dot.err  { background: #ff6b6b; box-shadow: 0 0 8px rgba(255,107,107,.95); }
    .dot.busy { background: #ffc857; box-shadow: 0 0 8px rgba(255,200,87,.95); animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }

    /* 面板位置由 JS 现算（图片在上半屏就往下展开，反之往上），
       所以这里不写死 bottom，只留宽度/外观。 */
    .panel {
      position: absolute; right: 0;
      width: 296px; max-height: 74vh; overflow-y: auto;
      padding: 12px 14px 14px;
      background: rgba(18,22,32,.95);
      border: 1px solid rgba(120,170,255,.3);
      border-radius: 14px;
      color: #d8e4f5; font: 12px/1.65 system-ui, "Segoe UI", sans-serif;
      backdrop-filter: blur(14px);
      box-shadow: 0 18px 48px rgba(0,0,0,.55);
      display: none;
    }
    .panel.show { display: block; }
    .panel h3 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: #9fc4ff; letter-spacing: .3px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 7px 0; }
    .row .k { color: #8fa3bd; }
    .row .v { color: #7fd3ff; font-variant-numeric: tabular-nums; }
    .v.ok { color: #7fe38a; }
    .v.bad { color: #ff8f8f; }
    .sec { margin: 12px 0 4px; padding-top: 10px; border-top: 1px solid rgba(120,170,255,.16); font-size: 11px; color: #7f93ad; letter-spacing: .5px; }
    select, input.txt {
      width: 100%; margin: 4px 0 6px; padding: 5px 8px;
      background: #1b2231; border: 1px solid rgba(120,170,255,.3);
      border-radius: 8px; color: #d8e4f5; outline: none; font: inherit;
    }
    input.txt::placeholder { color: #5d6f88; }
    input[type=range] { width: 100%; accent-color: #5b9dff; height: 16px; }
    .btns { display: flex; gap: 8px; margin-top: 10px; }
    button {
      flex: 1; padding: 6px 8px; cursor: pointer; font: inherit;
      background: rgba(91,157,255,.18);
      border: 1px solid rgba(91,157,255,.42);
      border-radius: 8px; color: #bcd8ff;
      transition: background .15s;
    }
    button:hover { background: rgba(91,157,255,.32); }
    button:disabled { opacity: .42; cursor: default; }
    .hint { margin-top: 9px; color: #6b7d97; font-size: 11px; line-height: 1.5; }
    .err { margin-top: 6px; color: #ff9d9d; font-size: 11px; word-break: break-all; }
    .chk { display: flex; align-items: center; gap: 6px; margin: 6px 0; color: #9fb3cc; }
    .chk input { accent-color: #5b9dff; }
  `

  const wrap = document.createElement('div')
  wrap.className = 'wrap'

  const pet = document.createElement('div')
  pet.className = 'pet off'
  pet.title = '左键：开关朗读 · 右键：设置'

  const img = document.createElement('img')
  img.alt = ''
  img.style.display = 'none'

  // 没有立绘时的占位：角色名首字 + 一行提示。音频才是必需项，图片可以后补。
  const fallback = document.createElement('div')
  fallback.className = 'fallback'
  const fbChar = document.createElement('div')
  fbChar.className = 'fb-char'
  fbChar.textContent = '声'
  const fbTip = document.createElement('div')
  fbTip.className = 'fb-tip'
  fbTip.textContent = '本角色暂无图片，请添加'
  fallback.appendChild(fbChar)
  fallback.appendChild(fbTip)

  pet.appendChild(fallback)
  pet.appendChild(img)

  const dot = document.createElement('div')
  dot.className = 'dot idle'

  // 收起角标：悬停立绘右上角出现，点它缩成小块；点小块再展开.
  const COLLAPSE_KEY = 'littlestar-voice:collapsed'
  const collapseBtn = document.createElement('div')
  collapseBtn.className = 'collapse'
  collapseBtn.title = '收起成角标'

  wrap.appendChild(pet)
  wrap.appendChild(dot)
  wrap.appendChild(collapseBtn)

  const setCollapsed = (v) => {
    wrap.classList.toggle('collapsed', !!v)
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0') } catch { /* ignore */ }
    // 48 ↔ 200 的尺寸切换会让贴边的位置越界，下一帧收回来
    requestAnimationFrame(clampHost)
  }
  try { if (localStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(true) } catch { /* ignore */ }
  collapseBtn.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation()
    ev.preventDefault()
    setCollapsed(true)
  })

  // ── 面板 ─────────────────────────────────────────────────────────
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML = `
    <h3>任意语音</h3>
    <div class="row"><span class="k">状态</span><span class="v" data-f="state">—</span></div>
    <div class="row"><span class="k">本地服务</span><span class="v" data-f="svc">—</span></div>
    <label class="chk"><input type="checkbox" data-f="hidecmd"> 启用时隐藏 CMD 窗口</label>

    <div class="sec">角色</div>
    <select data-f="chars"></select>
    <div class="btns" style="margin-top:2px">
      <button data-f="scan">扫描角色目录</button>
    </div>
    <div class="hint" data-f="scanout" style="margin-top:6px">音色放 <b>voices/</b>，图片放 <b>avatars/</b>，同名即配对</div>

    <div class="sec">添加角色</div>
    <input type="text" class="txt" data-f="newname" placeholder="角色名（留空就用文件名）">
    <div class="btns">
      <button data-f="impvoice">导入音色…</button>
      <button data-f="impimg">导入图片…</button>
    </div>
    <input type="file" data-f="filevoice" accept="audio/*" style="display:none">
    <input type="file" data-f="fileimg" accept="image/*" style="display:none">

    <div class="sec">外观</div>
    <div class="row"><span class="k">不透明度</span><span class="v" data-f="opv">0.88</span></div>
    <input type="range" data-f="op" min="0.15" max="1" step="0.02" value="0.88">
    <div class="row"><span class="k">大小</span><span class="v" data-f="szv">104</span></div>
    <input type="range" data-f="sz" min="64" max="300" step="4" value="104">

    <div class="sec">朗读</div>
    <div class="row"><span class="k">音量</span><span class="v" data-f="volv">1.00</span></div>
    <input type="range" data-f="vol" min="0" max="1" step="0.05" value="1">
    <div class="row"><span class="k">语速</span><span class="v" data-f="spdv">1.00</span></div>
    <input type="range" data-f="spd" min="0.6" max="1.6" step="0.05" value="1">
    <div class="row"><span class="k">句间停顿</span><span class="v" data-f="gapv">350</span></div>
    <input type="range" data-f="gap" min="0" max="1500" step="50" value="350">
    <div class="row"><span class="k">太长不读</span><span class="v" data-f="ltv">500 字</span></div>
    <input type="range" data-f="lt" min="0" max="500" step="10" value="500">
    <div class="hint" style="margin:-2px 0 4px">本条回答超过这个字数就整条不念（0 = 不限；手动「说一句」不受限）</div>

    <div class="sec">情绪</div>
    <label class="chk"><input type="checkbox" data-f="auto" checked> 自动按文本选情绪</label>
    <select data-f="emo"></select>

    <div class="btns">
      <button data-f="say">说一句</button>
      <button data-f="start">启动服务</button>
    </div>
    <div class="hint">左键点立绘开关 · 右键/Shift+点开这个面板 · 可拖动</div>
    <div class="err" data-f="errtxt"></div>
  `
  wrap.appendChild(panel)
  shadow.appendChild(style)
  shadow.appendChild(wrap)
  // 注入的脚本是 async 的，可能在 <body> 还没解析出来时就执行；
  // 那时直接 append 会抛 TypeError，把整个 IIFE 打断 —— 挂件从此不出现。
  const mount = () => {
    try {
      if (!document.body) return false
      const added = !document.body.contains(host)
      if (added) document.body.appendChild(host)
      // 刚挂上时量不到尺寸，所以位置修正要等下一帧
      if (added) requestAnimationFrame(clampHost)
      return true
    } catch { return false }
  }
  if (!mount()) {
    let tries = 0
    const timer = setInterval(() => {
      if (mount() || ++tries > 200) clearInterval(timer)
    }, 100)
  }
  // SPA 重渲染偶尔会把 body 清空，兜一层
  setInterval(mount, 2000)

  const $ = (s) => panel.querySelector(s)
  const stateEl = $('[data-f="state"]')
  const svcEl = $('[data-f="svc"]')
  const charsSel = $('[data-f="chars"]')
  const opEl = $('[data-f="op"]'); const opvEl = $('[data-f="opv"]')
  const szEl = $('[data-f="sz"]'); const szvEl = $('[data-f="szv"]')
  const volEl = $('[data-f="vol"]'); const volvEl = $('[data-f="volv"]')
  const spdEl = $('[data-f="spd"]'); const spdvEl = $('[data-f="spdv"]')
  const gapEl = $('[data-f="gap"]'); const gapvEl = $('[data-f="gapv"]')
  const ltEl = $('[data-f="lt"]'); const ltvEl = $('[data-f="ltv"]')
  const autoEl = $('[data-f="auto"]')
  const hideCmdEl = $('[data-f="hidecmd"]')
  const emoSel = $('[data-f="emo"]')
  const sayBtn = $('[data-f="say"]')
  const startBtn = $('[data-f="start"]')
  const errEl = $('[data-f="errtxt"]')
  // 添加角色那一组
  const scanBtn = $('[data-f="scan"]')
  const scanOut = $('[data-f="scanout"]')
  const newNameEl = $('[data-f="newname"]')
  const impVoiceBtn = $('[data-f="impvoice"]')
  const impImgBtn = $('[data-f="impimg"]')
  const fileVoiceEl = $('[data-f="filevoice"]')
  const fileImgEl = $('[data-f="fileimg"]')

  const S = {
    enabled: false, current: '', characters: [], emotions: [], service: false,
    playing: false, volume: 1, gapMs: 350, opacity: 0.88, size: 104, autoEmotion: true, emotion: '',
    maxSpeakChars: 500,
  }

  // ── 面板：按立绘在屏幕的位置决定往上还是往下展开 ────────────────
  // 图片在上半屏 → 面板向下展开；在下半屏 → 向上展开；左右也夹一下别跑出屏幕。
  function positionPanel() {
    const r = pet.getBoundingClientRect()
    const vh = window.innerHeight
    const down = r.top + r.height / 2 < vh / 2
    panel.style.top = down ? 'calc(100% + 12px)' : 'auto'
    panel.style.bottom = down ? 'auto' : 'calc(100% + 12px)'
    // 可用高度：往下展开看图片下沿到屏幕底还剩多少，反之看图片上沿以上
    const avail = down ? vh - r.bottom - 24 : r.top - 24
    panel.style.maxHeight = `${Math.max(200, Math.min(vh * 0.74, avail))}px`
    // 面板宽 296：贴着左边时改成往右展开，免得左半截跑到屏幕外
    if (r.left < 320) { panel.style.left = '0'; panel.style.right = 'auto' }
    else { panel.style.left = 'auto'; panel.style.right = '0' }
  }

  function setPanel(open) {
    if (open === panel.classList.contains('show')) return
    if (open) {
      positionPanel()
      panel.classList.add('show')
      // 滚动条出现后几何会变，下一帧再校一次
      requestAnimationFrame(positionPanel)
    } else {
      panel.classList.remove('show')
    }
  }

  // 「太长不读」阈值：0 表示不限
  const fmtTooLong = (v) => (v > 0 ? `${Math.round(v)} 字` : '不限')

  function setError(msg) { errEl.textContent = msg || '' }
  function setOpacity(v) { pet.style.opacity = String(v) }
  function setSize(v) {
    const changed = pet.style.width !== `${v}px`
    pet.style.width = `${v}px`; pet.style.height = `${v}px`
    if (changed) requestAnimationFrame(clampHost)
  }

  // 挂件尺寸变了（收起 48 / 展开 200 / 拖动滑块改大小）后，把越界的边收回来，
  // 否则贴着底部改大就会有一截伸出屏幕。
  function clampHost() {
    const r = host.getBoundingClientRect()
    if (!r.width || !r.height) return
    const maxL = Math.max(0, window.innerWidth - r.width)
    const maxT = Math.max(0, window.innerHeight - r.height)
    if (r.left > maxL || r.left < 0) {
      host.style.right = 'auto'
      host.style.left = `${Math.round(Math.max(0, Math.min(maxL, r.left)))}px`
    }
    if (r.top > maxT || r.top < 0) {
      host.style.bottom = 'auto'
      host.style.top = `${Math.round(Math.max(0, Math.min(maxT, r.top)))}px`
    }
  }

  function applyPos(pos) {
    if (!pos) return
    if (typeof pos.left === 'number') { host.style.right = 'auto'; host.style.left = `${Math.round(pos.left)}px` }
    if (typeof pos.bottom === 'number') host.style.bottom = `${Math.round(pos.bottom)}px`
  }
  try { applyPos(JSON.parse(localStorage.getItem(POS_KEY) || 'null')) } catch { /* ignore */ }
  function savePos() {
    const r = host.getBoundingClientRect()
    try { localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, bottom: window.innerHeight - r.bottom })) } catch { /* ignore */ }
  }

  // ── 音频播放 ──────────────────────────────────────────────────────
  let audioCtx = null
  let currentSource = null
  let queueBusy = false

  function ensureAudio() {
    if (!audioCtx) {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        audioCtx = Ctor ? new Ctor() : null
      } catch { audioCtx = null }
    }
    return audioCtx
  }
  // 浏览器自动播放策略：AudioContext 要在用户手势里创建/恢复，
  // 否则第一次朗读会永远卡在 await resume() 上，整条队列就此不动。
  const unlockAudio = () => {
    const a = ensureAudio()
    if (a && a.state === 'suspended') a.resume().catch(() => {})
  }
  for (const ev of ['pointerdown', 'keydown', 'click']) {
    try { window.addEventListener(ev, unlockAudio, { capture: true, passive: true }) } catch { /* ignore */ }
  }

  function stopAudio() {
    try { currentSource?.stop() } catch { /* ignore */ }
    currentSource = null
    S.playing = false
    updatePet()
  }

  function playUrl(url, gapMs) {
    return new Promise((resolve) => {
      ;(async () => {
        try {
          const ac = ensureAudio()
          if (!ac) throw new Error('AudioContext 不可用')
          if (ac.state === 'suspended') {
            // 带超时：宁可这次没声，也不能把整条队列卡死
            await Promise.race([
              ac.resume().catch(() => {}),
              new Promise((r) => setTimeout(r, 400)),
            ])
          }
          const resp = await fetch(url, { cache: 'no-store' })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const buf = await resp.arrayBuffer()
          const audio = await ac.decodeAudioData(buf)
          const src = ac.createBufferSource()
          const gain = ac.createGain()
          gain.gain.value = S.volume
          src.buffer = audio
          src.connect(gain).connect(ac.destination)
          S.playing = true
          updatePet()
          src.onended = () => {
            S.playing = false
            currentSource = null
            updatePet()
            // 句间停顿
            setTimeout(resolve, Math.max(0, Number(gapMs) || 0))
          }
          currentSource = src
          src.start()
        } catch (e) {
          S.playing = false
          updatePet()
          setError(`播放失败：${e.message}`)
          resolve()
        }
      })()
    })
  }

  async function drainQueue() {
    if (queueBusy) return
    queueBusy = true
    try {
      // 一次最多连播 12 段，避免某次积压把界面卡住
      for (let i = 0; i < 12; i++) {
        if (!S.enabled) break
        const r = await fetch(`${ROUTE}/next`, { cache: 'no-store' })
        const j = await r.json()
        if (!j || !j.url) break
        await playUrl(j.url, j.gapMs)
      }
    } catch { /* 网络抖动忽略 */ }
    finally { queueBusy = false }
  }
  setInterval(drainQueue, POLL_MS)

  // ── UI ────────────────────────────────────────────────────────────
  function updatePet() {
    pet.classList.toggle('off', !S.enabled)
    pet.classList.toggle('bobbing', !!S.enabled && S.playing)
    dot.className = 'dot'
    if (!S.service) dot.classList.add('err')
    else if (S.playing) dot.classList.add('busy')
    else if (!S.enabled) dot.classList.add('idle')
    stateEl.textContent = S.enabled ? (S.playing ? '朗读中' : '已开启') : '已关闭'
    svcEl.textContent = S.service ? '在线' : '未启动'
    svcEl.className = 'v ' + (S.service ? 'ok' : 'bad')
    setOpacity(S.opacity)
    setSize(S.size)
  }

  function renderChars() {
    charsSel.innerHTML = ''
    if (!S.characters.length) {
      const o = document.createElement('option')
      o.value = ''; o.textContent = '（还没有角色）'
      charsSel.appendChild(o)
      return
    }
    for (const c of S.characters) {
      const o = document.createElement('option')
      o.value = c.id
      o.textContent = c.hasRef ? c.name : `${c.name}（缺参考音频）`
      if (c.id === S.current) o.selected = true
      charsSel.appendChild(o)
    }
  }

  function renderEmotions() {
    emoSel.innerHTML = ''
    const o0 = document.createElement('option')
    o0.value = ''; o0.textContent = '原声（不加情绪）'
    emoSel.appendChild(o0)
    for (const e of S.emotions) {
      const o = document.createElement('option')
      o.value = e; o.textContent = e
      emoSel.appendChild(o)
    }
    emoSel.value = S.emotion || ''
    emoSel.disabled = !!S.autoEmotion
    emoSel.style.opacity = S.autoEmotion ? '.45' : '1'
  }

  /** 没立绘就用占位：角色名首字 + 一行提示。音频是必需项，图片可以后补。 */
  function showFallback(cur) {
    img.style.display = 'none'
    fallback.style.display = 'flex'
    fbChar.textContent = cur ? ((cur.name || '声')[0] || '声') : '声'
    fbTip.textContent = cur ? '本角色暂无图片，请添加' : '还没有角色，把音频放进 voices/'
  }

  function applyAvatar() {
    const cur = S.characters.find((c) => c.id === S.current)
    if (cur && cur.hasAvatar) {
      img.onerror = () => showFallback(cur)
      img.src = `${ROUTE}/avatar/${encodeURIComponent(cur.id)}?v=${Date.now()}`
      img.style.display = 'block'
      fallback.style.display = 'none'
    } else {
      showFallback(cur)
    }
  }

  async function refresh() {
    try {
      const r = await fetch(`${ROUTE}/state`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`state ${r.status}`)
      const j = await r.json()
      const changed = j.current !== S.current
        || j.characters.length !== S.characters.length
        || j.emotions?.length !== S.emotions.length
      S.enabled = !!j.enabled
      S.current = j.current || ''
      S.characters = Array.isArray(j.characters) ? j.characters : []
      S.emotions = Array.isArray(j.emotions) ? j.emotions : []
      S.service = !!j.service
      S.volume = typeof j.volume === 'number' ? j.volume : 1
      S.gapMs = typeof j.gapMs === 'number' ? j.gapMs : 350
      S.opacity = typeof j.opacity === 'number' ? j.opacity : 0.88
      S.size = typeof j.size === 'number' ? j.size : 104
      S.autoEmotion = !!j.autoEmotion
      S.emotion = j.emotion || ''

      volEl.value = String(S.volume); volvEl.textContent = S.volume.toFixed(2)
      spdEl.value = String(j.speed ?? 1); spdvEl.textContent = Number(j.speed ?? 1).toFixed(2)
      gapEl.value = String(S.gapMs); gapvEl.textContent = String(Math.round(S.gapMs))
      // 滑块范围 0–500，超出范围的历史值夹回来，免得滑块和数字对不上
      S.maxSpeakChars = Math.max(0, Math.min(500, typeof j.maxSpeakChars === 'number' ? j.maxSpeakChars : 500))
      ltEl.value = String(S.maxSpeakChars)
      ltvEl.textContent = fmtTooLong(S.maxSpeakChars)
      opEl.value = String(S.opacity); opvEl.textContent = S.opacity.toFixed(2)
      szEl.value = String(S.size); szvEl.textContent = String(S.size)
      autoEl.checked = S.autoEmotion
      hideCmdEl.checked = !!j.hideCmdWindow

      if (changed) { renderChars(); renderEmotions(); applyAvatar() }
      else { if (!emoSel.options.length) renderEmotions() }
      updatePet()
      setError('')
    } catch (e) {
      S.service = false
      updatePet()
      setError(`连不上宿主：${e.message}`)
    }
  }
  refresh()
  setInterval(refresh, 5000)

  // ── 交互 ─────────────────────────────────────────────────────────
  let drag = null
  let suppressClick = false

  pet.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return
    const r = host.getBoundingClientRect()
    // ★ 拖动边界要用**当前实际尺寸**：收起态只有 48px，而 S.size 是展开时的 200px。
    //   以前一直拿 S.size 夹，小球就被卡在离底 200px 处拖不下去。
    drag = {
      dx: ev.clientX - r.left, dy: ev.clientY - r.top,
      w: r.width || S.size, h: r.height || S.size,
      moved: false, sx: ev.clientX, sy: ev.clientY,
    }
    pet.setPointerCapture?.(ev.pointerId)
  })
  pet.addEventListener('pointermove', (ev) => {
    if (!drag) return
    if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return
    drag.moved = true
    const left = Math.max(0, Math.min(window.innerWidth - drag.w, ev.clientX - drag.dx))
    const top = Math.max(0, Math.min(window.innerHeight - drag.h, ev.clientY - drag.dy))
    host.style.right = 'auto'
    host.style.left = `${Math.round(left)}px`
    host.style.top = `${Math.round(top)}px`
    host.style.bottom = 'auto'
  })
  pet.addEventListener('pointerup', async (ev) => {
    if (!drag) return
    const moved = drag.moved
    drag = null
    if (moved) { savePos(); suppressClick = true; setTimeout(() => { suppressClick = false }, 60); return }
    if (ev.shiftKey) { setPanel(!panel.classList.contains('show')); return }
    if (suppressClick) return
    // 收起状态下点它就是展开，别去 toggle 朗读
    if (wrap.classList.contains('collapsed')) { setCollapsed(false); return }
    try {
      const r = await fetch(`${ROUTE}/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json()
      S.enabled = !!j.enabled
      if (!S.enabled) stopAudio()
      if (j.launched) setError('正在拉起 IndexTTS，首次要等几十秒…')
      updatePet()
    } catch { setError('开关失败') }
  })
  pet.addEventListener('contextmenu', (ev) => { ev.preventDefault(); setPanel(!panel.classList.contains('show')) })

  charsSel.addEventListener('change', async () => {
    const id = charsSel.value
    try {
      const r = await fetch(`${ROUTE}/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      const j = await r.json()
      if (j.ok) { S.current = id; applyAvatar() } else setError(j.error || '切换失败')
    } catch { setError('切换失败') }
  })

  // 滑块通用：本地即时反馈 + 防抖落盘
  function bindSlider(el, valEl, fmt, key, after) {
    let timer = null
    el.addEventListener('input', () => {
      const v = parseFloat(el.value)
      valEl.textContent = fmt(v)
      after?.(v)
      clearTimeout(timer)
      timer = setTimeout(() => {
        fetch(`${ROUTE}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: v }) }).catch(() => {})
      }, 260)
    })
  }
  bindSlider(opEl, opvEl, (v) => v.toFixed(2), 'opacity', (v) => { S.opacity = v; setOpacity(v) })
  bindSlider(szEl, szvEl, (v) => String(Math.round(v)), 'size', (v) => { S.size = Math.round(v); setSize(v) })
  bindSlider(volEl, volvEl, (v) => v.toFixed(2), 'volume', (v) => { S.volume = v })
  bindSlider(spdEl, spdvEl, (v) => v.toFixed(2), 'speed', () => {})
  bindSlider(gapEl, gapvEl, (v) => String(Math.round(v)), 'gapMs', (v) => { S.gapMs = Math.round(v) })
  bindSlider(ltEl, ltvEl, fmtTooLong, 'maxSpeakChars', (v) => { S.maxSpeakChars = Math.round(v) })

  hideCmdEl.addEventListener('change', () => {
    fetch(`${ROUTE}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hideCmdWindow: hideCmdEl.checked }) }).catch(() => {})
  })

  autoEl.addEventListener('change', () => {
    S.autoEmotion = autoEl.checked
    emoSel.disabled = S.autoEmotion
    emoSel.style.opacity = S.autoEmotion ? '.45' : '1'
    fetch(`${ROUTE}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoEmotion: S.autoEmotion }) }).catch(() => {})
  })

  emoSel.addEventListener('change', () => {
    S.emotion = emoSel.value
    fetch(`${ROUTE}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emotion: S.emotion }) }).catch(() => {})
  })

  // ── 添加角色：扫描目录 / 导入文件 ────────────────────────────────
  async function doScan() {
    scanOut.textContent = '正在扫描…'
    try {
      const r = await fetch(`${ROUTE}/scan`, { cache: 'no-store' })
      const j = await r.json()
      if (!j.ok) { scanOut.textContent = `扫描失败：${j.error}`; return }
      const lines = [`找到 ${j.characters.length} 个角色`]
      if (j.voiceWithoutAvatar.length) lines.push(`缺图片：${j.voiceWithoutAvatar.join('、')}`)
      if (j.avatarWithoutVoice.length) lines.push(`有图无声，不算角色：${j.avatarWithoutVoice.join('、')}`)
      scanOut.innerHTML = ''
      for (const line of lines) {
        const d = document.createElement('div')
        d.textContent = line
        scanOut.appendChild(d)
      }
      const p = document.createElement('div')
      p.style.cssText = 'margin-top:4px;color:#5d6f88;word-break:break-all'
      p.textContent = j.dirs.voices
      scanOut.appendChild(p)
      await refresh()
    } catch (e) { scanOut.textContent = `扫描失败：${e.message}` }
  }

  async function importFile(kind, file) {
    const nm = (newNameEl.value || '').trim() || file.name.replace(/\.[^.]+$/, '')
    if (!nm) { setError('没有角色名，也没法从文件名推出来'); return }
    setError('')
    scanOut.textContent = `正在导入 ${file.name} …`
    try {
      const r = await fetch(`${ROUTE}/import?kind=${kind}&name=${encodeURIComponent(nm)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const j = await r.json()
      if (!j.ok) { scanOut.textContent = ''; setError(`导入失败：${j.error}`); return }
      newNameEl.value = ''
      scanOut.textContent = `已导入 ${j.file}（${Math.round(j.size / 1024)} KB）`
      await refresh()
      renderChars()
      applyAvatar()
    } catch (e) { setError(`导入失败：${e.message}`) }
  }

  scanBtn.addEventListener('click', doScan)
  impVoiceBtn.addEventListener('click', () => fileVoiceEl.click())
  impImgBtn.addEventListener('click', () => fileImgEl.click())
  fileVoiceEl.addEventListener('change', () => {
    const f = fileVoiceEl.files && fileVoiceEl.files[0]
    if (f) importFile('voice', f)
    fileVoiceEl.value = ''
  })
  fileImgEl.addEventListener('change', () => {
    const f = fileImgEl.files && fileImgEl.files[0]
    if (f) importFile('avatar', f)
    fileImgEl.value = ''
  })

  sayBtn.addEventListener('click', async () => {
    sayBtn.disabled = true
    setError('')
    try {
      const r = await fetch(`${ROUTE}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好呀，这是声音测试。' }) })
      const j = await r.json()
      if (!j.ok) setError(j.service ? '合成失败，看宿主日志' : 'IndexTTS 没开，点「启动服务」')
    } catch (e) { setError(e.message) }
    finally { sayBtn.disabled = false }
  })

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true
    setError('正在启动 IndexTTS…')
    try {
      const r = await fetch(`${ROUTE}/service`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start' }) })
      const j = await r.json()
      setError(j.ok ? '服务已就绪' : '没起来，看 IndexTTS 那个窗口')
      refresh()
    } catch (e) { setError(e.message) }
    finally { startBtn.disabled = false }
  })

  window.addEventListener('resize', () => {
    clampHost()
    if (panel.classList.contains('show')) positionPanel()
  })

  document.addEventListener('mousedown', (ev) => {
    if (!panel.classList.contains('show')) return
    const path = ev.composedPath?.() || []
    if (!path.includes(host)) setPanel(false)
  }, true)
})()

    
    // 加载器要求这个模块导出一个插件（函数，或带 apply 的对象）。
    // 真正的挂载工作已经在上面那个 IIFE 里做完了（window.__littlestarVoiceLoaded 防重入），
    // 所以这里只补一个空 apply 让 Cordis 认；缺了它就是 "invalid plugin ... received object"。
    exports.name = 'dsh-littlestar-anything-voice'
    exports.inject = []
    exports.apply = function apply() {}
    return module.exports
  },
})
