#!/usr/bin/env node
/**
 * Spark 電子ブック ビルドスクリプト
 *
 * PDF を1ページずつ画像にして、合言葉で暗号化し、docs/d/ の下に置く。
 * 置いたファイルは合言葉なしでは中身が読めないため、
 * GitHub Pages のような「誰でもアクセスできる場所」に置いても写真は見られない。
 *
 * 使い方:  node build.mjs
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

const PBKDF2_ITER = 210000 // 合言葉から鍵を作るときの繰り返し回数。多いほど総当たりに強い

// ---------- 準備 ----------

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))

const password = (process.env.SPARK_PASSWORD ?? readPasswordFile()).trim()
if (!password) {
  console.error('合言葉がありません。password.txt に1行で書いてください。')
  process.exit(1)
}
if (password.length < 6) {
  console.error('合言葉が短すぎます。6文字以上にしてください。')
  process.exit(1)
}

function readPasswordFile() {
  const p = path.join(ROOT, 'password.txt')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

// 合言葉 → 鍵。salt は毎回作り直さず、既存があれば使い回す
// （作り直すと過去の号も全部作り直しになるため）
const keyPath = path.join(OUT, 'key.json')
let salt
if (fs.existsSync(keyPath)) {
  salt = Buffer.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')).salt, 'base64')
} else {
  salt = crypto.randomBytes(16)
}
const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256')

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

function pdftoppm(args) {
  execFileSync('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

function pageCount(pdf) {
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' })
  const m = info.match(/^Pages:\s+(\d+)/m)
  if (!m) throw new Error(`ページ数が読めません: ${pdf}`)
  return Number(m[1])
}

/** 1ページ分を JPEG にして Buffer で返す */
function renderPage(pdf, pageNo, { dpi, scaleToX }) {
  const prefix = path.join(WORK, 'tmp')
  const args = ['-jpeg', '-jpegopt', `quality=${config.jpegQuality}`,
    '-f', String(pageNo), '-l', String(pageNo), '-singlefile']
  if (scaleToX) args.push('-scale-to-x', String(scaleToX), '-scale-to-y', '-1')
  else args.push('-r', String(dpi))
  args.push(pdf, prefix)
  pdftoppm(args)
  const out = prefix + '.jpg'
  const buf = fs.readFileSync(out)
  fs.unlinkSync(out)
  return buf
}

// ---------- 本処理 ----------

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })

const manifestIssues = []
let totalBytes = 0

for (const issue of config.issues) {
  const pdf = path.isAbsolute(issue.pdf) ? issue.pdf : path.join(config.pdfDir, issue.pdf)
  if (!fs.existsSync(pdf)) {
    console.error(`  ✗ ${issue.label}: PDF が見つかりません → ${pdf}`)
    continue
  }
  const pages = pageCount(pdf)
  const dir = path.join(OUT, issue.id)
  fs.rmSync(dir, { recursive: true, force: true })

  process.stdout.write(`${issue.label} (${pages}ページ) `)

  // 表紙のちいさい画像（一覧用）
  sealToFile(renderPage(pdf, 1, { scaleToX: 500 }), path.join(dir, 'c.enc'))

  let bytes = 0
  for (let p = 1; p <= pages; p++) {
    const jpg = renderPage(pdf, p, { dpi: config.dpi })
    const dest = path.join(dir, `p${String(p).padStart(3, '0')}.enc`)
    sealToFile(jpg, dest)
    bytes += fs.statSync(dest).size
    process.stdout.write('.')
  }
  totalBytes += bytes
  console.log(` ${(bytes / 1024 / 1024).toFixed(1)}MB`)

  manifestIssues.push({ id: issue.id, label: issue.label, pages })
}

// 一覧（号の名前とページ数）も暗号化して置く
const manifest = {
  title: config.title,
  subtitle: config.subtitle,
  issues: manifestIssues,
}
sealToFile(Buffer.from(JSON.stringify(manifest), 'utf8'), path.join(OUT, 'manifest.enc'))

// 合言葉が合っているか確かめるための小さな箱（合言葉そのものは入っていない）
fs.writeFileSync(keyPath, JSON.stringify({
  v: 1,
  salt: salt.toString('base64'),
  iter: PBKDF2_ITER,
  check: seal(Buffer.from('spark-ok', 'utf8')).toString('base64'),
}, null, 2))

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

console.log(`\n完成: ${manifestIssues.length}号 / 合計 ${(totalBytes / 1024 / 1024).toFixed(1)}MB`)
console.log(`置き場所: ${OUT}`)
