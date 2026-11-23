import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const destinations = new Set(['calendar', 'reminders', 'things']);
const bundleIds = {
  calendar: 'com.apple.iCal',
  reminders: 'com.apple.reminders',
  things: 'com.culturedcode.ThingsMac',
};
const changes = new Set(['created', 'updated', 'unchanged']);
const pending = new Map();

const ICON_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  const bundleId = String(argv[0] || '');
  const ws = $.NSWorkspace.sharedWorkspace;
  const url = ws.URLForApplicationWithBundleIdentifier(bundleId);
  if (!url || url.isNil()) return '';
  const path = ObjC.unwrap(url.path);
  if (!path) return '';
  const img = ws.iconForFile(path);
  const size = 96;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, size, size, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0
  );
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}`;

// User data travels only as an argument. The script text and executable are fixed.
const NATIVE_SCRIPT = String.raw`
function run(argv) {
  const input = JSON.parse(argv[0]);
  if (input.operation === 'targets') return JSON.stringify(targets(input.destination));
  if (input.operation === 'delete') return JSON.stringify(removeOwned(input));
  const write = {calendar: calendarEvent, reminders: reminderTask, things: thingsTask}[input.destination];
  return JSON.stringify(write(input));
}

function removeOwned(input) {
  if (input.destination === 'calendar') {
    const app = Application('com.apple.iCal');
    const calendar = exactTarget(app.calendars, input.target);
    const existing = ownedItem(calendar.events, 'description', 'uid', input, true);
    if (!existing) return {deleted: false, alreadyGone: true, verified: true};
    app.delete(existing);
    return {deleted: true, verified: !ownedItem(calendar.events, 'description', 'uid', {marker: input.marker}, true)};
  }
  if (input.destination === 'reminders') {
    const app = Application('com.apple.reminders');
    const list = exactTarget(app.lists, input.target);
    const existing = ownedItem(list.reminders, 'body', 'id', input, true);
    if (!existing) return {deleted: false, alreadyGone: true, verified: true};
    app.delete(existing);
    return {deleted: true, verified: !ownedItem(list.reminders, 'body', 'id', {marker: input.marker}, true)};
  }
  const app = Application('com.culturedcode.ThingsMac');
  const container = input.target === 'Inbox' ? app : exactTarget(app.projects, input.target);
  const existing = ownedItem(container.toDos, 'notes', 'id', input, true);
  if (!existing) return {deleted: false, alreadyGone: true, verified: true};
  app.delete(existing);
  return {deleted: true, verified: !ownedItem(container.toDos, 'notes', 'id', {marker: input.marker}, true)};
}

function targets(destination) {
  if (destination === 'calendar') return Application('com.apple.iCal').calendars()
    .filter(calendar => {
      try { return calendar.writable() } catch { return false }
    })
    .map(calendar => {
      const name = calendar.name()
      let id = ''
      try { id = String(calendar.calendarIdentifier() || '') } catch {}
      if (!id) { try { id = String(calendar.uid() || '') } catch {} }
      return id ? { id, name } : { name }
    })
    .filter(calendar => calendar.name && calendar.name !== '计划的提醒事项' && calendar.name !== 'Scheduled Reminders')
  if (destination === 'reminders') return Application('com.apple.reminders').lists()
    .map(list => {
      const name = list.name()
      let id = ''
      try { id = String(list.id() || '') } catch {}
      return id ? { id, name } : { name }
    })
  return [{name: 'Inbox'}, ...Application('com.culturedcode.ThingsMac').projects()
    .map(project => ({id: project.id(), name: project.name()})).filter(project => project.name !== 'Inbox')];
}

function exactTarget(collection, name) {
  const candidates = collection.whose({name: name})();
  const matches = candidates.filter(item => item.name() === name);
  if (matches.length !== 1) throw Error('NIUMA_TARGET');
  return matches[0];
}

function plain(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
}

function ownedItem(collection, field, idProperty, input, allowMissing) {
  const condition = {};
  condition[field] = {_contains: input.marker};
  const matches = collection.whose(condition)().filter(item => plain(item[field]()).split('\n')[0] === input.marker);
  if (matches.length > 1) throw Error('NIUMA_DUPLICATE');
  const item = matches[0];
  if (!item) {
    if (allowMissing) return null;
    if (input.remoteId) throw Error('NIUMA_BINDING');
    return null;
  }
  if (input.remoteId && item[idProperty]() !== input.remoteId) throw Error('NIUMA_BINDING');
  return item;
}

function dateMatches(value, expected) {
  return expected ? value != null && new Date(value).getTime() === new Date(expected).getTime() : value == null;
}

function dayOf(value) {
  if (value == null) return '';
  const date = new Date(value);
  const pad = value => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function note(input) {
  const lines = [input.marker];
  if (input.notes) lines.push(input.notes);
  if (input.destination === 'things' && input.dueLabel) lines.push((input.dueLabelPrefix || '准确截止时间：') + input.dueLabel);
  return lines.join('\n');
}

function receipt(item, idProperty, change, matches) {
  if (!item || !matches(item)) throw Error('NIUMA_READBACK');
  const remoteId = item[idProperty]();
  if (!remoteId) throw Error('NIUMA_READBACK');
  return {remoteId, change, verified: true};
}

function calendarEvent(input) {
  const app = Application('com.apple.iCal');
  const calendar = exactTarget(app.calendars, input.target);
  if (!calendar.writable()) throw Error('NIUMA_NOT_WRITABLE');
  const notes = note(input);
  const startDate = new Date(input.startsAt);
  const endDate = new Date(input.endsAt);
  const fieldsMatch = item => item.summary() === input.title && plain(item.description()) === notes &&
    plain(item.location()) === input.location && !item.alldayEvent() &&
    dateMatches(item.startDate(), input.startsAt) && dateMatches(item.endDate(), input.endsAt);
  const existing = ownedItem(calendar.events, 'description', 'uid', input);
  let change = 'unchanged';
  if (!existing) {
    calendar.events.push(app.Event({summary: input.title, description: notes, location: input.location, startDate, endDate}));
    change = 'created';
  } else if (!fieldsMatch(existing)) {
    existing.summary = input.title;
    existing.location = input.location;
    if (existing.alldayEvent()) existing.alldayEvent = false;
    if (startDate >= existing.endDate()) existing.endDate = endDate;
    existing.startDate = startDate;
    existing.endDate = endDate;
    existing.description = notes;
    change = 'updated';
  }
  return receipt(ownedItem(calendar.events, 'description', 'uid', input), 'uid', change, fieldsMatch);
}

function reminderTask(input) {
  const app = Application('com.apple.reminders');
  const list = exactTarget(app.lists, input.target);
  const body = note(input);
  const dueDate = input.dueAt ? new Date(input.dueAt) : null;
  const fieldsMatch = item => item.name() === input.title && plain(item.body()) === body &&
    dateMatches(item.dueDate(), input.dueAt) && dateMatches(item.remindMeDate(), input.dueAt);
  const existing = ownedItem(list.reminders, 'body', 'id', input);
  let change = 'unchanged';
  if (!existing) {
    const fields = {name: input.title, body};
    if (dueDate) { fields.dueDate = dueDate; fields.remindMeDate = dueDate; }
    list.reminders.push(app.Reminder(fields));
    change = 'created';
  } else if (!fieldsMatch(existing)) {
    existing.name = input.title;
    if (!dateMatches(existing.dueDate(), input.dueAt)) existing.dueDate = dueDate;
    if (!dateMatches(existing.remindMeDate(), input.dueAt)) existing.remindMeDate = dueDate;
    existing.body = body;
    change = 'updated';
  }
  return receipt(ownedItem(list.reminders, 'body', 'id', input), 'id', change, fieldsMatch);
}

function thingsTask(input) {
  const app = Application('com.culturedcode.ThingsMac');
  const container = input.target === 'Inbox' ? app : exactTarget(app.projects, input.target);
  const notes = note(input);
  const parts = input.deadline.split('-').map(Number);
  // Things' deadline is a day, independent of the exact cutoff in the note.
  const dueDate = input.deadline ? new Date(parts[0], parts[1] - 1, parts[2], 12) : undefined;
  const fieldsMatch = item => item.name() === input.title && plain(item.notes()) === notes && dayOf(item.dueDate()) === input.deadline;
  const existing = ownedItem(container.toDos, 'notes', 'id', input);
  if (input.target === 'Inbox' && existing && existing.project() != null) throw Error('NIUMA_BINDING');
  let change = 'unchanged';
  if (!existing) {
    const fields = {name: input.title, notes};
    if (dueDate) fields.dueDate = dueDate;
    container.toDos.push(app.ToDo(fields));
    change = 'created';
  } else if (!fieldsMatch(existing)) {
    existing.name = input.title;
    if (dayOf(existing.dueDate()) !== input.deadline) existing.dueDate = dueDate || null;
    existing.notes = notes;
    change = 'updated';
  }
  return receipt(ownedItem(container.toDos, 'notes', 'id', input), 'id', change, fieldsMatch);
}`;

function inputText(input, label, max, required = false) {
  if (input === undefined && !required) return '';
  if (typeof input !== 'string' || input.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input)) {
    throw new TypeError(`无效的${label}。`);
  }
  const value = input.replace(/\r\n?/g, '\n').trim();
  if (required && !value) throw new TypeError(`请填写${label}。`);
  return value;
}

function instant(value, label) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new TypeError(`${label}需要明确的时区偏移，精确到秒。`);
  const [, year, month, day] = match;
  const monthEnd = new Date(`${year}-${month}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const result = new Date(value);
  if (+year < 1900 || +day < 1 || +day > monthEnd.getUTCDate() || !Number.isFinite(+result)) throw new TypeError(`${label}无效。`);
  result.setUTCMilliseconds(0);
  return result.toISOString();
}

function inZone(value, timezone) {
  let format;
  try {
    format = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'longOffset',
    });
  } catch {
    throw new TypeError('截止时区无效。');
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  const deadline = `${parts.year}-${parts.month}-${parts.day}`;
  return { deadline, dueLabel: `${deadline} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName} (${timezone})` };
}

export function validateScheduleItem(input, { locale = 'zh' } = {}) {
  const isEn = locale === 'en';
  if (!input || !destinations.has(input.destination)) throw new TypeError(isEn ? 'Choose Calendar, Reminders, or Things.' : '请选择日历、提醒事项或 Things。');
  const destination = input.destination;
  const id = inputText(input.id, '事项编号', 240, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/.test(id)) throw new TypeError(isEn ? 'Invalid item ID.' : '无效的事项编号。');
  const result = {
    destination, id,
    title: inputText(input.title, '标题', 180, true),
    target: destination === 'things' ? inputText(input.target, 'Things 项目名称', 160) || 'Inbox' : inputText(input.target, '日历或列表名称', 160, true),
    notes: inputText(input.notes, '备注', 2500),
    remoteId: inputText(input.remoteId, '原生事项编号', 500),
    marker: `[niuma:${createHash('sha256').update(`${destination}\u0000${id}`).digest('hex').slice(0, 32)}]`,
    ...(isEn ? { dueLabelPrefix: 'Exact deadline: ' } : {}),
  };
  if (destination === 'calendar') {
    result.startsAt = instant(input.startsAt, '开始时间');
    result.endsAt = instant(input.endsAt, '结束时间');
    if (result.endsAt <= result.startsAt) throw new TypeError('结束时间需要晚于开始时间。');
    result.location = inputText(input.location, '地点', 400);
  } else if (destination === 'reminders') {
    if (input.dueAt !== undefined && input.dueAt !== '') result.dueAt = instant(input.dueAt, '截止时间');
  } else {
    result.deadline = '';
    result.dueLabel = '';
    if (input.dueAt !== undefined && input.dueAt !== '') {
      result.dueAt = instant(input.dueAt, '截止时间');
      Object.assign(result, input.timezone ? inZone(result.dueAt, input.timezone) : {
        deadline: input.dueAt.slice(0, 10), dueLabel: input.dueAt,
      });
    }
  }
  return result;
}

const nativeErrors = new Map([
  ['NIUMA_TARGET', {
    zh: '找不到唯一同名的日历、提醒事项列表或 Things 项目。请选择当前应用中已存在的名称。',
    en: 'Could not find a unique Calendar, Reminders list, or Things project with that name. Please select an existing target.',
  }],
  ['NIUMA_NOT_WRITABLE', {
    zh: '该日历不可写。',
    en: 'That calendar is read-only.',
  }],
  ['NIUMA_DUPLICATE', {
    zh: '应用中有多条相同的关联事项。核对并保留正确的记录后再试。',
    en: 'Multiple matching linked items exist in the target app. Keep the right one and retry.',
  }],
  ['NIUMA_BINDING', {
    zh: '找不到原关联事项，或它的关联标记已改变。为避免重复，没有创建新事项。',
    en: 'The previously linked item was deleted or modified in the target app; skipped creating a duplicate.',
  }],
  ['NIUMA_READBACK', {
    zh: '应用中的回读与请求不一致。请先检查应用中的结果。',
    en: 'Read-back verification did not match the requested item. Please check the target app.',
  }],
]);

async function invokeNative(item, runner, locale = 'zh') {
  const isEn = locale === 'en';
  try {
    const output = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', NATIVE_SCRIPT, '--', JSON.stringify(item)], {
      encoding: 'utf8', timeout: 40_000, maxBuffer: 64 * 1024,
    });
    return JSON.parse(output.stdout);
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    const rawMessage = String(error?.message ?? '');
    // execFile embeds the full osascript -e source in error.message ("Command failed: /usr/bin/osascript ..."),
    // which contains every NIUMA_* string literal; only inspect stderr (or direct non-execFile error messages).
    const diagnostic = stderr || (rawMessage.startsWith('Command failed:') ? '' : rawMessage);
    const msg = stderr || rawMessage;
    for (const [code, labels] of nativeErrors) if (diagnostic.includes(code)) throw new Error(isEn ? labels.en : labels.zh);
    if (msg.includes('-1743')) throw new Error(isEn ? 'macOS denied automation permission. Check System Settings → Privacy & Security → Automation.' : 'macOS 未允许控制目标应用。请检查「系统设置 → 隐私与安全性 → 自动化」。');
    if (msg.includes('-10814') || msg.includes('-600')) throw new Error(isEn ? 'Could not connect to the target app. Make sure it is installed and has been opened at least once.' : '未能连接到目标应用。请确认应用已安装并已打开过一次。');
    throw new Error(isEn ? 'Could not confirm the sync result in the native app. Check app status and macOS Automation permissions.' : '未能确认原生应用中的结果。请检查应用与 macOS 自动化授权后再试。');
  }
}

async function deliver(item, runner, locale = 'zh') {
  const result = await invokeNative(item, runner, locale);
  if (result?.verified !== true || typeof result.remoteId !== 'string' || !result.remoteId || result.remoteId.length > 500 ||
      !changes.has(result.change) || (item.remoteId && result.remoteId !== item.remoteId)) {
    throw new Error(locale === 'en' ? 'Could not verify the native item and its identifier.' : '未能核实原生事项及其编号。');
  }
  return {
    destination: item.destination, id: item.id, target: item.target,
    remoteId: result.remoteId, verified: true, change: result.change,
    ...(item.startsAt && { startsAt: item.startsAt, endsAt: item.endsAt }),
    ...(item.dueAt && { dueAt: item.dueAt }),
    ...(item.deadline && { deadline: item.deadline }),
  };
}

export async function listPersonalTargets(destination, { runner = runFile, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('读取原生应用的目标列表需要 macOS。');
  if (!destinations.has(destination)) throw new TypeError('请选择日历、提醒事项或 Things。');
  const result = await invokeNative({ destination, operation: 'targets' }, runner);
  if (!Array.isArray(result)) throw new Error('未能读取应用中的目标列表。');
  return result.map(item => ({
    name: inputText(item?.name, '目标名称', 160, true),
    ...(item?.id && { id: inputText(item.id, '原生列表编号', 500, true) }),
  }));
}

export async function readPersonalAppIcon(destination, { runner = runFile, platform = process.platform } = {}) {
  if (platform !== 'darwin' || !destinations.has(destination)) return null;
  try {
    const output = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ICON_SCRIPT, '--', bundleIds[destination]], {
      encoding: 'utf8', timeout: 8_000, maxBuffer: 512 * 1024,
    });
    const b64 = String(output?.stdout ?? '').trim();
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 64 && buf[0] === 0x89 && buf[1] === 0x50 ? buf : null;
  } catch {
    return null;
  }
}

export async function writePersonalSchedule(input, { runner = runFile, platform = process.platform, locale = 'zh' } = {}) {
  if (platform !== 'darwin') throw new Error(locale === 'en' ? 'Native schedule sync requires macOS.' : '原生日程同步需要 macOS。');
  const item = validateScheduleItem(input, { locale });
  const previous = pending.get(item.marker) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => deliver(item, runner, locale));
  pending.set(item.marker, write);
  try {
    return await write;
  } finally {
    if (pending.get(item.marker) === write) pending.delete(item.marker);
  }
}

export async function deletePersonalSchedule(input, { runner = runFile, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { deleted: false, verified: true, skipped: true };
  if (!input || !destinations.has(input.destination)) throw new TypeError('请选择日历、提醒事项或 Things。');
  const destination = input.destination;
  const id = inputText(input.id, '事项编号', 240, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/.test(id)) throw new TypeError('无效的事项编号。');
  const target = destination === 'things' ? inputText(input.target, 'Things 项目名称', 160) || 'Inbox' : inputText(input.target, '日历或列表名称', 160, true);
  const remoteId = inputText(input.remoteId, '原生事项编号', 500);
  const marker = `[niuma:${createHash('sha256').update(`${destination}\u0000${id}`).digest('hex').slice(0, 32)}]`;
  const previous = pending.get(marker) ?? Promise.resolve();
  const runDelete = previous.catch(() => {}).then(() => invokeNative({
    operation: 'delete', destination, id, target, remoteId, marker,
  }, runner));
  pending.set(marker, runDelete);
  try {
    const result = await runDelete;
    return { destination, id, target, deleted: Boolean(result?.deleted), alreadyGone: Boolean(result?.alreadyGone), verified: Boolean(result?.verified) };
  } finally {
    if (pending.get(marker) === runDelete) pending.delete(marker);
  }
}
