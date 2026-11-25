export function isDerivedFromLockedOrigin(origin, current) {
  const originStr = String(origin ?? '')
  const currentStr = String(current ?? '')
  const originTrim = originStr.trim()
  const currentTrim = currentStr.trim()
  if (!originTrim || !currentTrim) return false
  if (currentStr === originStr || currentTrim.includes(originTrim)) return true
  if (originTrim.includes(currentTrim)) {
    return currentTrim.length >= Math.min(originTrim.length, 6)
      || currentTrim.length >= originTrim.length * 0.5
  }

  let lcp = 0
  const maxCommon = Math.min(originStr.length, currentStr.length)
  while (lcp < maxCommon && originStr.charCodeAt(lcp) === currentStr.charCodeAt(lcp)) {
    lcp += 1
  }
  let lcs = 0
  while (
    lcs < maxCommon - lcp
    && originStr.charCodeAt(originStr.length - 1 - lcs) === currentStr.charCodeAt(currentStr.length - 1 - lcs)
  ) {
    lcs += 1
  }
  const preserved = lcp + lcs
  const minLen = Math.min(originStr.length, currentStr.length)
  const minKeep = Math.min(4, Math.max(1, Math.ceil(minLen * 0.35)))
  return preserved >= minKeep && (preserved / originStr.length >= 0.25 || preserved >= 8)
}
