import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { deletePersonalSchedule, listPersonalTargets, validateScheduleItem, writePersonalSchedule } from '../src/personal-schedule.mjs';

const base = { id: 'job-42:first-round', title: '虚构面试', notes: '样例备注' };
const calendarInput = { ...base, destination: 'calendar', target: 'Test', startsAt: '2030-01-02T09:00:00+08:00', endsAt: '2030-01-02T10:00:00+08:00' };

function collection(rows) {
  const result = () => rows;
  result.whose = condition => () => rows.filter(item => Object.entries(condition).every(([field, expected]) => {
    if (typeof expected === 'object') return String(item[field]()).includes(expected._contains);
    return item[field]() === expected;
  }));
  result.push = item => rows.push(item);
  return result;
}

function nativeObject(fields) {
  return new Proxy(fields, { get: (target, key) => () => target[key] ?? null });
}

function modelRunner() {
  const events = [];
  const reminders = [];
  const toDos = [];
  let nextId = 0;
  const app = {
    'com.apple.iCal': {
      calendars: collection([{ calendarIdentifier: () => 'test-cal', name: () => 'Test', writable: () => true, events: collection(events) }]),
      Event: fields => nativeObject({ ...fields, uid: `event-${++nextId}`, alldayEvent: false }),
    },
    'com.apple.reminders': {
      lists: collection([{ id: () => 'test-list', name: () => 'Test', reminders: collection(reminders) }]),
      Reminder: fields => nativeObject({ ...fields, id: `reminder-${++nextId}` }),
    },
    'com.culturedcode.ThingsMac': {
      projects: collection([]), toDos: collection(toDos),
      ToDo: fields => nativeObject({ ...fields, id: `things-${++nextId}` }),
    },
  };
  const runner = async (executable, args) => {
    assert.equal(executable, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.equal(args[4], '--');
    assert.equal(args.length, 6);
    assert.doesNotMatch(args[3], /样例备注|虚构面试/);
    const stdout = runInNewContext(`${args[3]}\nrun([data])`, { Application: id => app[id], data: args[5] });
    return { stdout };
  };
  return { platform: 'darwin', runner };
}

test('Calendar binds a stable marker, rereads exact event fields and retimes one item', async () => {
  const options = modelRunner();
  assert.deepEqual(await listPersonalTargets('calendar', options), [{ name: 'Test', id: 'test-cal' }]);
  const initial = await writePersonalSchedule(calendarInput, options);
  assert.equal(initial.change, 'created');
  assert.equal(initial.startsAt, '2030-01-02T01:00:00.000Z');
  const replay = await writePersonalSchedule(calendarInput, options);
  assert.equal(replay.remoteId, initial.remoteId);
  assert.equal(replay.change, 'unchanged');
  const update = await writePersonalSchedule({ ...calendarInput, remoteId: initial.remoteId, title: '调整后的面试', startsAt: '2030-01-02T11:00:00+08:00', endsAt: '2030-01-02T12:00:00+08:00' }, options);
  assert.equal(update.remoteId, initial.remoteId);
  assert.equal(update.change, 'updated');
  await assert.rejects(() => writePersonalSchedule({ ...calendarInput, remoteId: 'changed-external-id' }, options), /为避免重复/);
});

test('Reminders supports undated tasks and retains the same ID when adding and clearing a cutoff', async () => {
  const options = modelRunner();
  const input = { ...base, destination: 'reminders', target: 'Test' };
  const initial = await writePersonalSchedule(input, options);
  assert.ok(!('dueAt' in initial));
  const dueAt = '2030-01-03T09:00:00+08:00';
  const update = await writePersonalSchedule({ ...input, remoteId: initial.remoteId, dueAt }, options);
  assert.equal(update.remoteId, initial.remoteId);
  assert.equal(update.dueAt, '2030-01-03T01:00:00.000Z');
  const cleared = await writePersonalSchedule({ ...input, remoteId: initial.remoteId }, options);
  assert.equal(cleared.remoteId, initial.remoteId);
  assert.equal(cleared.change, 'updated');
});

test('Things preserves local deadline day and records absolute cutoff separately', async () => {
  const options = modelRunner();
  const input = { ...base, destination: 'things', dueAt: '2030-01-02T23:00:00Z', timezone: 'Asia/Shanghai' };
  const item = validateScheduleItem(input);
  assert.equal(item.deadline, '2030-01-03');
  assert.match(item.dueLabel, /2030-01-03 07:00:00/);
  assert.deepEqual(await listPersonalTargets('things', options), [{ name: 'Inbox' }]);
  const [created, replay] = await Promise.all([writePersonalSchedule(input, options), writePersonalSchedule(input, options)]);
  assert.equal(created.deadline, '2030-01-03');
  assert.equal(created.remoteId, replay.remoteId);
  assert.equal(replay.change, 'unchanged');
});

test('rejects invalid dates and does not report a native write without readback', async () => {
  assert.throws(() => validateScheduleItem({ ...calendarInput, startsAt: '2030-02-31T03:00:00Z' }), /无效/);
  const fractional = validateScheduleItem({ ...base, destination: 'reminders', target: '工作', dueAt: '2030-01-03T09:12:34.258Z' });
  assert.equal(fractional.dueAt, '2030-01-03T09:12:34.000Z');
  const options = { platform: 'darwin', runner: async () => ({ stdout: JSON.stringify({ change: 'created', remoteId: 'unverified' }) }) };
  await assert.rejects(() => writePersonalSchedule(calendarInput, options), /未能核实/);
  await assert.rejects(() => writePersonalSchedule(calendarInput, { ...options, platform: 'linux' }), /macOS/);
  await assert.rejects(() => writePersonalSchedule(calendarInput, { ...options, runner: async () => { throw Object.assign(new Error('denial'), { stderr: '(-1743)' }); } }), /自动化/);
});

test('deletePersonalSchedule sends marker-bound delete operation and verifies removal', async () => {
  let received = null;
  const runner = async (_file, args) => {
    received = JSON.parse(args.at(-1));
    return { stdout: JSON.stringify({ deleted: true, verified: true }) };
  };
  const out = await deletePersonalSchedule(
    { destination: 'reminders', id: 'job-42:offer', target: '工作', remoteId: 'rem-1' },
    { platform: 'darwin', runner },
  );
  assert.equal(out.deleted, true);
  assert.equal(out.verified, true);
  assert.equal(received.operation, 'delete');
  assert.equal(received.destination, 'reminders');
  assert.equal(received.target, '工作');
  assert.equal(received.remoteId, 'rem-1');
  assert.match(received.marker, /^\[niuma:[a-f0-9]{32}\]$/);
});

test('deletePersonalSchedule treats already-missing native reminder as alreadyGone instead of NIUMA_BINDING', async () => {
  const emptyList = {
    name: () => '工作',
    reminders: Object.assign(() => [], { whose: () => () => [] }),
  };
  const lists = Object.assign(() => [emptyList], { whose: () => () => [emptyList] });
  const runner = async (_file, args) => {
    const script = args[3];
    const payload = args.at(-1);
    const stdout = runInNewContext(`${script}\nrun([payload])`, {
      payload,
      Application: () => ({ lists, delete() { throw new Error('should not delete') } }),
    });
    return { stdout };
  };
  const out = await deletePersonalSchedule(
    { destination: 'reminders', id: 'job-42:offer', target: '工作', remoteId: 'rem-already-deleted' },
    { platform: 'darwin', runner },
  );
  assert.equal(out.alreadyGone, true);
  assert.equal(out.verified, true);
  assert.equal(out.deleted, false);
});
