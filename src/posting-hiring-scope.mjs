// Shared overseas boards rarely publish a hiring-channel enum. Use affirmative evidence
// from the vacancy itself. Full-time, entry-level and internship alone are ambiguous.
const studentTitle = /\b(?:new[-\s]+grad(?:uate)?s?|recent graduates?|university grad(?:uate)?s?|early[-\s]+(?:career|talent)s?|campus hire|applied emerging talent|working student|graduate (?:programme?|scheme|trainee)|university (?:hire|programme?))\b|(?:^|[(,–—-])\s*graduate\s+(?:software|engineer|analyst|developer)|校招|应届/u
const studentTeam = /\b(?:university recruit(?:ing|ment)|general university|university departments?|early[-\s]+(?:careers?|talent)|campus recruitment|emerging talent)\b|^(?:university|students?|new graduates?)$/u
const schoolQualification = /\b(?:currently|actively|presently)\s+(?:be\s+)?(?:pursuing|enrolled|studying|completing|attending)|\b(?:must|should|need to|will) be (?:a |an )?(?:current(?:ly)? |enrolled |registered )*(?:undergraduate|graduate student|student|enrolled|pursuing)|\breturn(?:ing)? to (?:school|university|a degree program)|\b(?:expected|anticipated) graduation (?:date|between|in|of|year)|\bgraduat(?:ing|ed) (?:between|within (?:the )?(?:last|past)|in (?:spring |winter |fall |summer )?20\d\d)|\b(?:for|open to|seeking) (?:students|recent graduates)|\b(?:current|enrolled) (?:undergraduate|graduate|university|college|ph\.?d\.?) students?|在校(?:本科|硕士|研究|大)?生/u
// These are qualifications as phrased in actual student requisitions. Keep them gated
// by an internship title/type, since a role building education products can mention students.
const studentInternQualification = /\b(?:graduation date|expected to graduate|expected graduation)\s*(?:(?:is |in |of |between |[:(–-]\s*)*(?:spring |summer |fall |autumn |winter )?20\d\d)|\b(?:pursuing|pursuit of|working towards?|enrolled in|studying for|completing)\s+(?:(?:a|an|your|their|the)\s+)?(?:ph\.?d\.?|masters?|bachelors?|m\.?s\.?\b|b\.?s\.?\b|mba\b|j\.?d\.?\b|university|graduate|undergraduate|postgraduate|degree)\b|\b(?:return(?:ing)? to|at least one (?:semester|quarter) of) (?:university|college|school)\b|\b(?:current(?:ly)? (?:an? )?(?:college |university )?student|final[- ]year\b.{0,45}\bstudent|recent graduate \(degree completed|end[- ]of[- ]studies internship|student status|current enrollment in (?:a |an )?(?:school|university|college|degree)|(?:semester|quarter) remaining in (?:university|college|school)|(?:fourth|4th|third|3rd|second|2nd|final)[- ]year (?:undergraduate|of (?:getting|completing) a master)|enrolled in the (?:last|final) year of)\b/u
const programStaff = /\b(?:recruit(?:ers?|ing coordinators?|ing managers?)|sourcers?|early careers? recruiting|talent acquisition|campus ambassador|university relations|program(?:me)? (?:manager|director)|head of|director of|university partnerships|candidate experience coordinator)\b/u
const leadership = /\b(?:senior|sr\.|staff|principal|manager|director|head of|vice president|vp|chief|team lead|lead engineer|distinguished)\b|高级|资深|总监|负责人/u
const internship = /\b(?:interns?|internship|co[- ]?op|apprentice(?:ship)?)\b|实习/u
const htmlSpace = text => String(text || '').replace(/&lt;[^&]{1,180}?&gt;|<[^>]+>/gu, ' ').replace(/&(?:nbsp|amp);/gu, ' ').replace(/\s+/gu, ' ').toLowerCase()

export function classifyPublicPosting(provider, post) {
  const title = htmlSpace(provider === 'lever' ? post?.text : post?.title)
  if (!title) return ''
  if (/\b(?:talent (?:network|community|pool)|general application|expression of interest)\b/u.test(title)) return ''
  const teams = [post.department, post.team, post.categories?.team, post.categories?.department,
    ...(Array.isArray(post.departments) ? post.departments.map(d => d.name) : [])].filter(Boolean).map(htmlSpace)
  const jd = htmlSpace(post.descriptionPlain || post.descriptionHtml || post.content ||
    [post.description, ...(post.lists || []).map(section => section.content)].filter(Boolean).join(' '))
  const intern = internship.test(title) || internship.test(htmlSpace(post.employmentType || post.categories?.commitment))
  const runsProgram = programStaff.test(title) && !intern
  const industryTrack = /\bearly career\s*[-–(]\s*industry\b/u.test(title)
  const gradRequirement = /\b(?:you (?:will|must|should) graduate|(?:your|an) (?:expected|anticipated) graduation date) (?:in |between |of )?(?:spring |winter |fall |summer )?20\d\d/u.test(jd)
  if (!runsProgram && !industryTrack && (studentTitle.test(title) || teams.some(name => studentTeam.test(name)) ||
      (intern && (schoolQualification.test(jd) || studentInternQualification.test(jd) || /\b(?:phd|bs\/ms|mba)\b/u.test(title))) || (!leadership.test(title) && gradRequirement))) return 'campus'
  if (intern || /\b(?:junior|entry[- ]level|trainee)\b/u.test(title)) return ''
  if (leadership.test(title.replace(/\bmembers? of (?:the )?(?:technical |research )?staff\b/gu, ''))) return 'experienced'
  const years = jd.matchAll(/\b(\d{1,2})(?:\+|\s*[-–]\s*\d{1,2})?\s*(?:or more\s+)?years?(?:’|'|\s+of)?\s+(?:(?:relevant|professional|industry|software|hands[- ]on|engineering|technical|work|practical|demonstrated|related|commercial|full[- ]time)\s+){0,4}experience\b/gu)
  for (const [,minimum] of years) if (Number(minimum) >= 2) return 'experienced'
  return ''
}
