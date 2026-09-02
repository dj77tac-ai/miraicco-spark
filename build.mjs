#!/usr/bin/env node
/**
 * Spark 電子ブック ビルドスクリプト
 *
 * PDF を1ページずつ画像にして、パスワードで暗号化し、docs/d/ の下に置く。
 * 置いたファイルはパスワードなしでは中身が読めないため、
 * GitHub Pages のような「誰でもアクセスできる場所」に置いても写真は見られない。
 *
 * 使い方:  node build.mjs           変わったところだけ作り直す
 *          node build.mjs --force   ぜんぶ作り直す
 *
 * パスワード:  password.txt に1行で書く（このファイルは git に入らない）
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

const PBKDF2_ITER = 210000 // パスワードから鍵を作るときの繰り返し回数。多いほど総当たりに強い

const force = process.argv.includes('--force')

// ---------- 準備 ----------

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

const password = (process.env.SPARK_PASSWORD ?? readIfExists(path.join(ROOT, 'password.txt'))).trim()
if (!password) {
  console.error('パスワードがありません。password.txt に1行で書いてください。')
  process.exit(1)
}
if (password.length < 8) {
  console.error('パスワードが短すぎます。12文字以上をおすすめします。')
  process.exit(1)
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

// パスワード → 鍵。salt は毎回作り直さず、既存があれば使い回す
// （作り直すと過去の号も全部作り直しになるため）
const keyPath = path.join(OUT, 'key.json')
const salt = fs.existsSync(keyPath)
  ? Buffer.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')).salt, 'base64')
  : crypto.randomBytes(16)
const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256')

/*
 * パスワードを変えたのに前の号をそのまま残すと、
 * 新しいパスワードでは古い号だけ開けない、という事故になる。
 * 鍵の指紋を手元に控えておき、変わっていたら全部作り直す。
 */
const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
const prevFingerprint = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8')).fingerprint
  : null
const keyChanged = prevFingerprint !== fingerprint
if (keyChanged && prevFingerprint) console.log('パスワードが変わりました。すべて作り直します。\n')

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
const TOL = 4                        // 数ポイントのずれは同じ大きさとみなす

/** ページ数と、1ページずつの紙の大きさを読む */
function pdfInfo(pdf) {
  const info = execFileSync('pdfinfo', ['-f', '1', '-l', '9999', pdf], { encoding: 'utf8' })
  const pages = Number((info.match(/^Pages:\s+(\d+)/m) || [])[1])
  const sizes = [...info.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)/gm)]
    .map((m) => ({ w: Number(m[1]), h: Number(m[2]) }))
  if (!pages || sizes.length !== pages) throw new Error(`PDF が読めません: ${pdf}`)
  return { pages, sizes }
}

/*
 * PDF から「画面に出す紙」の一覧を作る。
 *
 * 号によって、PDF の作り方が2通りある。
 *
 *   ① たて1ページずつ入っているもの（ほとんどの号）
 *   ② 見開き（2ページ分が横に並んだ1枚）で入っているもの
 *      → 2025年1〜3月号がこれ。そのまま出すと横に長い紙が出てしまうので、
 *        まん中で切って2枚に分ける
 *
 * さらに、印刷所へ出す PDF には四隅にトンボ（切り落としの目印）と
 * その外側の余白が付いていることがあるので、A4 の大きさに切り落とす。
 */
function facePlan(info) {
  const faces = []
  let split = 0
  let trimmed = 0

  for (let p = 1; p <= info.pages; p++) {
    const { w, h } = info.sizes[p - 1]
    const isSpread = w >= A4.w * 2 - TOL
    const targetW = isSpread ? A4.w * 2 : A4.w
    const targetH = A4.h
    const mx = Math.max(0, (w - targetW) / 2) // 左右の余白（トンボの外側）
    const my = Math.max(0, (h - targetH) / 2) // 上下の余白

    if (isSpread) {
      const half = targetW / 2
      faces.push({ page: p, crop: { x: mx, y: my, w: half, h: targetH } })          // 左のページ
      faces.push({ page: p, crop: { x: mx + half, y: my, w: half, h: targetH } })   // 右のページ
      split++
      if (mx > 1 || my > 1) trimmed++
    } else if (w > targetW + TOL || h > targetH + TOL) {
      faces.push({ page: p, crop: { x: mx, y: my, w: targetW, h: targetH } })
      trimmed++
    } else {
      faces.push({ page: p, crop: null })
    }
  }
  return { faces, split, trimmed }
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
  const plan = issue.trim === false
    ? { faces: info.sizes.map((_, i) => ({ page: i + 1, crop: null })), split: 0, trimmed: 0 }
    : facePlan(info)
  const faces = plan.faces
  const pages = faces.length
  const dir = path.join(OUT, issue.id)
  fs.rmSync(dir, { recursive: true, force: true })

  process.stdout.write(`${issue.label} (${pages}ページ) `)
  if (plan.split) process.stdout.write(`[見開き${plan.split}枚を2ページに分割] `)
  if (plan.trimmed) process.stdout.write(`[トンボを切落し ${plan.trimmed}枚] `)

  // 表紙のちいさい画像（一覧用）。切り落とし後の幅が 500px くらいになる粗さで
  sealToFile(renderPage(pdf, faces[0].page, { dpi: 60, crop: faces[0].crop }), path.join(dir, 'c.enc'))

  let bytes = 0
  faces.forEach((face, i) => {
    const dest = path.join(dir, `p${String(i + 1).padStart(3, '0')}.enc`)
    sealToFile(renderPage(pdf, face.page, { dpi: config.dpi, crop: face.crop }), dest)
    bytes += fs.statSync(dest).size
    process.stdout.write('.')
  })
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

// パスワードが合っているか確かめるための小さな箱（パスワードそのものは入っていない）
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

reportNewFolders()

/*
 * ドライブに号のフォルダが増えているのに config.json へ足し忘れる、
 * というのが一番起きやすい見落としなので、気づけるようにしておく。
 */
function reportNewFolders() {
  if (process.env.SPARK_FROM_PUBLISH) return // publish.mjs が自分で聞くので、ここでは黙る
  const base = config.pdfDirs?.[0]
  if (!base || !fs.existsSync(base)) return
  const used = new Set(config.issues.map((i) => String(i.pdf).split('/')[0]))
  const found = fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}/.test(e.name) && !used.has(e.name))
    .map((e) => e.name)
  if (!found.length) return
  console.log('\n── ドライブに、まだ入れていない号のフォルダがあります ──')
  for (const name of found) {
    const dir = path.join(base, name)
    const pdfs = []
    for (const sub of ['成果物', '確認用', '.']) {
      const d = path.join(dir, sub)
      if (!fs.existsSync(d)) continue
      for (const f of fs.readdirSync(d)) {
        if (/\.pdf$/i.test(f)) pdfs.push(path.join(name, sub === '.' ? '' : sub, f))
      }
    }
    console.log(`  ${name}`)
    for (const f of pdfs) console.log(`     ${f}`)
    if (!pdfs.length) console.log('     （PDF はまだありません）')
  }
  console.log('  → 入れるときは「公開する.command」をダブルクリックしてください\n')
}

function dirSize(dir) {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return total
}
