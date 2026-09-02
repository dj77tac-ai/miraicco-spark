#!/usr/bin/env node
/**
 * Spark 電子ブック ビルドスクリプト
 *
 * PDF を1ページずつ画像にして、合言葉で暗号化し、docs/d/ の下に置く。
 * 置いたファイルは合言葉なしでは中身が読めないため、
 * GitHub Pages のような「誰でもアクセスできる場所」に置いても写真は見られない。
 *
 * 使い方:  node build.mjs           変わったところだけ作り直す
 *          node build.mjs --force   ぜんぶ作り直す
 *
 * 合言葉:  password.txt に1行で書く（このファイルは git に入らない）
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.join(ROOT, 'docs')
const OUT = path.join(SITE, 'd')
const WORK = path.join(ROOT, 'work')
const STATE = path.join(ROOT, '.buildstate.json') // 手元だけの控え。git には入らない

const PBKDF2_ITER = 210000 // 合言葉から鍵を作るときの繰り返し回数。多いほど総当たりに強い

const force = process.argv.includes('--force')

// ---------- 準備 ----------

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

const password = (process.env.SPARK_PASSWORD ?? readIfExists(path.join(ROOT, 'password.txt'))).trim()
if (!password) {
  console.error('合言葉がありません。password.txt に1行で書いてください。')
  process.exit(1)
}
if (password.length < 8) {
  console.error('合言葉が短すぎます。12文字以上をおすすめします。')
  process.exit(1)
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

// 合言葉 → 鍵。salt は毎回作り直さず、既存があれば使い回す
// （作り直すと過去の号も全部作り直しになるため）
const keyPath = path.join(OUT, 'key.json')
const salt = fs.existsSync(keyPath)
  ? Buffer.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')).salt, 'base64')
  : crypto.randomBytes(16)
const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256')

/*
 * 合言葉を変えたのに前の号をそのまま残すと、
 * 新しい合言葉では古い号だけ開けない、という事故になる。
 * 鍵の指紋を手元に控えておき、変わっていたら全部作り直す。
 */
const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
const prevFingerprint = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8')).fingerprint
  : null
const keyChanged = prevFingerprint !== fingerprint
if (keyChanged && prevFingerprint) console.log('合言葉が変わりました。すべて作り直します。\n')

const rebuildAll = force || keyChanged

// ---------- 暗号化 ----------

/** 中身を AES-256-GCM で包む。返り値は iv(12) + 本体 + 認証タグ(16) */
function seal(buf) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([iv, body, c.getAuthTag()])
}

function sealToFile(buf, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, seal(buf))
}

// ---------- PDF → 画像 ----------

const A4 = { w: 595.276, h: 841.89 } // A4 の大きさ（ポイント）

/** ページ数と紙の大きさを読む */
function pdfInfo(pdf) {
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' })
  const pages = info.match(/^Pages:\s+(\d+)/m)
  const size = info.match(/^Page size:\s+([\d.]+) x ([\d.]+)/m)
  if (!pages || !size) throw new Error(`PDF が読めません: ${pdf}`)
  return { pages: Number(pages[1]), w: Number(size[1]), h: Number(size[2]) }
}

/*
 * 印刷所へ出す PDF には、四隅に「トンボ」（切り落とし位置の目印）と
 * その外側の余白が付いていることがある。そのまま画面に出すと
 * 紙のまわりに白いふちと十字の線が見えてしまうので、A4 の大きさに切り落とす。
 * ちょうど A4 の PDF は何もしない。
 */
function trimBox(info) {
  if (info.w <= A4.w + 2 && info.h <= A4.h + 2) return null
  const x = (info.w - A4.w) / 2
  const y = (info.h - A4.h) / 2
  if (x < 0 || y < 0) return null
  return { x, y, w: A4.w, h: A4.h }
}

/** 1ページ分を JPEG にして Buffer で返す */
function renderPage(pdf, pageNo, { dpi, crop }) {
  const prefix = path.join(WORK, 'tmp')
  const args = ['-jpeg', '-jpegopt', `quality=${config.jpegQuality}`,
    '-f', String(pageNo), '-l', String(pageNo), '-singlefile', '-r', String(dpi)]
  if (crop) {
    const k = dpi / 72 // ポイント → 画素
    args.push('-x', String(Math.round(crop.x * k)), '-y', String(Math.round(crop.y * k)),
      '-W', String(Math.round(crop.w * k)), '-H', String(Math.round(crop.h * k)))
  }
  args.push(pdf, prefix)
  execFileSync('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const out = prefix + '.jpg'
  const buf = fs.readFileSync(out)
  fs.unlinkSync(out)
  return buf
}

/** config の pdfDirs を順にさがす */
function findPdf(name) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null
  for (const dir of config.pdfDirs ?? []) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

/** すでに作ってある号か（ページ数を返す。まだなら 0） */
function builtPages(id) {
  const dir = path.join(OUT, id)
  if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'c.enc'))) return 0
  return fs.readdirSync(dir).filter((f) => /^p\d+\.enc$/.test(f)).length
}

// ---------- 本処理 ----------

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })

const manifestIssues = []
let madeCount = 0

for (const issue of config.issues) {
  const already = rebuildAll ? 0 : builtPages(issue.id)
  const pdf = findPdf(issue.pdf)

  // すでに作ってあり、元の PDF も変わっていなければ、そのまま使う
  if (already > 0) {
    const stamp = fs.statSync(path.join(OUT, issue.id, 'c.enc')).mtimeMs
    if (!pdf || fs.statSync(pdf).mtimeMs <= stamp) {
      console.log(`${issue.label} (${already}ページ) — 作成ずみ`)
      manifestIssues.push(entry(issue, already))
      continue
    }
  }

  if (!pdf) {
    console.error(`  ✗ ${issue.label}: PDF が見つかりません → ${issue.pdf}`)
    continue
  }

  const info = pdfInfo(pdf)
  const pages = info.pages
  const crop = issue.trim === false ? null : trimBox(info)
  const dir = path.join(OUT, issue.id)
  fs.rmSync(dir, { recursive: true, force: true })

  process.stdout.write(`${issue.label} (${pages}ページ) `)
  if (crop) {
    const mm = (n) => (n * 25.4 / 72).toFixed(0)
    process.stdout.write(`[トンボを切落し 左右${mm(crop.x)}mm 上下${mm(crop.y)}mm] `)
  }

  // 表紙のちいさい画像（一覧用）。切り落とし後の幅が 500px くらいになる粗さで
  sealToFile(renderPage(pdf, 1, { dpi: 60, crop }), path.join(dir, 'c.enc'))

  let bytes = 0
  for (let p = 1; p <= pages; p++) {
    const dest = path.join(dir, `p${String(p).padStart(3, '0')}.enc`)
    sealToFile(renderPage(pdf, p, { dpi: config.dpi, crop }), dest)
    bytes += fs.statSync(dest).size
    process.stdout.write('.')
  }
  console.log(` ${(bytes / 1024 / 1024).toFixed(1)}MB`)

  madeCount++
  manifestIssues.push(entry(issue, pages))
}

function entry(issue, pages) {
  return {
    id: issue.id,
    label: issue.label,
    pages,
    year: issue.year ?? String(issue.id).slice(0, 4), // 一覧で年ごとにまとめるのに使う
  }
}

// 一覧（号の名前・ページ数・年）も暗号化して置く
sealToFile(Buffer.from(JSON.stringify({
  title: config.title,
  subtitle: config.subtitle,
  issues: manifestIssues,
}), 'utf8'), path.join(OUT, 'manifest.enc'))

// 合言葉が合っているか確かめるための小さな箱（合言葉そのものは入っていない）
fs.writeFileSync(keyPath, JSON.stringify({
  v: 1,
  salt: salt.toString('base64'),
  iter: PBKDF2_ITER,
  check: seal(Buffer.from('spark-ok', 'utf8')).toString('base64'),
}, null, 2))

fs.writeFileSync(STATE, JSON.stringify({ fingerprint }, null, 2))
fs.rmSync(WORK, { recursive: true, force: true })

// 画面のファイル(style.css / app.js)を直したとき、
// 保護者のブラウザが古いものを使い続けないよう、番号を付け替える
stampAssets()

function stampAssets() {
  const indexPath = path.join(SITE, 'index.html')
  let html = fs.readFileSync(indexPath, 'utf8')
  for (const file of ['style.css', 'app.js']) {
    const hash = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(SITE, file)))
      .digest('hex').slice(0, 8)
    html = html.replace(new RegExp(file.replace('.', '\\.') + '(\\?v=[a-z0-9]+)?'), file + '?v=' + hash)
  }
  fs.writeFileSync(indexPath, html)
}

const totalMB = dirSize(OUT) / 1024 / 1024
console.log(`\n完成: ${manifestIssues.length}号（うち今回作ったのは ${madeCount}号）/ 合計 ${totalMB.toFixed(1)}MB`)
console.log(`置き場所: ${OUT}`)

function dirSize(dir) {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}
