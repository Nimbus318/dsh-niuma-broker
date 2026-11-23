// macOS JavaScript for Automation. Read the public hiring page in a disposable,
// cookie-isolated WebKit view. No account, application form, or browser profile is used.
ObjC.import('Cocoa')
ObjC.import('WebKit')

function readPublicPage(requestUrl, detailId) {
  const expected = new URL(requestUrl)
  if (location.origin !== 'https://app.mokahr.com' || location.pathname !== expected.pathname) return ''
  const currentRoute = new URL(location.hash.slice(1), location.origin)
  const expectedRoute = new URL(expected.hash.slice(1), expected.origin)
  if (currentRoute.pathname !== expectedRoute.pathname) return ''
  if (detailId) {
    if (currentRoute.pathname !== '/job/' + detailId) return ''
    const description = document.querySelector('[class*="job-description-"]')
    const jd = description?.innerText.trim()
    return jd ? JSON.stringify({ jd: jd.slice(0, 12000) }) : ''
  }
  if (currentRoute.pathname !== '/jobs'
    || (currentRoute.searchParams.get('keyword') || '') !== (expectedRoute.searchParams.get('keyword') || '')
    || (currentRoute.searchParams.get('page') || '1') !== (expectedRoute.searchParams.get('page') || '1')) return ''
  const body = document.body?.innerText || ''
  const total = body.match(/(\d+)\s*(?:条?结果|results?\b)/i)
  if (!total) return ''
  const jobs = []
  for (const link of document.querySelectorAll('a[href^="#/job/"]')) {
    const id = link.hash.match(/^#\/job\/([a-z0-9-]+)(?:\?|$)/i)?.[1]
    const title = link.querySelector('[class*="title-"]')?.innerText.trim()
    if (!id || !title) continue
    const description = link.querySelector('[class*="job-description-"]') || link.querySelector('[class*="short-description-"]')
    const tags = Array.from(link.querySelectorAll('[class*="info-"] .no-adaptive-tooltip'), node => node.innerText.trim())
    const location = tags.find(tag => /市|海外|远程|美国|英国|日本|新加坡|香港|洛杉矶|硅谷|remote|beijing|shanghai/i.test(tag)) || ''
    jobs.push({ id, title, location, jd: (description?.innerText.trim() || description?.textContent.trim() || '').slice(0, 12000) })
  }
  if (Number(total[1]) && !jobs.length) return ''
  const currentPage = Number(document.querySelector('button[class*="Pagination-is-active"]')?.innerText) || 1
  const nextButton = document.querySelector('button[class*="Pagination-forward"]')
  return JSON.stringify({ jobs, currentPage, more: Boolean(nextButton && !nextButton.disabled), total: Number(total[1]) })
}

function spin(milliseconds) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(milliseconds / 1000))
}
function run(args) {
  const input = JSON.parse(args[0])
  const base = input.base
  if (!/^https:\/\/app\.mokahr\.com\/(apply|social-recruitment|campus-recruitment)\/[a-z0-9-]+\/\d+$/.test(base)) throw Error('Invalid public project')
  $.NSApplication.sharedApplication
  const config = $.WKWebViewConfiguration.alloc.init
  config.websiteDataStore = $.WKWebsiteDataStore.nonPersistentDataStore
  const deadline = Date.now() + 40500
  function load(hash, pageNo) {
    const expression = '(' + readPublicPage.toString() + ')(' + JSON.stringify(base + hash) + ',' + JSON.stringify(input.detailId || '') + ')'

    const view = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, 1200, 800), config)
    const url = $.NSURL.URLWithString($(base + hash))
    view.loadRequest($.NSURLRequest.requestWithURL(url))
    const until = Math.min(deadline, Date.now() + 12000)
    let emptySince = 0
    try {
      while (Date.now() < until) {
        spin(160)
        // Fonts, images and analytics may still be loading after the new view
        // has rendered valid jobs. Check the expected project and route in-page.
        let done = false, value = null
        view.evaluateJavaScriptCompletionHandler(expression, (result, error) => {
          if (result) value = ObjC.unwrap(result)
          done = true
        })
        while (!done && Date.now() < until) spin(40)
        if (!value) continue
        const data = JSON.parse(value)
        if (data.jd || (data.currentPage === pageNo && data.jobs.length)) return data
        if (data.total === 0 && pageNo === 1) {
          if (!emptySince) emptySince = Date.now()
          if (Date.now() - emptySince > 1000) return data
        }
      }
      throw Error('Public job page did not finish rendering')
    } finally { view.stopLoading }
  }
  if (input.detailId) return JSON.stringify(load('#/job/' + input.detailId, 1))
  const rows = new Map()
  let pages = 0
  let attempts = 0
  let truncated = false
  const keywords = input.queries.slice(0, 4)
  // Visit the first page for each search before consuming the rest of a large one.
  const queue = keywords.map(keyword => ({ keyword, page: 1 }))
  let unfiltered = keywords.includes('')
  while (queue.length && attempts < 6 && Date.now() < deadline - 1000) {
    const { keyword, page } = queue.shift()
    attempts++
    const query = '#/jobs?page=' + page + '&pageSize=30&keyword=' + encodeURIComponent(keyword)
    try {
      const data = load(query, page)
      pages++
      for (const row of data.jobs) rows.set(row.id, row)
      if (data.more && rows.size < 180) queue.push({ keyword, page: page + 1 })
    } catch {
      truncated = true
    }
    if (!queue.length && !rows.size && !unfiltered) { unfiltered = true; queue.push({ keyword: '', page: 1 }) }
  }
  if (!pages || (truncated && !rows.size)) throw Error('Public job listing unavailable')
  return JSON.stringify({ jobs: Array.from(rows.values()), pages, truncated: truncated || Boolean(queue.length) })
}
