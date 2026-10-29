(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LeaveLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var SUBJECT_SEP = / \/ |／/;

  function toUTC(dateStr) {
    if (!dateStr) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
    if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var t = Date.UTC(y, mo - 1, d);
    var check = new Date(t);
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    return t;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function formatDate(date) {
    if (!date) return '';
    if (typeof date === 'string') return date;
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function formatDateTime(date) {
    if (!date) return '';
    var d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    return formatDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function todayStr(now) {
    return formatDate(now || new Date());
  }

  function num(v, fallback) {
    var n = Number(v);
    return isNaN(n) ? fallback : n;
  }

  function calcDays(startDate, startHalf, endDate, endHalf) {
    var s = toUTC(startDate), e = toUTC(endDate);
    if (s === null || e === null) return 0;
    if (e < s) return 0;
    var days = Math.round((e - s) / DAY) + 1;
    if (startHalf === 'pm') days -= 0.5;
    if (endHalf === 'am') days -= 0.5;
    return Math.max(0, days);
  }

  /* ---------- 学科 / 年级（兼容"语文 / 高二"这种老写法） ---------- */

  function splitSubject(raw) {
    var s = String(raw || '');
    if (SUBJECT_SEP.test(s)) {
      var parts = s.split(SUBJECT_SEP);
      return { subject: (parts[0] || '').trim(), grade: (parts[1] || '').trim() };
    }
    return { subject: s.trim(), grade: '' };
  }

  function subjectOf(rec) {
    if (!rec) return '';
    if (rec.grade) return rec.subject || '';
    return splitSubject(rec.subject).subject;
  }

  function gradeOf(rec) {
    if (!rec) return '';
    if (rec.grade) return rec.grade;
    return splitSubject(rec.subject).grade;
  }

  function subjectLabel(rec) {
    var s = subjectOf(rec), g = gradeOf(rec);
    if (s && g) return s + ' / ' + g;
    return s || g || '';
  }

  /* ---------- 结束日期未定 ---------- */

  function isOpenEnded(rec) {
    return !!rec && rec.openEnded === true && !rec.endDate;
  }

  // 未定结束日期且尚未销假：天数按"开始日 → 今天"实时累计
  function isRunning(rec) {
    return isOpenEnded(rec) && !rec.checkedAt && !rec.revokedAt;
  }

  function effectiveEndDate(rec, now) {
    if (isRunning(rec)) return todayStr(now || new Date());
    return rec.endDate || '';
  }

  function effectiveEndHalf(rec, now) {
    if (isRunning(rec)) return 'pm';
    return rec.endHalf || 'pm';
  }

  function effectiveDays(rec, now) {
    if (isRunning(rec)) {
      return calcDays(rec.startDate, rec.startHalf || 'am', todayStr(now || new Date()), 'pm');
    }
    var d = Number(rec.days);
    if (!isNaN(d) && d > 0) return d;
    if (rec.startDate && rec.endDate) {
      return calcDays(rec.startDate, rec.startHalf || 'am', rec.endDate, rec.endHalf || 'pm');
    }
    return 0;
  }

  /* ---------- 时间点 ---------- */

  // 结束时刻：上午结束算到 12:00，下午 / 全天结束算到 18:00。
  // 以前下午取 23:59:59，结束当天整日都算"进行中"，
  // 而 severity() 只对 pending 计等级 —— 「今日到期」这一档对下午/全天结束的记录
  // 永远够不着（要等第二天才跳进来），首页徽标也不计入。v2.1.1 改为 18:00。
  // 注意：isOngoingToday() 按日期判断，不受这里影响，「今日在假」口径不变。
  function endMoment(rec) {
    var t = toUTC(rec.endDate);
    if (t === null) return null;
    var d = new Date(t);
    var y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
    var local = new Date(y, mo, day, 0, 0, 0, 0);
    local.setHours(rec.endHalf === 'am' ? 12 : 18, 0, 0, 0);
    return local;
  }

  function startMoment(rec) {
    var t = toUTC(rec.startDate);
    if (t === null) return null;
    var d = new Date(t);
    var local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
    if (rec.startHalf === 'pm') local.setHours(12, 0, 0, 0);
    return local;
  }

  /* ---------- 状态 ---------- */

  function computeStatus(rec, now) {
    now = now || new Date();
    if (rec.revokedAt) return 'revoked';
    if (rec.checkedAt) return 'checked';
    if (isOpenEnded(rec)) return 'active';
    var end = endMoment(rec);
    if (!end) return 'pending';
    return now < end ? 'active' : 'pending';
  }

  function statusLabel(rec, now) {
    var st = computeStatus(rec, now);
    if (st === 'active' && isOpenEnded(rec)) return '请假中·未定';
    return { active: '进行中', pending: '待销假', checked: '已销假', revoked: '已撤销' }[st] || '';
  }

  // 固定结束日期：请假结束后过去了几天
  function overdueDays(rec, now) {
    now = now || new Date();
    var t = toUTC(rec.endDate);
    if (t === null) return 0;
    var todayT = toUTC(todayStr(now));
    var diff = Math.round((todayT - t) / DAY);
    return diff > 0 ? diff : 0;
  }

  // 未定结束日期：从开始那天算起已经请了几天
  function elapsedDays(rec, now) {
    if (!rec.startDate) return 0;
    return calcDays(rec.startDate, rec.startHalf || 'am', todayStr(now || new Date()), 'pm');
  }

  // 返回 null | 'today' | 'warn' | 'critical'
  function severity(rec, now, settings) {
    settings = settings || {};
    now = now || new Date();
    var st = computeStatus(rec, now);
    if (st === 'checked' || st === 'revoked') return null;

    if (isOpenEnded(rec)) {
      var ow = num(settings.openWarnDays, 7);
      var oc = num(settings.openCriticalDays, 14);
      var e = elapsedDays(rec, now);
      if (e >= oc) return 'critical';
      if (e >= ow) return 'warn';
      return null;
    }

    if (st !== 'pending') return null;
    var d = overdueDays(rec, now);
    var warn = num(settings.warnDays, 1);
    var critical = num(settings.criticalDays, 3);
    if (d >= critical) return 'critical';
    if (d >= warn) return 'warn';
    return 'today';
  }

  function needsCheck(rec, now, settings) {
    return severity(rec, now, settings) !== null;
  }

  // 提醒卡片上显示的文字
  function alertText(rec, now) {
    if (isOpenEnded(rec)) {
      var e = elapsedDays(rec, now);
      return '已请 ' + trimNum(e) + ' 天未销假';
    }
    var d = overdueDays(rec, now);
    return d === 0 ? '今日到期' : '已结束 ' + d + ' 天';
  }

  function trimNum(n) {
    var v = Math.round(Number(n) * 10) / 10;
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  }

  function isOngoingToday(rec, now) {
    now = now || new Date();
    if (rec.revokedAt) return false;
    var s = toUTC(rec.startDate);
    var today = toUTC(todayStr(now));
    if (s === null) return false;
    if (isRunning(rec)) return today >= s;
    var e = toUTC(rec.endDate);
    if (e === null) return false;
    return today >= s && today <= e;
  }

  /* ---------- 还没到期、也还没销假 ---------- */

  // 返回 null | 'upcoming'（还没开始） | 'running'（正在休 / 未定但没到提醒线）
  // 用途：这些记录 severity() 为 null（不该报紧急），但它们同样「未销假」，
  // 首页要能看见，否则刚录完的记录在首页一条都找不到（v2.1 修复）
  function notDueKind(rec, now) {
    now = now || new Date();
    if (!rec) return null;
    var st = computeStatus(rec, now);
    if (st === 'checked' || st === 'revoked') return null;
    var s = toUTC(rec.startDate);
    if (s === null) return null;
    var today = toUTC(todayStr(now));
    if (today < s) return 'upcoming';
    return 'running';
  }

  function notDueText(rec, now) {
    now = now || new Date();
    var today = toUTC(todayStr(now));
    // 还没开始的先判：结束日期未定、但开始日期在未来的记录，
    // 以前会落到 isOpenEnded 分支显示「已请 0 天」，读起来很别扭
    if (notDueKind(rec, now) === 'upcoming') {
      var s = toUTC(rec.startDate);
      var d = Math.round((s - today) / DAY);
      return d === 1 ? '明天开始' : d + ' 天后开始';
    }
    if (isOpenEnded(rec)) {
      return '已请 ' + trimNum(elapsedDays(rec, now)) + ' 天，未销假';
    }
    var e = toUTC(rec.endDate);
    if (e === null) return '未销假';
    var left = Math.round((e - today) / DAY);
    return left === 0 ? '今天最后一天' : '还剩 ' + left + ' 天';
  }

  /* ---------- 重叠判断 ---------- */
  // 以「半天」为最小粒度：上午 = 0、下午 = 1，
  // 换算成 day*2 + (下午?1:0) 的整数下标后按闭区间比较。
  // 早先只用日期比较，导致「同一天上午假 + 下午假」被误判为冲突
  // （注释写着可以分段，实际存不进去），半天粒度下必须区分上下午。
  function halfIndex(dateStr, half) {
    var t = toUTC(dateStr);
    if (t === null) return null;
    return Math.round(t / DAY) * 2 + (half === 'pm' ? 1 : 0);
  }

  function spanOf(rec) {
    if (!rec.startDate) return null;
    var s = halfIndex(rec.startDate, rec.startHalf === 'pm' ? 'pm' : 'am');
    if (s === null) return null;
    var e;
    if (isOpenEnded(rec) && !rec.checkedAt) {
      e = Infinity; // 尚未确定结束，视为一直延续
    } else {
      if (!rec.endDate) return null;
      e = halfIndex(rec.endDate, rec.endHalf === 'am' ? 'am' : 'pm');
      if (e === null || e < s) return null;
    }
    return { s: s, e: e };
  }

  function overlaps(a, b) {
    var x = spanOf(a), y = spanOf(b);
    if (!x || !y) return false;
    return x.s <= y.e && y.s <= x.e;
  }

  // 冲突判断同样以「姓名 + 学校」为唯一键：同名的两个人若不在同一学校，
  // 各自请假互不相干；只有同一人在同一学校的时段才可能冲突。
  // candidate.school 传 undefined 表示不限制学校（兼容旧调用）。
  function findOverlaps(records, candidate) {
    if (!candidate.startDate) return [];
    if (!candidate.endDate && !candidate.openEnded) return [];
    var name = (candidate.name || '').trim();
    if (!name) return [];
    var school = candidate.school === undefined ? null : (candidate.school || '');
    return records.filter(function (r) {
      if (r.id === candidate.id) return false;
      if (r.revokedAt) return false;
      if ((r.name || '').trim() !== name) return false;
      if (school !== null && (r.school || '') !== school) return false;
      return overlaps(r, candidate);
    });
  }

  /* ---------- 区间 ---------- */

  function termRange(now) {
    now = now || new Date();
    var y = now.getFullYear(), m = now.getMonth() + 1;
    var start, end;
    if (m >= 8) {
      start = y + '-08-01';
      end = (y + 1) + '-01-31';
    } else if (m === 1) {
      start = (y - 1) + '-08-01';
      end = y + '-01-31';
    } else {
      start = y + '-02-01';
      end = y + '-07-31';
    }
    return { start: start, end: end };
  }

  function monthRange(now) {
    now = now || new Date();
    var y = now.getFullYear(), m = now.getMonth() + 1;
    var last = new Date(y, m, 0).getDate();
    return { start: y + '-' + pad(m) + '-01', end: y + '-' + pad(m) + '-' + pad(last) };
  }

  function halfLabel(h) { return h === 'am' ? '上午' : '下午'; }

  function rangeLabel(rec) {
    if (!rec.startDate) return '';
    if (isOpenEnded(rec)) {
      return rec.startDate + ' ' + halfLabel(rec.startHalf) + ' → 未定';
    }
    if (!rec.endDate) return '';
    if (rec.startDate === rec.endDate) {
      return rec.startDate + ' ' + halfLabel(rec.startHalf) + (rec.startHalf !== rec.endHalf ? ' - ' + halfLabel(rec.endHalf) : '');
    }
    return rec.startDate + ' ' + halfLabel(rec.startHalf) + ' 至 ' + rec.endDate + ' ' + halfLabel(rec.endHalf);
  }

  function fmtDays(n) {
    var v = Math.round(Number(n) * 10) / 10;
    return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + ' 天';
  }

  /* ---------- 汇总 ---------- */

  function summarize(records, now) {
    now = now || new Date();
    var byPerson = {}, byType = {}, bySchool = {}, bySubject = {}, totalDays = 0, totalCount = 0, runningCount = 0;

    records.forEach(function (r) {
      var d = effectiveDays(r, now);
      totalDays += d;
      totalCount += 1;
      if (isRunning(r)) runningCount += 1;

      var n = (r.name || '').trim() || '(未填)';
      if (!byPerson[n]) byPerson[n] = { name: n, school: r.school || '', subject: subjectLabel(r), days: 0, count: 0 };
      byPerson[n].days += d;
      byPerson[n].count += 1;

      var t = (r.type || '').trim() || '(未填)';
      if (!byType[t]) byType[t] = { type: t, days: 0, count: 0 };
      byType[t].days += d;
      byType[t].count += 1;

      var sc = (r.school || '').trim() || '(未填)';
      if (!bySchool[sc]) bySchool[sc] = { school: sc, days: 0, count: 0 };
      bySchool[sc].days += d;
      bySchool[sc].count += 1;

      var sj = subjectOf(r) || '(未填)';
      if (!bySubject[sj]) bySubject[sj] = { subject: sj, days: 0, count: 0 };
      bySubject[sj].days += d;
      bySubject[sj].count += 1;
    });

    function toArr(obj) {
      return Object.keys(obj).map(function (k) { return obj[k]; })
        .sort(function (a, b) { return b.days - a.days || b.count - a.count; });
    }

    return {
      totalDays: Math.round(totalDays * 10) / 10,
      totalCount: totalCount,
      runningCount: runningCount,
      byPerson: toArr(byPerson),
      byType: toArr(byType),
      bySchool: toArr(bySchool),
      bySubject: toArr(bySubject)
    };
  }

  return {
    toUTC: toUTC,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    todayStr: todayStr,
    calcDays: calcDays,
    splitSubject: splitSubject,
    subjectOf: subjectOf,
    gradeOf: gradeOf,
    subjectLabel: subjectLabel,
    isOpenEnded: isOpenEnded,
    isRunning: isRunning,
    effectiveEndDate: effectiveEndDate,
    effectiveEndHalf: effectiveEndHalf,
    effectiveDays: effectiveDays,
    endMoment: endMoment,
    startMoment: startMoment,
    computeStatus: computeStatus,
    statusLabel: statusLabel,
    overdueDays: overdueDays,
    elapsedDays: elapsedDays,
    severity: severity,
    needsCheck: needsCheck,
    alertText: alertText,
    isOngoingToday: isOngoingToday,
    notDueKind: notDueKind,
    notDueText: notDueText,
    overlaps: overlaps,
    findOverlaps: findOverlaps,
    termRange: termRange,
    monthRange: monthRange,
    rangeLabel: rangeLabel,
    fmtDays: fmtDays,
    summarize: summarize
  };
});
