import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPublicPosting } from '../src/posting-hiring-scope.mjs';

test('overseas recruiting staff, education customers and industry track are not campus hires', () => {
  const cases = [
    { title: 'Senior Manager, Early Careers Recruiting', departments: [{ name: 'Early Careers' }], expected: 'experienced' },
    { title: 'Talent Discovery Sourcer', departments: [{ name: 'Early Talent Recruiting' }], expected: '' },
    { title: 'Solutions Engineer - Ads Product & Innovation', departments: [{ name: 'University Sales' }], content: '2+ years of industry experience', expected: 'experienced' },
    { title: 'AI Education Content Producer', content: 'Materials for students currently enrolled in a degree.', expected: '' },
    { title: 'Machine Learning Engineer - Early Career - Industry', expected: '' },
    { title: 'Member of Technical Staff', expected: '' },
  ];
  for (const { expected, ...post } of cases) assert.equal(classifyPublicPosting('greenhouse', post), expected, post.title);
});

test('school qualification in a JD distinguishes true co-ops and university internships', () => {
  for (const [title, description, expected] of [
    ['Machine Learning Intern', 'Applicants should be working towards a PhD in computer science.', 'campus'],
    ['Infrastructure Intern', 'Fixed-term role, six months.', ''],
    ['Systems Co-op', 'Your graduation date is in Spring 2027.', 'campus'],
    ['Software Engineer', 'You must graduate in Spring 2027.', 'campus'],
    ['Senior Software Engineer', 'Experience hiring students graduating in spring 2027.', 'experienced'],
  ]) assert.equal(classifyPublicPosting('ashby', { title, descriptionPlain: description }), expected, title);
});
