/*
 * Spark 電子ブック
 *
 * 置いてあるファイル(.enc)はすべてパスワードで暗号化されている。
 * パスワードから鍵を作り、読むときにブラウザの中だけで元に戻す。
 * サーバー側に仕掛けがないため、静的なホスティングだけで動く（＝無料で続けられる）。
 */
(function () {
  'use strict'

  var DATA = 'd/'
  var STORE_KEY = 'spark.key.v1'

  var el = {
    lock: document.getElementById('lock'),
    lockForm: document.getElementById('lock-form'),
    lockBtn: document.getElementById('lock-btn'),
    lockMsg: document.getElementById('lock-msg'),
    pw: document.getElementById('pw'),

    shelf: document.getElementById('shelf'),
    shelfGroups: document.getElementById('shelf-groups'),
    pastHead: document.getElementById('past-head'),
    hero: document.getElementById('hero'),
    heroBtn: document.getElementById('hero-btn'),
    heroCover: document.querySelector('#hero-btn .cover'),
    heroLabel: document.getElementById('hero-label'),
    heroPages: document.getElementById('hero-pages'),
    heroRead: document.getElementById('hero-read'),
    forget: document.getElementById('forget'),

    reader: document.getElementById('reader'),
    readerTitle: document.getElementById('reader-title'),
    back: document.getElementById('back'),
    zoom: document.getElementById('zoom'),
    stage: document.getElementById('stage'),
    book: document.getElementById('book'),
    loading: document.getElementById('loading'),
    loadingMsg: document.getElementById('loading-msg'),
    progressBar: document.getElementById('progress-bar'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    pageno: document.getElementById('pageno')
  }

  var cryptoKey = null      // 復号につかう鍵
  var keyInfo = null        // salt など（パスワードそのものは入っていない）
  var manifest = null       // 号の一覧
  var flip = null           // ページめくり本体
  var objectUrls = []       // 作った画像URL（あとで開放する）
  var coverUrls = []
  var loadToken = 0         // 読み込み中に別の号へ移ったときの打ち切り用
  var pageWidthPx = 0       // いま表示している紙1枚の幅
  var isPortrait = false    // スマホなど、1ページずつ表示しているか

  // ---------- 下ごしらえ ----------

  function show(screen) {
    ;[el.lock, el.shelf, el.reader].forEach(function (s) { s.hidden = s !== screen })
  }

  function b64ToBytes(b64) {
    var bin = atob(b64)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function bytesToB64(bytes) {
    var s = ''
    var a = new Uint8Array(bytes)
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i])
    return btoa(s)
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' が読めません (' + r.status + ')')
      return r.json()
    })
  }

  /*
   * 暗号化されたファイルを取ってきて元に戻す。
   * 号の中身は一度作ったら変わらないのでブラウザに覚えさせてよいが、
   * 一覧（manifest）は号が増えるたびに変わるので、毎回確かめに行く。
   * （これをしないと、新しい号を出しても数分〜数時間出てこない）
   */
  function getSealed(url, fresh) {
    return fetch(url, fresh ? { cache: 'no-cache' } : undefined).then(function (r) {
      if (!r.ok) throw new Error(url + ' が読めません (' + r.status + ')')
      return r.arrayBuffer()
    }).then(unseal)
  }

  function unseal(buf) {
    var iv = new Uint8Array(buf, 0, 12)
    var body = new Uint8Array(buf, 12)
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, cryptoKey, body)
  }

  function blobUrl(buf) {
    return URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }))
  }

  // ---------- パスワード ----------

  function deriveKey(password) {
    var enc = new TextEncoder()
    return crypto.subtle
      .importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: b64ToBytes(keyInfo.salt), iterations: keyInfo.iter, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          true,
          ['decrypt']
        )
      })
  }

  /** 鍵が正しいか、小さな箱をあけて確かめる */
  function verify() {
    return unseal(b64ToBytes(keyInfo.check).buffer)
      .then(function (buf) { return new TextDecoder().decode(buf) === 'spark-ok' })
      .catch(function () { return false })
  }

  function start() {
    if (!window.crypto || !crypto.subtle) {
      el.lockMsg.textContent = 'このブラウザでは表示できません。Safari か Chrome の新しい版でお試しください。'
      show(el.lock)
      return
    }
    getJson(DATA + 'key.json').then(function (info) {
      keyInfo = info
      var saved = localStorage.getItem(STORE_KEY)
      if (!saved) return show(el.lock)
      // 前に入れたパスワードをおぼえている場合は、そのまま一覧へ
      return crypto.subtle.importKey('raw', b64ToBytes(saved), { name: 'AES-GCM' }, true, ['decrypt'])
        .then(function (k) { cryptoKey = k; return verify() })
        .then(function (ok) {
          if (!ok) { forget(); return show(el.lock) }
          return enter()
        })
        .catch(function () { forget(); show(el.lock) })
    }).catch(function (e) {
      el.lockMsg.textContent = 'データが読み込めませんでした。' + e.message
      show(el.lock)
    })
  }

  function forget() {
    localStorage.removeItem(STORE_KEY)
    cryptoKey = null
    manifest = null
  }

  el.lockForm.addEventListener('submit', function (e) {
    e.preventDefault()
    var pw = el.pw.value
    if (!pw) return
    el.lockBtn.disabled = true
    el.lockMsg.className = 'msg ok'
    el.lockMsg.textContent = '確かめています…'
    deriveKey(pw)
      .then(function (k) { cryptoKey = k; return verify() })
      .then(function (ok) {
        if (!ok) {
          cryptoKey = null
          el.lockMsg.className = 'msg'
          el.lockMsg.textContent = 'パスワードがちがうようです。もう一度お試しください。'
          el.lockBtn.disabled = false
          el.pw.select()
          return
        }
        return crypto.subtle.exportKey('raw', cryptoKey).then(function (raw) {
          localStorage.setItem(STORE_KEY, bytesToB64(raw))
          el.pw.value = ''
          el.lockMsg.textContent = ''
          el.lockBtn.disabled = false
          return enter()
        })
      })
      .catch(function (err) {
        el.lockMsg.className = 'msg'
        el.lockMsg.textContent = 'うまくいきませんでした。' + err.message
        el.lockBtn.disabled = false
      })
  })

  el.forget.addEventListener('click', function () {
    forget()
    releaseCovers()
    location.hash = ''
    show(el.lock)
  })

  // ---------- 本だな ----------

  function enter() {
    return getSealed(DATA + 'manifest.enc', true).then(function (buf) {
      manifest = JSON.parse(new TextDecoder().decode(buf))
      renderShelf()
      route()
    })
  }

  function releaseCovers() {
    coverUrls.forEach(URL.revokeObjectURL)
    coverUrls = []
    el.shelfGroups.innerHTML = ''
    el.hero.hidden = true
    el.pastHead.hidden = true
  }

  /** 表紙をあとから流し込む（暗号を戻すのに少し時間がかかるため） */
  function fillCover(issue, target) {
    getSealed(DATA + issue.id + '/c.enc' + ver(issue)).then(function (buf) {
      var url = blobUrl(buf)
      coverUrls.push(url)
      target.style.backgroundImage = 'url("' + url + '")'
    }).catch(function () { /* 表紙が出なくても読むことはできる */ })
  }

  /* 号を作り直したとき、ブラウザが古い画像を使い続けないようにする合図 */
  function ver(issue) {
    return issue.v ? '?v=' + issue.v : ''
  }

  function yearOf(issue) {
    return issue.year || String(issue.id).slice(0, 4)
  }

  function renderShelf() {
    releaseCovers()

    // config.json の並び順が古い順。いちばん最後が最新号
    var issues = manifest.issues.slice()
    var latest = issues.pop()

    if (latest) {
      el.heroLabel.textContent = latest.label
      el.heroPages.textContent = latest.pages + 'ページ'
      el.hero.hidden = false
      fillCover(latest, el.heroCover)
      var openLatest = function () { location.hash = '#/' + latest.id }
      el.heroBtn.onclick = openLatest
      el.heroRead.onclick = openLatest
    }

    if (!issues.length) return
    el.pastHead.hidden = false

    // 古い順のまま、年ごとにまとめる（左から右へ進むほど新しい号になる）
    var groups = []
    issues.forEach(function (issue) {
      var y = yearOf(issue)
      var g = groups[groups.length - 1]
      if (!g || g.year !== y) { g = { year: y, items: [] }; groups.push(g) }
      g.items.push(issue)
    })

    groups.forEach(function (group) {
      var head = document.createElement('h3')
      head.className = 'year-head'
      head.textContent = group.year + '年'
      el.shelfGroups.appendChild(head)

      var ul = document.createElement('ul')
      ul.className = 'shelf-list'
      group.items.forEach(function (issue) {
        var li = document.createElement('li')
        li.className = 'shelf-item'

        var btn = document.createElement('button')
        btn.type = 'button'

        var cover = document.createElement('span')
        cover.className = 'cover'
        var label = document.createElement('span')
        label.className = 'label'
        label.textContent = issue.label
        var pages = document.createElement('span')
        pages.className = 'pages'
        pages.textContent = issue.pages + 'ページ'

        btn.appendChild(cover)
        btn.appendChild(label)
        btn.appendChild(pages)
        btn.addEventListener('click', function () { location.hash = '#/' + issue.id })

        li.appendChild(btn)
        ul.appendChild(li)
        fillCover(issue, cover)
      })
      el.shelfGroups.appendChild(ul)
    })
  }

  // ---------- 読む ----------

  /*
   * page-flip は destroy() のときに、渡した入れ物ごと画面から消してしまう。
   * そのため毎回あたらしい入れ物を作り直す。
   * （作り直さないと、2冊目を開いたときに何も出なくなる）
   */
  function freshBook() {
    if (el.book && el.book.parentNode) el.book.parentNode.removeChild(el.book)
    var div = document.createElement('div')
    div.className = 'book'
    el.stage.appendChild(div)
    el.book = div
    return div
  }

  function releasePages() {
    if (flip) { try { flip.destroy() } catch (e) {} flip = null }
    objectUrls.forEach(URL.revokeObjectURL)
    objectUrls = []
    freshBook()
  }

  function openIssue(issue) {
    releasePages()
    var token = ++loadToken
    el.readerTitle.textContent = issue.label
    el.pageno.textContent = '- / ' + issue.pages
    el.loading.hidden = false
    el.progressBar.style.width = '0%'
    el.loadingMsg.textContent = 'よみこみ中… 0 / ' + issue.pages
    show(el.reader)

    var urls = new Array(issue.pages)
    var done = 0
    var nextIndex = 0

    // 全ページを順に取り出す（同時に走らせすぎないよう4本ずつ）
    function worker() {
      if (token !== loadToken) return Promise.resolve()
      var i = nextIndex++
      if (i >= issue.pages) return Promise.resolve()
      var name = 'p' + String(i + 1).padStart(3, '0') + '.enc'
      return getSealed(DATA + issue.id + '/' + name + ver(issue)).then(function (buf) {
        if (token !== loadToken) return
        var url = blobUrl(buf)
        objectUrls.push(url)
        urls[i] = url
        done++
        el.progressBar.style.width = Math.round(done / issue.pages * 100) + '%'
        el.loadingMsg.textContent = 'よみこみ中… ' + done + ' / ' + issue.pages
        return worker()
      })
    }

    var lanes = []
    for (var w = 0; w < Math.min(4, issue.pages); w++) lanes.push(worker())

    Promise.all(lanes).then(function () {
      if (token !== loadToken) return
      el.loading.hidden = true
      buildFlip(urls, issue)
    }).catch(function (err) {
      if (token !== loadToken) return
      el.loadingMsg.textContent = '読み込めませんでした。' + err.message
    })
  }

  function buildFlip(urls, issue) {
    // 画面の大きさに合わせて本の大きさを決める（A4 のたて長 1 : 1.414）
    var stageRect = el.stage.getBoundingClientRect()
    isPortrait = window.innerWidth < 768
    var availH = Math.max(260, stageRect.height - 8)
    var availW = Math.max(220, stageRect.width - 8)
    var pageH = availH
    var pageW = pageH / 1.414
    var spread = isPortrait ? pageW : pageW * 2
    if (spread > availW) {
      var k = availW / spread
      pageW *= k
      pageH *= k
    }
    pageWidthPx = Math.round(pageW)

    flip = new St.PageFlip(el.book, {
      width: pageWidthPx,
      height: Math.round(pageH),
      size: 'fixed',
      showCover: true,
      usePortrait: true,
      mobileScrollSupport: false,
      maxShadowOpacity: 0.5,
      drawShadow: true,
      flippingTime: 700
    })

    flip.loadFromImages(urls)
    flip.on('flip', function () { sync(issue) })
    sync(issue)
  }

  /*
   * 表紙と裏表紙は1枚だけで出る。そのままだと画面の右半分・左半分に寄って
   * 見えるので、紙半分ぶん横へずらして中央に置く。
   */
  function centerLonePage(issue) {
    var dx = 0
    if (!isPortrait && flip) {
      var i = flip.getCurrentPageIndex()
      if (i === 0) dx = -pageWidthPx / 2                                  // 表紙は右半分に出る
      else if (i === issue.pages - 1 && issue.pages % 2 === 0) dx = pageWidthPx / 2 // 裏表紙は左半分
    }
    el.book.style.transform = dx ? 'translateX(' + dx + 'px)' : ''
  }

  function sync(issue) {
    if (!flip) return
    var i = flip.getCurrentPageIndex()
    el.pageno.textContent = (i + 1) + ' / ' + issue.pages
    el.prev.disabled = i <= 0
    el.next.disabled = i >= issue.pages - 1
    centerLonePage(issue)
  }

  el.prev.addEventListener('click', function () { if (flip) flip.flipPrev() })
  el.next.addEventListener('click', function () { if (flip) flip.flipNext() })

  document.addEventListener('keydown', function (e) {
    if (el.reader.hidden || !flip) return
    if (e.key === 'ArrowLeft') { flip.flipPrev(); e.preventDefault() }
    if (e.key === 'ArrowRight') { flip.flipNext(); e.preventDefault() }
    if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen()
  })

  el.zoom.addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen()
    else if (el.reader.requestFullscreen) el.reader.requestFullscreen()
  })

  el.back.addEventListener('click', function () { location.hash = '' })

  // 画面の向きや大きさが変わったら本を作り直す
  var resizeTimer = null
  window.addEventListener('resize', function () {
    if (el.reader.hidden || !flip) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      var issue = currentIssue()
      if (!issue || !flip) return
      var page = flip.getCurrentPageIndex()
      var urls = objectUrls.slice()
      try { flip.destroy() } catch (e) {}
      flip = null
      freshBook()
      buildFlip(urls, issue)
      if (page > 0) flip.turnToPage(page)
      sync(issue)
    }, 250)
  })

  // ---------- 画面の切り替え（URL の #） ----------

  function currentIssue() {
    if (!manifest) return null
    var id = location.hash.replace(/^#\/?/, '')
    if (!id) return null
    return manifest.issues.filter(function (i) { return i.id === id })[0] || null
  }

  function route() {
    if (!cryptoKey || !manifest) { show(el.lock); return }
    var issue = currentIssue()
    if (issue) openIssue(issue)
    else { releasePages(); show(el.shelf) }
  }

  window.addEventListener('hashchange', route)

  start()
})()
