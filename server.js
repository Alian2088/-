// 福寿螺检测平台 —— 后端服务(DeepSeek 视觉识别)
// 前置：npm install；启动：node server.js
require('dotenv').config()
const express = require('express')
const app = express()
app.use(express.json({ limit: '16mb' }))

// 允许跨域(本地联调/调试工具)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// —— 请求统计 ——
const fs = require('fs')
const path = require('path')
const STATS_FILE = path.join(__dirname, 'stats.json')
const PRICE_IN = parseFloat(process.env.DS_PRICE_IN) || 2    // ¥/1M 输入token(可改)
const PRICE_OUT = parseFloat(process.env.DS_PRICE_OUT) || 8  // ¥/1M 输出token(可改)
function todayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
function loadStats() {
  let s = null
  try { s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) } catch (e) { s = null }
  const t = todayKey()
  if (!s) s = { today: t, requests: 0, success: 0, fail: 0, tokIn: 0, tokOut: 0, costTotal: 0, costDay: 0, resetCount: 0 }
  if (s.today !== t) { s.today = t; s.costDay = 0 }
  return s
}
function saveStats(s) { try { fs.writeFileSync(STATS_FILE, JSON.stringify(s)) } catch (e) {} }
function costOf(u) { const i = (u && u.prompt_tokens) || 0; const o = (u && u.completion_tokens) || 0; return (i * PRICE_IN + o * PRICE_OUT) / 1e6 }
function logStats(s, curCost) {
  const cur = (typeof curCost === 'number' && !isNaN(curCost)) ? '  | 本次 ¥' + curCost.toFixed(4) : '  '
  console.log('[stats]  | 请求 ' + s.requests + ' | 成功 ' + s.success + ' | 失败 ' + s.fail + cur + ' | 今日费用 ¥' + s.costDay.toFixed(4) + ' | 累计费用 ¥' + s.costTotal.toFixed(4) + ' |')
}
const _st = loadStats()


const PORT = parseInt(process.env.PORT, 10) || 80

// DeepSeek 视觉模型(图片识别 detect)
const DS_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const VISION_MODEL = process.env.VISION_MODEL || 'deepseek-v4-flash-vision-exp'
const DS_BASE = process.env.DS_BASE_URL || 'https://api.deepseek.com'

const PROMPT = `你是资深水生生物识别与福寿螺(Pomacea canaliculata，入侵物种)防控专家。
识别要求：
1. 先整体观察，判断图中是否螺类、是否为福寿螺。
2. 清点图中每一只螺，大的小的都要算、边缘和小的都不要漏；count 返回螺类个体总数(幼螺+成螺)。并分别返回 juvenile_count(幼螺数)、adult_count(成螺数)、egg_count(卵块数，无卵块则为0)。若图片模糊、重叠或很多难以逐一数清，则按轮廓大小与面积占比给出合理估算，务必数全，count 为整数，绝不要把有螺的图写成 0。
3. 估计大小 size，判断生长阶段 stage(卵块/幼螺/成螺)。
4. 识别依据 evidence 必须只描述图片中实际可见的特征：未在图中看到的特征一律不要提及(例如图中没有卵块就不要写卵块、看不清螺旋就不要写螺旋)；若图片过糊或信息不足，请如实写明“图片过糊/信息不足，无法确认”，绝不虚构或臆测。
5. 输出 detections：只在确认为福寿螺个体或卵块的位置打近似中心点(坐标为 0~1 归一化：x=距左比例，y=距上比例)，type 标注 成螺/幼螺/卵块；不确定或重叠看不清的区域不要打点，宁少勿多；对明显的非螺物体(餐具、植物、石头、龟、饵料等)绝不打点；若图中没有清晰的福寿螺/卵块，则返回空数组。此字段必须输出。
6. 判型约束：卵块是粉红色成串的小颗粒卵团，体积远小于成螺，不可能比成螺体型还大；若某处体型接近或大于成螺，绝不能标为卵块。
严格按如下 JSON 结构返回，且只返回 JSON，不要多余解释：
{
  "is_pomacea": true 或 false,
  "confidence": 0到1之间的小数,
  "species": "识别到的物种倾向，如 福寿螺/田螺/石螺/其他",
  "conclusion": "一句话中文结论",
  "evidence": "识别依据，简述观察到的壳色/螺旋/壳口/卵块/数量等实际可见特征",
  "suggestion": "若为福寿螺给出防治或上报建议(中文)，否则给出一般提示",
  "risk": "high / medium / low 危害等级",
  "count": 图中螺类个体总数(幼螺+成螺，整数，尽量数全不要漏数)，
  "egg_count": 图中卵块数量(没有则为0)，
  "juvenile_count": 图中幼螺数量(幼螺=体型比成螺小至少40%-70%的个体；没有则为0)，
  "adult_count": 图中成螺数量(体型较大的成体；没有则为0)，
  "size": 大小描述(如：约1-3cm / 中等 / 偏大 / 卵块大小，中文)，
  "stage": "卵块 或 幼螺 或 成螺 或 未知",
  "suspicious": true或false 表示图片是否模糊/不清晰/特征不明，需人工复核,
  "detections": [{"x": 0到1的归一化横坐标, "y": 0到1的归一化纵坐标, "type": "成螺或幼螺或卵块"}]  // 图中每个福寿螺个体及卵块的近似中心点(归一化0~1)；无法定位则返回空数组
}`

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: VISION_MODEL, hasDsKey: !!DS_API_KEY })
})

// 图片识别(DeepSeek-V4-Flash-Vision-Exp，每次为新对话)
app.post('/api/detect', async (req, res) => {
  const t0 = Date.now()
  let st = loadStats(); st.requests += 1; saveStats(st)
  try {
    const { image, mime, mode, ref, imgW, imgH } = req.body || {}
    if (!image) return res.status(400).json({ ok: false, error: '缺少图片数据' })
    if (!DS_API_KEY) return res.status(500).json({ ok: false, error: '服务端未配置 DEEPSEEK_API_KEY，请参考 README 配置' })

    const dataUrl = `data:${mime || 'image/jpeg'};base64,${image}`
    const refObj = ref || {}
    const hasRef = (Array.isArray(refObj.adult) && refObj.adult.length) || (Array.isArray(refObj.juv) && refObj.juv.length) || (Array.isArray(refObj.egg) && refObj.egg.length)
    const userContent = []
    const manuals = (refObj.manual || []).filter(m => m && m.img)
    if (manuals.length) {
      userContent.push({ type: 'text', text: '以下是人工识别参考图：请重点分析每张图中标注点所在位置处福寿螺的轮廓、外形与大小，学习本地福寿螺的具体形态与数量，再识别待测图。' })
      manuals.forEach(m => {
        const pts = (m.points || []).map(p => (p.type || '点') + '(' + Number(p.x).toFixed(2) + ',' + Number(p.y).toFixed(2) + ')').join('、')
        userContent.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + m.img } })
        userContent.push({ type: 'text', text: '人工识别参考图' + (pts ? '；标注点：' + pts : '') })
      })
    }

    if (hasRef) {
      userContent.push({ type: 'text', text: '以下是本地福寿螺高清参考图：请逐张重点分析标注点位置处螺的轮廓、外形与体型大小，认真学习本地福寿螺的具体形态(壳形/壳口/大小)与卵块特征。' })
      const labels = [['adult', '成螺'], ['juv', '幼螺'], ['egg', '卵块']]
      labels.forEach(pair => {
        const arr = refObj[pair[0]] || []
        arr.forEach(entry => {
          const img = (typeof entry === 'string') ? entry : (entry ? entry.img : '')
          if (!img) return
          const pts = (entry && entry.points && entry.points.length) ? entry.points : []
          const ptsTxt = pts.length ? '；已标注坐标：' + pts.map(p => (p.type || '点') + '(' + Number(p.x).toFixed(2) + ',' + Number(p.y).toFixed(2) + ')').join('、') : ''
          userContent.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img } })
          userContent.push({ type: 'text', text: '本地【' + pair[1] + '】参考图' + ptsTxt })
        })
      })
      userContent.push({ type: 'text', text: '请结合上面参考图(尤其是标注点处)学到的本地福寿螺轮廓与大小，识别下面待识别图片中的福寿螺个体数量及卵块/幼螺/成螺数量，严格按要求的 JSON 返回。' })
    }
    if (hasRef || manuals.length) {
      userContent.push({ type: 'text', text: '注意：参考图上的标注点仅用于学习福寿螺的形状与大小；待测图中的检测点必须位于待测图实际存在的福寿螺/卵块上，绝不能照搬参考图的标注位置。' })
    }
    userContent.push({ type: 'image_url', image_url: { url: dataUrl } })
    userContent.push({ type: 'text', text: '请识别这张照片里的螺类，并按要求的 JSON 返回。' + (mode === 'fuzzy' ? '本次为模糊估算：若图片模糊、密集或重叠难以逐一清点，可估算数量，允许略高于真实数量，但相对误差尽量控制在10%以内，请给出最接近的合理估计。' : '本次为精确计数：请尽可能逐只清点图中每一只螺，按实际可见数量返回，不要高估，数量宁准勿估。') })

    const body = {
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.3,
      max_tokens: 4000
    }

    const resp = await fetch(`${DS_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DS_API_KEY}` },
      body: JSON.stringify(body)
    })

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      return res.status(502).json({ ok: false, error: `DeepSeek 接口返回 ${resp.status}: ${txt.slice(0, 200)}` })
    }

    const data = await resp.json()
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''

    let parsed = null
    try { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]) } catch (e) { parsed = null }

    if (parsed) {
      const I = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n }
      parsed.egg_count = I(parsed.egg_count)
      parsed.juvenile_count = I(parsed.juvenile_count)
      parsed.adult_count = I(parsed.adult_count)
      let c = I(parsed.count)
      const sum = parsed.juvenile_count + parsed.adult_count
      if (sum > 0) c = sum
      if (c <= 0) {
        const m = text.match(/["']?count["']?\s*[:：]\s*(\d+)/i) || text.match(/(\d+)\s*[只个]/)
        if (m) c = parseInt(m[1], 10)
      }
      if (isNaN(c) || c <= 0) c = parsed.is_pomacea ? 1 : 0
      parsed.count = c

      const dets = Array.isArray(parsed.detections) ? parsed.detections : []
      const iw = parseFloat(imgW) || 0
      const ih = parseFloat(imgH) || 0
      const norm = (v, dim) => {
        let n = parseFloat(v)
        if (isNaN(n)) return NaN
        if (n > 1 && n <= 100) n = n / 100
        if (n > 100 && dim > 0) n = n / dim
        return n
      }
      parsed.detections = dets.map(d => {
        const x = norm(d.x, iw)
        const y = norm(d.y, ih)
        if (isNaN(x) || isNaN(y)) return null
        return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), type: d.type || '福寿螺' }
      }).filter(Boolean)
      // 去重：距离过近的点只保留一个，避免重复/杂乱标点
      const keep = []
      ;(parsed.detections || []).forEach(d => {
        const dup = keep.some(k => Math.abs(k.x - d.x) < 0.035 && Math.abs(k.y - d.y) < 0.035)
        if (!dup) keep.push(d)
      })
      parsed.detections = keep.slice(0, 40)
    }
    const u = data.usage || {}
    st.success += 1
    st.tokIn += (u.prompt_tokens || 0)
    st.tokOut += (u.completion_tokens || 0)
    const cost = costOf(u)
    st.costTotal += cost
    st.costDay += cost
    saveStats(st)
    logStats(st, cost)
    res.json({ ok: true, raw: text, result: parsed, engine: 'deepseek-vision', model: VISION_MODEL, ms: Date.now() - t0 })
  } catch (e) {
    st.fail += 1; saveStats(st); logStats(st)
    res.status(500).json({ ok: false, error: (e && e.message) || '识别失败' })
  }
})

app.listen(PORT, () => {
  console.log('[福寿螺检测平台后端] listening on', PORT, '| vision:', VISION_MODEL, '| key:', !!DS_API_KEY)
  console.log('[stats] | 数据统计：总请求 ' + _st.requests + ' | 成功 ' + _st.success + ' | 失败 ' + _st.fail + ' | 今日费用 ¥' + _st.costDay.toFixed(4) + ' | 累计费用 ¥' + _st.costTotal.toFixed(4) + ' | 重置统计 ' + (_st.resetCount || 0) + ' |')
})

// 控制台输入 reload → 重置统计
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', line => {
  const t = (line || '').trim().toLowerCase()
  if (t === 'reload' || t === 'reset' || t === '重置') {
    const prev = loadStats()
    const rc = (prev.resetCount || 0) + 1
    const fresh = { today: todayKey(), requests: 0, success: 0, fail: 0, tokIn: 0, tokOut: 0, costTotal: 0, costDay: 0, resetCount: rc }
    saveStats(fresh)
    console.log('[stats] | 数据统计：总请求 0 | 成功 0 | 失败 0 | 今日费用 ¥0.0000 | 累计费用 ¥0.0000 | 重置统计 ' + rc + ' |')
  } else if (t) {
    console.log('[stats] 输入 reload 重置统计')
  }
})