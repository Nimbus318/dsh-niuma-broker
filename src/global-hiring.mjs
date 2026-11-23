// Brand career sites announce these programs; the public ATS is the vacancy source.
// A campus watch can legitimately return zero between cohorts. Keep the unfiltered
// board ID as the default for users who did not specify a hiring channel.
const sources = [
  ["ashby:openai", "https://openai.com/careers/search/", true, "https://openai.com/careers/emerging-talent/"],
  ["greenhouse:anthropic", "https://www.anthropic.com/careers", false],
  ["greenhouse:databricks", "https://www.databricks.com/company/careers/open-positions", true, "https://www.databricks.com/company/careers/open-positions?department=University%20Recruiting&location=all", ["https://www.databricks.com/company/careers/university-recruiting"]],
  ["greenhouse:stripe", "https://stripe.com/careers/search", true, "https://stripe.com/careers/emerging-talent"],
  ["greenhouse:cloudflare", "https://www.cloudflare.com/careers/jobs/", true, "https://www.cloudflare.com/careers/jobs/?department=Early+Talent", ["https://www.cloudflare.com/careers/early-talent/"]],
  ["greenhouse:airbnb", "https://careers.airbnb.com/positions/", true, "https://careers.airbnb.com/positions/?_departments=early-career-program-intern", ["https://careers.airbnb.com/internship-programs/"]],
  ["greenhouse:doordashusa", "https://careersatdoordash.com/", true, "https://careersatdoordash.com/university-careers/"],
  ["greenhouse:coinbase", "https://www.coinbase.com/careers/positions", true, "https://www.coinbase.com/careers/internships"],
  ["ashby:snowflake", "https://careers.snowflake.com/", true, "https://careers.snowflake.com/university"],
  ["greenhouse:datadog", "https://careers.datadoghq.com/all-jobs/", true, "https://careers.datadoghq.com/early-careers/"],
  ["greenhouse:mongodb", "https://www.mongodb.com/company/careers", true, "https://www.mongodb.com/company/careers/students-and-graduates"],
  ["greenhouse:gitlab", "https://about.gitlab.com/jobs/", true],
  ["greenhouse:waymo", "https://careers.withwaymo.com/jobs/search/", true, "https://careers.withwaymo.com/early-careers"],
  ["greenhouse:reddit", "https://redditinc.com/careers", true],
  ["greenhouse:pinterest", "https://www.pinterestcareers.com/", true, "https://www.pinterestcareers.com/early-career/university-recruiting"],
  ["lever:spotify", "https://www.lifeatspotify.com/jobs", true, "https://www.lifeatspotify.com/find-your-team/job-categories/students"],
  ["ashby:cursor", "https://cursor.com/careers", false],
  ["greenhouse:xai", "https://x.ai/careers/open-roles", true],
  ["greenhouse:scaleai", "https://scale.com/careers", true, "https://scale.com/careers?department=University", ["https://scale.com/careers/university"]],
  ["greenhouse:vercel", "https://vercel.com/careers", true],
  ["greenhouse:figma", "https://www.figma.com/careers/", true, "https://www.figma.com/careers/early-career/"],
  ["ashby:linear", "https://linear.app/careers", false],
  ["ashby:notion", "https://www.notion.com/careers", true],
  ["ashby:perplexity", "https://www.perplexity.ai/hub/careers", true],
  ["ashby:cohere", "https://cohere.com/careers", true, "https://jobs.ashbyhq.com/cohere?departmentId=85ffbfe8-9ded-4a4e-bd4a-f173af9bc773", ["https://cohere.com/careers/internships"]],
  ["ashby:elevenlabs", "https://elevenlabs.io/careers/positions", false],
  ["ashby:cognition", "https://cognition.ai/careers", false],
  ["ashby:supabase", "https://supabase.com/careers", false],
  ["greenhouse:microsoftcorporation", "https://microsoft.ai/careers/", false],
  ["greenhouse:coreweave", "https://www.coreweave.com/careers", true],
  ["greenhouse:nebius", "https://nebius.com/careers", true, "https://nebius.com/early-talent-program"],
  ["ashby:lambda", "https://lambda.ai/careers", true],
  ["ashby:baseten", "https://www.baseten.co/resources/careers/", false],
  ["ashby:fireworks", "https://fireworks.ai/careers", true],
  ["ashby:crusoe", "https://www.crusoe.ai/about/careers", true, "https://www.crusoe.ai/about/careers/early-careers"],
  ["ashby:radixark", "https://www.radixark.com/", false],
  ["ashby:modal", "https://modal.com/careers", true],
  ["ashby:cerebras", "https://www.cerebras.ai/open-positions", true, "https://www.cerebras.ai/interns"],
  ["greenhouse:togetherai", "https://www.together.ai/careers", true],
  ["ashby:mistral.ai", "https://mistral.ai/careers", true],
  ["ashby:inferact", "https://inferact.ai/careers", true],
]

export const GLOBAL_HIRING_CHANNELS = Object.fromEntries(sources.map(([key, official, campusWatch, campusUrl, aliases]) => {
  const slug = key.split(':')[1]
  const filtered = scope => ({ slug: slug + '__' + scope, upstreamSlug: slug, filterHiringScope: true })
  const channels = {
    all: { entranceUrls: [official] },
    experienced: filtered('experienced'),
  }
  if (key === 'ashby:cursor') {
    // The published Ashby data is live, but Cursor serves the actual board and JDs here.
    channels.all.host = channels.experienced.host = 'cursor.com/careers'
  }
  if (campusWatch) {
    channels.campus = {
      ...filtered('campus'),
      ...(campusUrl && { host: campusUrl.slice('https://'.length) }),
      ...(aliases && { entranceUrls: aliases }),
    }
  } else {
    channels.manualHiring = { campus: official }
  }
  return [key, channels]
}))
