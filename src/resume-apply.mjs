export const resumeBullet = /^([ \t]*(?:(?:[-*+]|[1-9]\d?[.)])[ \t]+|(?:[•·▪●○]|[1-9]\d?、)[ \t]*))(\S.*)$/u
const sectionHeading = /^(?:#{1,6}\s+|(?:个人简介|个人概述|工作经历|项目经历|教育经历|获奖情况|技能清单|专业技能|联系方式|Summary|Experience|Education|Skills|Contact)\s*[:：]?\s*$)/iu
const protectedLine = /(?:https?:\/\/|[\w.%+-]+@[\w.-]+\.[a-z]{2,}|(?:^|[\s:：])\+?\d[\d\s().-]{6,}\d(?:$|\s))|^(?:邮件|邮箱|电话|地址|微信|LinkedIn|Email|Phone)\s*[:：]/iu
const structuralLine = /^(?:#{1,6}\s|\s*(?:[-*_]\s*){3,}$|[|<>]|\[!|!\[|\x60{3,}|~{3,}|\uFEFF)/u

export function candidateLines(lines) {
  const first = lines.findIndex(line => line.trim())
  const records = []
  let fence = ''
  let privateSection = false
  let group = 0
  let previousStyle = ''
  let nextIndent = 0
  const followingIndent = lines.map(() => 0)
  for (let index = lines.length - 1; index >= 0; index--) {
    followingIndent[index] = nextIndent
    if (lines[index].trim()) nextIndent = lines[index].match(/^[ \t]*/u)[0].length
  }
  lines.forEach((original, index) => {
    const trimmed = original.trim()
    const marker = trimmed.match(/^(\x60{3,}|~{3,})/u)?.[1]?.[0]
    if (marker) {
      if (marker === fence) fence = ''
      else if (!fence) fence = marker
      previousStyle = ''
      return
    }
    if (fence) return
    if (sectionHeading.test(trimmed)) {
      privateSection = /^(?:#{1,6}\s+)?(?:联系方式|联系信息|个人信息|Contact(?: Information)?)\s*[:：]?\s*$/iu.test(trimmed)
      previousStyle = ''
      return
    }
    const bullet = resumeBullet.exec(original)
    if (!trimmed || (index === first && !bullet) || privateSection
      || structuralLine.test(trimmed) || protectedLine.test(trimmed)) {
      previousStyle = ''
      return
    }
    const prefix = bullet?.[1] ?? original.match(/^[ \t]*/u)[0]
    const text = bullet?.[2] ?? trimmed
    const indent = prefix.match(/^[ \t]*/u)[0].length
    // A bullet with children must stay in place so the children retain their parent.
    const style = bullet && followingIndent[index] <= indent ? prefix.replace(/\d+/u, '#') : ''
    if (!style || style !== previousStyle) group++
    records.push({ index, original, prefix, text, group: style ? group : null })
    previousStyle = style
  })
  return records
}

function wording(value) {
  if (typeof value !== 'string' || value.length > 6000 || /[\r\n\u0000]/u.test(value)) throw new Error('每项简历改动应是一行文字。')
  const text = value.trim()
  if (!text || structuralLine.test(text) || resumeBullet.test(text)) throw new Error('简历改动应为正文，请保留现有段落结构。')
  return text
}

export function applyTailoredSelection(markdown, items) {
  if (!Array.isArray(items) || !items.length) return markdown
  const base = markdown.split(/\r?\n/u)
  const counts = new Map()
  for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1)
  const eligible = new Set(base.filter(line => resumeBullet.test(line) && counts.get(line) === 1))
  const selections = new Set()
  const groupBySource = new Map()
  const groups = []
  const following = Array(base.length)
  let next = ''
  for (let index = base.length - 1; index >= 0; index -= 1) {
    following[index] = next
    if (base[index].trim()) next = base[index]
  }
  let current
  base.forEach((line, index) => {
    const bullet = resumeBullet.exec(line)
    if (!bullet) { current = null; return }
    const [, prefix, text] = bullet
    const indentation = value => value.match(/^[ \t]*/u)[0].length
    const hasContinuation = indentation(following[index]) > indentation(prefix)
    const style = prefix.replace(/\d+/u, '#') + (hasContinuation ? `@${index}` : '')
    if (current?.style !== style) {
      current = { style, original: [], ranked: [] }
      groups.push(current)
    }
    current.original.push({ line, index, prefix, text })
    if (eligible.has(line)) groupBySource.set(line, current)
  })
  for (const item of items) {
    if (!eligible.has(item.source) || selections.has(item.source)) return markdown
    selections.add(item.source)
    groupBySource.get(item.source).ranked.push(item.text)
  }
  for (const group of groups) {
    if (!group.ranked.length) continue
    const words = [...group.ranked, ...group.original.filter(row => !selections.has(row.line)).map(row => row.text)]
    group.original.forEach((row, index) => { base[row.index] = `${row.prefix}${words[index]}` })
  }
  return base.join(markdown.includes('\r\n') ? '\r\n' : '\n')
}

export function applyResumeConversation(source, items) {
  const lines = source.split(/\r?\n/u)
  const candidates = candidateLines(lines)
  const byIndex = new Map(candidates.map(row => [row.index, row]))
  const edits = new Map()
  const promotions = new Map()
  for (const item of items) {
    const row = byIndex.get(item.line)
    if (!row || row.original !== item.source || edits.has(item.line)) throw new Error('无法将优化建议唯一对应到简历原文。')
    edits.set(item.line, wording(item.text))
    if (item.promote) {
      if (row.group === null) throw new Error('该段落需要留在原位。')
      if (!promotions.has(row.group)) promotions.set(row.group, [])
      promotions.get(row.group).push(row.index)
    }
  }
  for (const [index, text] of edits) lines[index] = byIndex.get(index).prefix + text
  for (const [group, ordered] of promotions) {
    const members = candidates.filter(row => row.group === group)
    const promoted = new Set(ordered)
    const words = [...ordered, ...members.filter(row => !promoted.has(row.index)).map(row => row.index)]
      .map(index => edits.get(index) ?? byIndex.get(index).text)
    members.forEach((row, position) => { lines[row.index] = row.prefix + words[position] })
  }
  return lines.join(source.includes('\r\n') ? '\r\n' : '\n')
}
