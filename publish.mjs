#!/usr/bin/env node
/**
 * Spark 電子ブック  公開の道具（広報担当のかた向け）
 *
 * 質問に答えるだけで、新しい号をページに出すところまで終わります。
 * ふつうは「公開する.command」をダブルクリックして使ってください。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = path.join(ROOT, 'config.json')
const SITE_URL = 'https://dj77tac-ai.github.io/miraicco-spark/'

const rl = readline.createInterface({ input, output })
const ask = (q) => rl.question(q)

function line(s = '') { console.log(s) }
function head(s) { line(); line('── ' + s + ' ──'); line() }

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const base = config.pdfDirs?.[0]

// ---------- ① ドライブに、まだ入れていない号があるか ----------

function findNewFolders() {
  if (!base || !fs.existsSync(base)) {
    line('★ Google ドライブのフォルダが見つかりません。')
    line('  ' + base)
    line('  Google ドライブ（パソコン版）が動いているか確かめてください。')
    return []
  }
  const used = new Set(config.issues.map((i) => String(i.pdf).split('/')[0]))
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}/.test(e.name) && !used.has(e.name))
    .map((e) => e.name)
    .sort()
}

/** その号のフォルダにある PDF を、新しいものから順に集める */
function pdfsIn(folder) {
  const dir = path.join(base, folder)
  const found = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, path.join(rel, e.name))
      else if (/\.pdf$/i.test(e.name)) {
        const st = fs.statSync(p)
        found.push({ rel: path.join(rel, e.name), full: p, size: st.size, mtime: st.mtimeMs })
      }
    }
  }
  walk(dir, folder)
  // 「アーカイブ／ForArchive」→「Ol／ForWeb」の順に、上に出す
  const rank = (name) => {
    const n = name.toLowerCase()
    if (n.includes('archive') || name.includes('アーカイブ')) return 0
    if (n.includes('forweb') || n.includes('-ol') || n.includes(' ol')) return 1
    if (name.includes('入稿')) return 3
    return 2
  }
  return found.sort((a, b) => rank(a.rel) - rank(b.rel) || b.mtime - a.mtime)
}

function pdfPages(file) {
  try {
    const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' })
    const m = info.match(/^Pages:\s+(\d+)/m)
    return m ? Number(m[1]) : null
  } catch { return null }
}

const MB = (n) => (n / 1024 / 1024).toFixed(1) + 'MB'

// ---------- ② 号の名前を考える ----------

/** フォルダ名から「2026年1〜3月号」のような名前を作ってみる */
function guessLabel(folder) {
  const year = folder.slice(0, 4)
  const digits = folder.slice(4).replace(/[^0-9]/g, '')
  if (!digits) return `${year}年`

  /*
   * 「123」は 1・2・3 とも 12・3 とも読める。
   * 月は増えていく順にならぶはずなので、そうなる読み方を選ぶ。
   */
  const ways = []
  const walk = (i, acc) => {
    if (i >= digits.length) { if (acc.length) ways.push(acc); return }
    if (digits[i] === '0') return walk(i + 1, acc) // 「045」の 0 は読みとばす
    const two = Number(digits.slice(i, i + 2))
    if (digits.length - i >= 2 && two >= 10 && two <= 12) walk(i + 2, acc.concat(two))
    const one = Number(digits[i])
    if (one >= 1 && one <= 9) walk(i + 1, acc.concat(one))
  }
  walk(0, [])
  if (!ways.length) return `${year}年`

  const rising = (m) => m.every((v, i) => i === 0 || v > m[i - 1])
  const good = ways.filter(rising)
  const months = (good.length ? good : ways).sort((a, b) => b.length - a.length)[0]

  if (months.length === 1) return `${year}年${months[0]}月号`
  const run = months.every((m, i) => i === 0 || m === months[i - 1] + 1)
  if (run && months.length >= 3) return `${year}年${months[0]}〜${months[months.length - 1]}月号`
  return `${year}年${months.join('・')}月号`
}

function makeId(folder, taken) {
  let id = folder.replace(/[^0-9A-Za-z_]/g, '_')
  while (taken.has(id)) id += '_'
  return id
}

// ---------- 本編 ----------

async function main() {
  line('================================================')
  line('  Spark 電子ブック  公開')
  line('================================================')

  const news = findNewFolders()
  const taken = new Set(config.issues.map((i) => i.id))
  let added = 0

  if (!news.length) {
    head('ドライブに、まだ入れていない号はありませんでした')
    line('今ある10号のまま、直したところがあれば公開します。')
  }

  for (const folder of news) {
    head(`ドライブに新しいフォルダがあります： ${folder}`)

    const pdfs = pdfsIn(folder)
    if (!pdfs.length) {
      line('この中に PDF がありません。とばします。')
      continue
    }

    line('この中の PDF です。（上にあるものほど、電子ブック向きです）')
    line()
    pdfs.forEach((p, i) => {
      const pages = pdfPages(p.full)
      const warn = p.size === 0 ? '  ★中身が空です！使えません' : ''
      line(`  ${i + 1}) ${path.basename(p.rel)}`)
      line(`       ${MB(p.size)}${pages ? ' / ' + pages + 'ページ' : ''}${warn}`)
    })
    line()
    line('  0) この号は今回入れない')
    line()

    const pick = await ask('どれを使いますか？ 番号を入れてください： ')
    const n = Number(pick.trim())
    if (!n || n < 1 || n > pdfs.length) { line('とばしました。'); continue }
    const chosen = pdfs[n - 1]

    if (chosen.size === 0) {
      line()
      line('★ このファイルは中身が空です（アップロードに失敗しています）。')
      line('  入れ直してから、もう一度この作業をしてください。')
      continue
    }

    // 中身を目で確かめてもらう
    line()
    const look = await ask('この PDF を開いて中身を見ますか？ (y = 開く / それ以外 = 開かない)： ')
    if (look.trim().toLowerCase() === 'y') {
      spawnSync('open', [chosen.full])
      await ask('確認できたら Enter を押してください： ')
    }

    const suggest = guessLabel(folder)
    line()
    line(`号の名前を決めます。一覧にこの名前で出ます（例： 2026年1〜3月号）`)
    const answer = await ask(`名前 [そのままでよければ Enter → ${suggest}]： `)
    const label = answer.trim() || suggest

    config.issues.push({ id: makeId(folder, taken), label, pdf: chosen.rel })
    taken.add(config.issues[config.issues.length - 1].id)
    added++
    line()
    line(`「${label}」を追加しました。`)
  }

  if (added) {
    fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n')
  }

  // ---------- 作り直す ----------
  head('ページを作り直しています（少し時間がかかります）')
  // stdio の1つ目を ignore にしておく。inherit にすると、
  // 子どもの側がこちらの質問の答えまで読んでしまう
  const build = spawnSync('node', [path.join(ROOT, 'build.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, SPARK_FROM_PUBLISH: '1' },
  })
  if (build.status !== 0) {
    line()
    line('★ 作り直しに失敗しました。上の文字をそのまま立川さんへ送ってください。')
    return 1
  }

  // ---------- 公開してよいか ----------
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (!changed) {
    head('変わったところはありませんでした')
    line('すでに公開されている内容と同じです。')
    line(SITE_URL)
    return 0
  }

  head('これから公開します')
  line('公開すると、パスワードを知っている保護者のかたが読めるようになります。')
  line()
  for (const i of config.issues.slice(-Math.max(added, 1))) {
    if (added) line(`  ・${i.label}  （${i.pdf}）`)
  }
  if (!added) line('  ・画面や文章の直し')
  line()

  const ok = await ask('公開してよいですか？ (yes と入れると公開します)： ')
  if (ok.trim().toLowerCase() !== 'yes') {
    line()
    line('やめました。公開していません。')
    line('（作り直したものは手元に残っています。あとで同じ作業をすれば公開できます）')
    return 0
  }

  head('公開しています')
  const msg = added
    ? `${config.issues.slice(-added).map((i) => i.label).join('・')} を追加`
    : 'Spark 電子ブックの更新'
  execFileSync('git', ['add', '-A'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  if (push.status !== 0) {
    line()
    line('★ 公開に失敗しました。インターネットにつながっているか確かめてください。')
    line('  それでもだめなら、この画面をそのまま立川さんへ送ってください。')
    return 1
  }

  line()
  line('================================================')
  line('  公開しました。1〜2分でページに出ます。')
  line()
  line('  ' + SITE_URL)
  line('================================================')
  line()
  line('※ すぐ見て古いままでも、少し待って開き直せば新しくなります。')
  return 0
}

const code = await main().catch((e) => { line(); line('★ ' + e.message); return 1 })
rl.close()
process.exit(code)
