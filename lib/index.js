/**
 * dsh-littlestar-anything-voice —— 任意角色语音挂件
 *
 * 角色 = 一张立绘 + 一段参考音频。挂件就是当前角色的半透明立绘：
 * 左键开关自动朗读，右键/Shift+点开面板换角色、调不透明度、音量、语速、停顿、情绪。
 *
 * 四条硬约束（都是踩过坑换来的）：
 *   1. 状态存 `$DSH_HOME/littlestar-voice/config.json`，**每次用前重读** ——
 *      host 配置只在启动时读一次，不能把开关放那儿。
 *   2. 合成只走 `synthesize.py`，不自己拼 IndexTTS 那 26 个参数。
 *   3. 开关打开时按需要把 IndexTTS 拉起来，
 *      拉不起来就降级纯文字、不再反复试。
 *   4. 一切串行 —— 8G 显存只剩几百 MB，并发只会互相拖死。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, extname } from 'node:path'
import { randomBytes } from 'node:crypto'

export const name = 'dsh-littlestar-anything-voice'

const ROUTE = '/littlestar-voice'
const CLIENT_ROUTE = `${ROUTE}/client.js`
const STATE_DIRNAME = 'littlestar-voice'

/** IndexTTS 的情绪词，和 QQ 线白名单保持一致。 */
const EMOTIONS = ['开心', '高兴', '难过', '悲伤', '生气', '愤怒', '害怕', '恐惧', '厌恶', '忧郁', '低落', '惊讶', '惊喜', '平静', '害羞', '委屈', '撒娇', '赌气']

/** 自动选情绪时的关键词规则：只有明显信号才给，宁可不给。 */
const AUTO_RULES = [
  { emo: '开心', re: /(太好了|开心|喜欢|好耶|哈哈|嘿嘿|棒极|真棒)/ },
  { emo: '惊喜', re: /(居然|竟然|没想到|哇塞|天哪)/ },
  { emo: '惊讶', re: /(什么？|怎么会|真的假的|啊？)/ },
  { emo: '害羞', re: /(害羞|不好意思|讨厌啦|人家)/ },
  { emo: '撒娇', re: /(好不好嘛|求求|抱抱|亲亲)/ },
  { emo: '委屈', re: /(委屈|冤枉|明明我|为什么这样)/ },
  { emo: '生气', re: /(生气|讨厌|过分|气死|怎么能这样)/ },
  { emo: '难过', re: /(难过|伤心|遗憾|可惜|呜呜)/ },
  { emo: '低落', re: /(算了|没办法|随便吧|唉)/ },
  { emo: '害怕', re: /(害怕|好怕|不敢|吓死)/ },
  { emo: '平静', re: /(好的|收到|明白|没问题)/ },
]

const DEFAULTS = {
  enabled: false,
  current: '',
  opacity: 0.88,
  size: 104,
  volume: 1,
  speed: 1,
  gapMs: 350,
  emotion: '',
  autoEmotion: true,
  emoWeight: 0.81,
  endpoint: 'http://127.0.0.1:7860',
  // ↓ 这几项跟机器有关，公开仓库里一律留空，由使用者自己填（写在自己实例的 config.json 里）。
  //   留空的后果：面板的「启动服务」按钮不工作，得手动开 WebUI；合成本身照常。
  projectDir: '',
  launcher: '',
  pythonPath: '',
  batPath: '',
  // 默认 false = 弹一个看得见的 CMD 窗口（「有窗口在 = 程序在跑」）
  hideCmdWindow: false,
  synthScript: '',
  autostartService: true,
  maxChars: 110,
  // 「太长不读」：本条回答要念的字数超过它就整条不念（0 = 不限）。
  // 分段朗读每段都要单起一次 python（RTX 2080 上约 13 秒），长回答会念到天荒地老。
  maxSpeakChars: 500,
}

function guessEmotion(text) {
  const s = String(text || '')
  if (!s) return ''
  for (const r of AUTO_RULES) if (r.re.test(s)) return r.emo
  return ''
}

export function apply(ctx, rawConfig) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const stateDir = join(dshHome, STATE_DIRNAME)
  // ★ 角色库是**平铺**的两个文件夹，同名即配对：
  //     voices/守岸人.mp3  ←→  avatars/守岸人.png
  //   音频是唯一的"必需项"：有音频才算一个角色，没图也能用（挂件会提示"暂无图片"）。
  const voicesDir = join(stateDir, 'voices')
  const avatarsDir = join(stateDir, 'avatars')
  const cacheDir = join(stateDir, 'cache')
  for (const d of [stateDir, voicesDir, avatarsDir, cacheDir]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 后面各自报错 */ }
  }
  const stateFile = join(stateDir, 'config.json')

  // 认得的扩展名。导入时**不看扩展名、看文件头**（见 sniffAudio / sniffImage）。
  const AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac']
  const IMG_EXTS = ['.png', '.webp', '.gif', '.jpg', '.jpeg']
  // 角色名同时是文件名：不许带路径分隔符、不许带扩展名
  const NAME_RE = /^[\w\u4e00-\u9fa5.\-·]+$/

  const log = (level, msg) => {
    try {
      if (level === 'warn') ctx.logger?.warn?.(`dsh-littlestar-anything-voice: ${msg}`)
      else ctx.logger?.info?.(`dsh-littlestar-anything-voice: ${msg}`)
    } catch { /* logging never breaks the plugin */ }
  }

  // ── 配置：每次读都落盘合并，保证面板改完立即生效 ──────────────────
  function loadOverrides() {
    try {
      if (!existsSync(stateFile)) return {}
      const j = JSON.parse(readFileSync(stateFile, 'utf8'))
      return j && typeof j === 'object' ? j : {}
    } catch { return {} }
  }
  function saveOverrides(patch) {
    try {
      mkdirSync(stateDir, { recursive: true })
      const next = { ...loadOverrides(), ...patch }
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(tmp, stateFile)
      return true
    } catch (e) {
      log('warn', `配置写入失败：${e?.message ?? e}`)
      return false
    }
  }
  // 「一开始是关闭状态，点了才开」：enabled 不跟 config.json 走，
  // 每次启动都从 false 起，点了才在内存里打开（且不落盘）。
  let sessionEnabled = false

  function effective() {
    const c = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}), ...loadOverrides() }
    c.enabled = sessionEnabled
    c.opacity = Math.min(1, Math.max(0.15, Number(c.opacity) || DEFAULTS.opacity))
    c.size = Math.min(300, Math.max(56, Math.round(Number(c.size) || DEFAULTS.size)))
    c.volume = Math.min(1, Math.max(0, Number(c.volume)))
    c.speed = Math.min(1.6, Math.max(0.6, Number(c.speed) || 1))
    c.gapMs = Math.min(2000, Math.max(0, Number(c.gapMs) || 0))
    c.emoWeight = Math.min(1, Math.max(0.1, Number(c.emoWeight) || DEFAULTS.emoWeight))
    c.maxChars = Math.min(600, Math.max(40, Math.round(Number(c.maxChars) || DEFAULTS.maxChars)))
    c.maxSpeakChars = Math.min(500, Math.max(0, Math.round(Number(c.maxSpeakChars) || 0)))
    if (!EMOTIONS.includes(c.emotion)) c.emotion = ''
    return c
  }

  // ── 角色库：voices/ 与 avatars/ 平铺，按文件名配对 ────────────────
  function safeList(dir, exts) {
    try {
      return readdirSync(dir)
        .filter((f) => exts.includes(extname(f).toLowerCase()))
        .map((f) => ({ file: f, name: basename(f, extname(f)), ext: extname(f).toLowerCase() }))
    } catch { return [] }
  }

  /** 同名查找：先精确，再忽略大小写（Windows 上 张三.MP3 和 张三.png 要能对上） */
  function findByName(list, name) {
    const n = String(name || '')
    return list.find((x) => x.name === n)
      || list.find((x) => x.name.toLowerCase() === n.toLowerCase())
      || null
  }

  function listCharacters() {
    const voices = safeList(voicesDir, AUDIO_EXTS)
    const avatars = safeList(avatarsDir, IMG_EXTS)
    const seen = new Set()
    const out = []
    for (const v of voices) {
      const key = v.name.toLowerCase()
      if (seen.has(key)) continue          // 同一角色两份音频：只认第一份
      seen.add(key)
      const a = findByName(avatars, v.name)
      out.push({
        id: v.name, name: v.name,
        hasAvatar: !!a,
        hasRef: true,                      // 兼容旧前端字段名
        voiceFile: v.file,
        avatarFile: a ? a.file : '',
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    return out
  }

  /** 角色存在 = voices/ 里有这个名字的音频。没有音频就不算角色。 */
  function voicePath(id) {
    if (!id || !NAME_RE.test(id)) return null
    const v = findByName(safeList(voicesDir, AUDIO_EXTS), id)
    return v ? join(voicesDir, v.file) : null
  }

  function avatarPath(id) {
    if (!id || !NAME_RE.test(id)) return null
    const a = findByName(safeList(avatarsDir, IMG_EXTS), id)
    return a ? join(avatarsDir, a.file) : null
  }

  // 导入时按**文件头**认格式，不信扩展名（前端传来的名字可以随便改）
  function sniffAudio(buf) {
    const b = buf
    if (b.length < 12) return ''
    if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE') return '.wav'
    if (b.slice(0, 3).toString('latin1') === 'ID3') return '.mp3'
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return '.mp3'
    if (b.slice(0, 4).toString('latin1') === 'fLaC') return '.flac'
    if (b.slice(0, 4).toString('latin1') === 'OggS') return '.ogg'
    if (b.slice(4, 8).toString('latin1') === 'ftyp') {
      const brand = b.slice(8, 12).toString('latin1')
      return brand.startsWith('M4A') || brand.startsWith('mp42') || brand.startsWith('isom') ? '.m4a' : '.m4a'
    }
    return ''
  }

  function sniffImage(buf) {
    const b = buf
    if (b.length < 12) return ''
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png'
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
    if (b.slice(0, 4).toString('latin1') === 'GIF8') return '.gif'
    if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return '.webp'
    return ''
  }

  // ── IndexTTS 服务：探活 / 拉起 ────────────────────────────────────
  let probeCache = { at: 0, alive: false }
  let serviceChild = null
  let launching = false
  let launchFailures = 0

  async function probe(force = false) {
    const now = Date.now()
    if (!force && now - probeCache.at < 3000) return probeCache.alive
    const cfg = effective()
    let alive = false
    try {
      const r = await fetch(`${String(cfg.endpoint).replace(/\/$/, '')}/gradio_api/info`, { signal: AbortSignal.timeout(2500) })
      alive = r.ok
    } catch { alive = false }
    probeCache = { at: now, alive }
    if (alive) launchFailures = 0
    return alive
  }

  /**
   * 引擎诊断：小白最容易卡在"点开关没反应"。
   * 把「到底缺什么」算成一句话，让面板能直接显示，而不是只写进日志。
   */
  function engineDiag() {
    const cfg = effective()
    if (probeCache.alive) return { alive: true, problem: '', hint: '' }
    const hasProject = !!cfg.projectDir && existsSync(cfg.projectDir)
    const hasPython = !!cfg.pythonPath && existsSync(cfg.pythonPath)
    const hasBat = !!cfg.batPath && existsSync(cfg.batPath)
    let problem = ''
    let hint = ''
    if (!cfg.projectDir && !cfg.pythonPath && !cfg.batPath) {
      problem = 'not-configured'
      hint = '还没配引擎。先装 IndexTTS（见 README「准备引擎」），再把路径填到下面几栏'
    } else if (!hasProject) {
      problem = 'project-missing'
      hint = `项目目录不存在：${cfg.projectDir || '（空）'}`
    } else if (!hasPython && !hasBat) {
      problem = 'runtime-missing'
      hint = '找不到 Python 也找不到启动脚本，没法自动拉起。手动开好 WebUI 也能用，只要端口通'
    } else if (!hasBat) {
      problem = 'no-bat'
      hint = '没有启动脚本，会直接用 Python 拉起（可能没有可见窗口）'
    }
    return { alive: false, problem, hint, hasProject, hasPython, hasBat }
  }

  /**
   * 拉起 IndexTTS。两种方式：
   *  - 可见（默认）：走那个被验证过的 bat，用 `start` 开一个独立的 CMD 窗口。
   *    使用者的标准「有窗口在 = 程序在跑」，所以这是默认行为。
   *  - 隐藏：只在面板里勾了「启用时隐藏 CMD 窗口」时才用，直接 spawn uv、无窗口。
   * 注意：绝不自造启动命令 —— bat 里带着 ffmpeg PATH、chcp 65001 和错误处理，
   * 自己拼一套曾经触发过 Windows 的「Internet 安全设置」弹窗。
   */
  function launchService() {
    if (launching) return false
    const cfg = effective()
    if (!cfg.autostartService) { log('info', 'autostartService=false，不自动拉起'); return false }
    if (launchFailures >= 3) { log('warn', '连续多次拉起失败，本次会话放弃自动启动'); return false }
    if (!existsSync(cfg.projectDir)) { log('warn', `项目目录不存在：${cfg.projectDir}`); launchFailures++; return false }
    const useUv = existsSync(cfg.launcher)
    if (!useUv && !existsSync(cfg.pythonPath)) { log('warn', '找不到 uv 或 python，无法拉起 IndexTTS'); launchFailures++; return false }

    const hide = !!cfg.hideCmdWindow
    const bat = String(cfg.batPath || '')
    const useBat = !hide && bat && existsSync(bat)

    launching = true
    try {
      if (useBat) {
        // 必须走 `start "" <bat>`，不能直接 spawn 那个 bat：
        // DSH 是 GUI，spawn 出来的 cmd 不会分到控制台窗口 —— 服务在跑，窗口却看不见，
        // 而使用者的判断标准就是「有窗口在 = 程序在跑」。
        // 空标题 "" 不能省：写成 start "标题" 会把标题当命令执行（弹「找不到文件」）。
        log('info', `拉起 IndexTTS（CMD 窗口）：${bat}`)
        const child = spawn('cmd.exe', ['/c', 'start', '', bat], {
          cwd: cfg.projectDir,
          windowsHide: false,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com' },
        })
        child.on('error', (e) => { launching = false; launchFailures++; log('warn', `拉起失败：${e.message}`) })
        child.unref()
      } else {
        const cmd = useUv ? cfg.launcher : cfg.pythonPath
        const args = useUv
          ? ['run', 'webui.py', '--model_dir', './checkpoints', '--version', '2.5']
          : ['webui.py', '--model_dir', './checkpoints', '--version', '2.5']
        log('info', `拉起 IndexTTS（无窗口）：${cmd} ${args.join(' ')}`)
        serviceChild = spawn(cmd, args, {
          cwd: cfg.projectDir,
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com' },
        })
        serviceChild.on('error', (e) => { launching = false; launchFailures++; log('warn', `拉起失败：${e.message}`) })
        serviceChild.on('exit', (code) => { launching = false; serviceChild = null; log('info', `IndexTTS 进程退出 code=${code}`) })
      }
      setTimeout(() => { launching = false }, 10000)
      return true
    } catch (e) {
      launching = false
      launchFailures++
      log('warn', `拉起异常：${e?.message ?? e}`)
      return false
    }
  }

  /** 服务在线就直接用；不在线则拉起并等就绪。 */
  async function ensureService(waitMs = 180000) {
    if (await probe(true)) return true
    const cfg = effective()
    if (!cfg.autostartService) return false
    launchService()
    const t0 = Date.now()
    while (Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 3000))
      if (await probe(true)) {
        log('info', `IndexTTS 就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        return true
      }
    }
    log('warn', '等 IndexTTS 就绪超时')
    return false
  }

  // ── 合成 ──────────────────────────────────────────────────────────
  let chain = Promise.resolve()
  let synthBusy = false

  function resolveSynthScript() {
    const cfg = effective()
    if (cfg.synthScript && existsSync(cfg.synthScript)) return cfg.synthScript
    const guess = join(dshHome, 'local-plugins', 'dsh-tool-say', 'scripts', 'synthesize.py')
    return existsSync(guess) ? guess : ''
  }

  function synthesize(text, charId, emotionOverride) {
    const cfg = effective()
    // 音色文件就是参考音频本身（voices/<名字>.<ext>）
    const refAbs = voicePath(charId || cfg.current)
    if (!refAbs) return Promise.resolve(null)
    const script = resolveSynthScript()
    if (!script) { log('warn', '找不到 synthesize.py'); return Promise.resolve(null) }
    if (!existsSync(cfg.pythonPath)) { log('warn', `找不到 Python：${cfg.pythonPath}`); return Promise.resolve(null) }

    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxChars)
    if (!clean) return Promise.resolve(null)

    // 情绪优先级：这段话自带的 [[语音: X | …]] > 面板手选 > 关键词猜
    const emotion = emotionOverride || cfg.emotion || (cfg.autoEmotion ? guessEmotion(clean) : '')
    const durationFactor = (1 / cfg.speed).toFixed(3)
    const out = join(cacheDir, `${randomBytes(8).toString('hex')}.wav`)

    const run = () => new Promise((resolve) => {
      synthBusy = true
      const args = [script, '--text', clean, '--out', out, '--voice', refAbs,
        '--endpoint', cfg.endpoint, '--duration-factor', durationFactor, '--emo-weight', String(cfg.emoWeight)]
      if (emotion) args.push('--emotion', emotion)
      log('info', `合成 ${basename(refAbs, extname(refAbs))}${emotion ? ' [' + emotion + ']' : ''}：${clean.slice(0, 20)}…`)
      const child = spawn(cfg.pythonPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      let err = ''
      const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 180000)
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (d) => { err += d.toString() })
      child.on('error', (e) => { clearTimeout(timer); synthBusy = false; log('warn', `spawn 失败：${e.message}`); resolve(null) })
      child.on('close', (code) => {
        clearTimeout(timer)
        synthBusy = false
        if (code === 0 && existsSync(out) && statSync(out).size > 1000) resolve(basename(out))
        else { log('warn', `合成失败 code=${code} ${err.slice(-240)}`); resolve(null) }
      })
    })
    const task = chain.then(run, run)
    chain = task.catch(() => null)
    return task
  }

  // ── 播放队列 ──────────────────────────────────────────────────────
  const pending = []
  function enqueue(file) {
    if (!file) return
    pending.push({ file, ts: Date.now() })
    while (pending.length > 32) pending.shift()
  }

  // ── 会话事件 → 自动朗读 ──────────────────────────────────────────
  function pickText(payload) {
    if (!payload) return ''
    for (const k of ['text', 'content', 'message']) {
      const v = payload[k]
      if (typeof v === 'string' && v.trim()) return v
    }
    return ''
  }

  /**
   * 把 `[[语音: 情绪 | 这句话]]` 拆成带情绪的段。
   * 记忆里的协议是「情绪必须和那句话配套」—— 以前这里把标签当垃圾剥掉，
   * 情绪就丢了，只能退化成关键词瞎猜；现在情绪跟着它那一段话走。
   * 标签之外的普通文字按原声念。
   */
  function splitVoiceTags(raw) {
    const s = String(raw || '')
    const out = []
    const re = /\[\[语音[:：]\s*([^\]|]*?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/g
    let last = 0
    let m
    while ((m = re.exec(s))) {
      const before = s.slice(last, m.index)
      if (before.trim()) out.push({ emotion: '', text: before })
      const maybeEmo = (m[1] || '').trim()
      const maybeText = (m[2] || '').trim()
      if (maybeText) out.push({ emotion: EMOTIONS.includes(maybeEmo) ? maybeEmo : '', text: maybeText })
      else if (maybeEmo) out.push({ emotion: '', text: maybeEmo })
      last = m.index + m[0].length
    }
    const tail = s.slice(last)
    if (tail.trim()) out.push({ emotion: '', text: tail })
    if (!out.length) out.push({ emotion: '', text: s })
    return out
  }

  function cleanForSpeech(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*\|.*\|\s*$/gm, ' ')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/^\s*#{1,6}\s*/gm, '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\[表情:[^\]]*\]/g, ' ')
      .replace(/\[语音:[^\]]*\]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim()
  }

  function splitSegments(text, maxLen = 110) {
    const rough = String(text).split(/(?<=[。！？!?；;…\n])/).map((s) => s.trim()).filter(Boolean)
    const merged = []
    let buf = ''
    for (const p of rough) {
      if (buf && buf.length + p.length > maxLen) { merged.push(buf); buf = '' }
      buf += p
      if (buf.length >= maxLen) { merged.push(buf); buf = '' }
    }
    if (buf) merged.push(buf)
    const out = []
    for (const piece of merged) {
      if (piece.length <= maxLen) { out.push(piece); continue }
      let rest = piece
      while (rest.length > maxLen) {
        const win = rest.slice(0, maxLen)
        const cut = Math.max(win.lastIndexOf('，'), win.lastIndexOf(','), win.lastIndexOf(' '))
        const at = cut > maxLen * 0.5 ? cut : maxLen
        out.push(rest.slice(0, at + 1))
        rest = rest.slice(at + 1)
      }
      if (rest) out.push(rest)
    }
    return out.filter(Boolean)
  }

  async function speakSegments(text, charId, force = false) {
    const cfg = effective()
    // force=true 用于面板上的「说一句」：手动点的不受「自动朗读开着没」限制
    if (!cfg.enabled && !force) return 0
    const pieces = splitVoiceTags(text)
    const cleaned = pieces
      .map((p) => ({ emotion: p.emotion, text: cleanForSpeech(p.text) }))
      .filter((p) => p.text)
    if (!cleaned.length) return 0
    // 「太长不读」：按清理后真正要念的字数算总量，超了整条跳过。
    // 手动「说一句」不受限 —— 那是使用者自己点着要听的。
    const limit = Math.max(0, Math.round(Number(cfg.maxSpeakChars) || 0))
    if (!force && limit > 0) {
      const total = cleaned.reduce((n, p) => n + p.text.length, 0)
      if (total > limit) {
        log('info', `本轮 ${total} 字超过「太长不读」${limit} 字，跳过朗读`)
        return 0
      }
    }
    if (!(await ensureService())) { log('warn', '服务没起来，跳过朗读'); return 0 }
    let n = 0
    for (const piece of cleaned) {
      for (const seg of splitSegments(piece.text, cfg.maxChars)) {
        if (!effective().enabled && !force) return n
        const file = await synthesize(seg, charId, piece.emotion)
        if (file) { enqueue(file); n++ }
      }
    }
    return n
  }

  // ★ 两个踩过的坑，别回退：
  // 1) session/event 的回调签名是 (session, event) —— 只写一个参数拿到的是 session，
  //    event.type 永远是 undefined，于是自动朗读一次都不会触发。
  // 2) 正文在 event.data.message.content[] 里，要挑 type === 'text' 的块；
  //    reasoning 块必须跳过，否则会把思考过程念出来。
  // 时机照 dsh-dania-voice 的做法：assistant/message 先攒着，turn/end 才开口，
  // 这样一轮写完念一次，而不是每步都打断。
  const turnTexts = new Map()
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const type = event?.type
        const data = event?.data
        if (!data || typeof data !== 'object') return
        const sid = session?.id ?? 'default'

        if (type === 'assistant/message') {
          const message = data.message
          if (!message || !Array.isArray(message.content)) return
          const texts = []
          for (const block of message.content) {
            if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              texts.push(block.text)
            }
          }
          if (texts.length) turnTexts.set(sid, { turn: data.turn, text: texts.join('\n') })
          return
        }

        if (type === 'turn/end') {
          const got = turnTexts.get(sid)
          turnTexts.delete(sid)
          if (!got) return
          // 读配置而不是读闭包：面板可能在这一轮进行中把开关关掉
          const cfg = effective()
          if (!cfg.enabled) return
          speakSegments(got.text, cfg.current).catch(() => {})
          return
        }
      } catch { /* 事件处理绝不影响主流程 */ }
    }, { global: true })
  } catch (e) {
    log('warn', `事件订阅失败：${e?.message ?? e}`)
  }

  // ── HTTP 路由 + 前端脚本注入 ─────────────────────────────────────
  ctx.on('webserver/index-inject', (table) => {
    try {
      if (!table || !Array.isArray(table.rows)) return
      if (table.rows.some((r) => r?.kind === 'script' && String(r.text || '').includes(CLIENT_ROUTE))) return
      table.rows.push({
        kind: 'script',
        text: ';(function(){var s=document.createElement("script");s.src="' + CLIENT_ROUTE + '?v="+Date.now();s.async=true;document.head.appendChild(s);})();',
      })
    } catch { /* 注入失败最多没挂件 */ }
  })

  ctx.inject(['webServer'], (scoped) => {
    const json = (res, code, obj) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      } catch { /* ignore */ }
    }
    const readBody = (req) => new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy() })
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } })
    })

    scoped.effect(() => scoped.webServer.register({
      path: CLIENT_ROUTE,
      handler: async (_req, res) => {
        try {
          const buf = readFileSync(new URL('../client.js', import.meta.url))
          res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(buf)
        } catch { res.writeHead(404); res.end('not found') }
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/state`,
      handler: async (_req, res) => {
        const cfg = effective()
        const chars = listCharacters()
        const current = cfg.current && chars.some((c) => c.id === cfg.current) ? cfg.current : (chars[0]?.id || '')
        json(res, 200, {
          enabled: !!cfg.enabled, current, characters: chars,
          opacity: cfg.opacity, size: cfg.size, volume: cfg.volume, speed: cfg.speed, gapMs: cfg.gapMs,
          emotion: cfg.emotion, autoEmotion: !!cfg.autoEmotion, emotions: EMOTIONS,
          emoWeight: cfg.emoWeight,
          service: probeCache.alive, launching, busy: synthBusy, pending: pending.length,
          engine: engineDiag(),
          endpoint: cfg.endpoint, projectDir: cfg.projectDir,
          pythonPath: cfg.pythonPath, batPath: cfg.batPath,
          stateDir,
          autostartService: !!cfg.autostartService,
          hideCmdWindow: !!cfg.hideCmdWindow,
          maxSpeakChars: cfg.maxSpeakChars,
        })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/toggle`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const prev = sessionEnabled
        const next = typeof body.enabled === 'boolean' ? body.enabled : !sessionEnabled
        sessionEnabled = next
        // enabled 不落盘 —— 每次启动都是关的；这里只决定本次运行
        let launched = false
        // 只有「从关到开」这一下才拉起 IndexTTS，启动时一律不拉
        if (next && !prev) {
          const alive = await probe(true)
          if (!alive) launched = launchService()
        }
        json(res, 200, { ok: true, enabled: next, launched, service: probeCache.alive })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/switch`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const id = String(body.id || '')
        if (!voicePath(id)) return json(res, 200, { ok: false, error: '角色不存在：voices/ 里没有这个名称的音频' })
        saveOverrides({ current: id })
        json(res, 200, { ok: true, current: id })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/config`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const patch = {}
        for (const k of ['opacity', 'size', 'volume', 'speed', 'gapMs', 'emotion', 'autoEmotion', 'emoWeight', 'endpoint', 'projectDir', 'launcher', 'pythonPath', 'synthScript', 'autostartService', 'maxChars', 'maxSpeakChars', 'hideCmdWindow', 'batPath']) {
          if (body[k] !== undefined) patch[k] = body[k]
        }
        saveOverrides(patch)
        json(res, 200, { ok: true })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/say`,
      handler: async (req, res) => {
        const body = await readBody(req)
        const text = String(body.text || '你好呀，这是声音测试。')
        const n = await speakSegments(text, effective().current, true)
        json(res, 200, { ok: n > 0, segments: n, service: probeCache.alive })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/service`,
      handler: async (req, res) => {
        const body = await readBody(req)
        if (body.action === 'start') {
          const ok = await ensureService(20000)
          return json(res, 200, { ok, service: probeCache.alive })
        }
        json(res, 200, { ok: true, service: await probe(true) })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/next`,
      handler: async (_req, res) => {
        const cfg = effective()
        const item = pending.shift()
        if (!item) return json(res, 200, { file: null, gapMs: cfg.gapMs })
        json(res, 200, { file: item.file, url: `${ROUTE}/audio/${encodeURIComponent(item.file)}`, gapMs: cfg.gapMs })
      },
    }))

    // webServer.register 是前缀匹配、不解析 :param，
    // 所以这里注册带尾斜杠的前缀，自己从 req.url 里截后半段。
    const tailOf = (req, marker) => {
      const raw = String(req?.url || '')
      const i = raw.indexOf(marker)
      if (i < 0) return ''
      return raw.slice(i + marker.length).split('?')[0].split('#')[0]
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/audio`,
      handler: async (req, res) => {
        try {
          const n = decodeURIComponent(tailOf(req, '/audio/'))
          if (!/^[\w-]+\.wav$/.test(n)) { res.writeHead(400); return res.end() }
          const file = join(cacheDir, n)
          if (!existsSync(file)) { res.writeHead(404); return res.end() }
          const buf = readFileSync(file)
          res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'cache-control': 'no-store' })
          res.end(buf)
        } catch { try { res.writeHead(500); res.end() } catch { /* ignore */ } }
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/avatar`,
      handler: async (req, res) => {
        try {
          const id = decodeURIComponent(tailOf(req, '/avatar/'))
          const f = avatarPath(id)
          if (!f) { res.writeHead(404); return res.end() }
          const buf = readFileSync(f)
          const e = extname(f).toLowerCase()
          const ct = e === '.png' ? 'image/png' : e === '.webp' ? 'image/webp' : e === '.gif' ? 'image/gif' : 'image/jpeg'
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'max-age=60' })
          res.end(buf)
        } catch { try { res.writeHead(500); res.end() } catch { /* ignore */ } }
      },
    }))

    // ── 添加角色 ①：扫描目录，看现在都有谁 ──────────────────────
    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/scan`,
      handler: async (_req, res) => {
        try {
          const chars = listCharacters()
          const voices = safeList(voicesDir, AUDIO_EXTS)
          const avatars = safeList(avatarsDir, IMG_EXTS)
          const voiceNames = new Set(voices.map((v) => v.name.toLowerCase()))
          const avatarNames = new Set(avatars.map((a) => a.name.toLowerCase()))
          json(res, 200, {
            ok: true,
            dirs: { voices: voicesDir, avatars: avatarsDir },
            characters: chars.map((c) => ({ id: c.id, hasAvatar: c.hasAvatar })),
            // 有音色没图片：能用，挂件上会提示「暂无图片」
            voiceWithoutAvatar: voices.filter((v) => !avatarNames.has(v.name.toLowerCase())).map((v) => v.name),
            // 有图片没音色：不算角色 —— 音频才是角色成立的条件
            avatarWithoutVoice: avatars.filter((a) => !voiceNames.has(a.name.toLowerCase())).map((a) => a.name),
          })
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
      },
    }))

    // ── 添加角色 ②：手动导入（正文是文件字节，名字走 query）───────
    scoped.effect(() => scoped.webServer.register({
      path: `${ROUTE}/import`,
      handler: async (req, res) => {
        try {
          const raw = String(req.url || '')
          const qi = raw.indexOf('?')
          const qs = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '')
          const kind = qs.get('kind') === 'avatar' ? 'avatar' : 'voice'
          const name = String(qs.get('name') || '').trim()
          if (!name) return json(res, 400, { ok: false, error: '要先填角色名字' })
          if (!NAME_RE.test(name)) return json(res, 400, { ok: false, error: '名字只能用中英文、数字、下划线、点、短横，不要带扩展名' })

          const chunks = []
          let size = 0
          let tooBig = false
          req.on('data', (c) => {
            size += c.length
            if (size > 64 * 1024 * 1024) { tooBig = true; try { req.destroy() } catch { /* ignore */ } return }
            chunks.push(c)
          })
          req.on('end', () => {
            try {
              if (tooBig) return json(res, 413, { ok: false, error: '文件太大了（上限 64 MB）' })
              const buf = Buffer.concat(chunks)
              if (!buf.length) return json(res, 400, { ok: false, error: '文件是空的' })
              // 按文件头认格式，不信任前端给的扩展名
              const ext = kind === 'voice' ? sniffAudio(buf) : sniffImage(buf)
              if (!ext) {
                return json(res, 400, {
                  ok: false,
                  error: kind === 'voice'
                    ? '这不是能认出来的音频（支持 wav / mp3 / flac / m4a / ogg）'
                    : '这不是能认出来的图片（支持 png / webp / gif / jpg）',
                })
              }
              const dir = kind === 'voice' ? voicesDir : avatarsDir
              const targetName = `${name}${ext}`
              // 同名的旧文件先删掉，免得同一角色留下两份
              try {
                for (const old of readdirSync(dir)) {
                  const sameName = basename(old, extname(old)).toLowerCase() === name.toLowerCase()
                  if (sameName && old !== targetName) { try { unlinkSync(join(dir, old)) } catch { /* ignore */ } }
                }
              } catch { /* ignore */ }
              writeFileSync(join(dir, targetName), buf)
              log('info', `导入${kind === 'voice' ? '音色' : '立绘'}：${targetName}（${buf.length} 字节）`)
              json(res, 200, { ok: true, kind, name, file: targetName, size: buf.length })
            } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
          })
          req.on('error', () => { try { json(res, 500, { ok: false, error: '接收失败' }) } catch { /* ignore */ } })
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
      },
    }))

    log('info', `已挂载 ${ROUTE}，角色 ${listCharacters().length} 个`)

    // 启动时**不**拉起 IndexTTS、也**不**自动朗读：
    // 明确要求「一开始是关闭状态，只有点击后才拉起」。
    // 所以这里什么都不做，等服务被点到再说。
  })
}
