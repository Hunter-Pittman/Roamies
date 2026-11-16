// Notification policy, shared by background agents and Orca supervisors. No model calls or external actions.
export const DEFAULT_INTERRUPTION_RULES = Object.freeze({ failures: 'immediate', questions: 'immediate', completions: 'quiet', snoozeUntil: 0 });
export const QUIET_MS = 15000;
export function interruptionRules(value = {}) {
  const result = { ...DEFAULT_INTERRUPTION_RULES };
  for (const key of ['failures', 'questions', 'completions']) if (['immediate', 'quiet', 'off'].includes(value?.[key])) result[key] = value[key];
  if (Number.isSafeInteger(value?.snoozeUntil) && value.snoozeUntil >= 0) result.snoozeUntil = value.snoozeUntil;
  return result;
}
export function interruptionMode(category, rules, now = Date.now()) {
  const r = interruptionRules(rules);
  return r.snoozeUntil > now ? 'off' : r[category] ?? 'off';
}
export function canInterrupt(category, rules, gates = {}, quietMs = 0, now = Date.now()) {
  if (gates.busy || gates.queued || gates.barOpen || gates.voice || gates.saidPending || gates.autoListen || gates.asking || gates.onboarding || gates.intro || gates.loggingIn) return false;
  const mode = interruptionMode(category, rules, now);
  return mode === 'immediate' || mode === 'quiet' && !gates.focus && quietMs >= QUIET_MS;
}
export const agentInterruptionCategory = (item) => item.kind === 'failed' ? 'failures' : item.kind === 'ask' || item.needs_you ? 'questions' : 'completions';

// Keys identify an event, not a changing progress revision. Unread reports remain in the overlay when muted.
export function supervisorInterruption(record) {
  let event;
  if (record.result && !record.result.read && !record.result.announced) {
    const category = record.observation?.outcome === 'failed' ? 'failures' : 'completions';
    event = { id: record.id, key: record.result.id, category, at: record.result.createdAt ?? 0, title: record.title,
      text: category === 'failures' ? `${record.title} couldn't finish. ${short(record.brief || record.notice)}` : `${record.title} ${record.observation?.outcome === 'cancelled' ? 'stopped' : 'is finished'}. ${short(record.brief)}` };
  } else if (!record.result && record.question && (record.questionAnnouncedRevision ?? -1) < (record.questionRevision ?? record.revision ?? 0)
    && !(record.message?.state === 'accepted' && record.message.revision >= (record.questionRevision ?? record.revision ?? 0))) {
    event = { id: record.id, key: `${record.id}:question:${record.questionRevision ?? record.revision ?? 0}`, category: 'questions', at: record.lastCheckedAt ?? 0,
      title: record.title, text: `${record.title} needs you: ${short(record.question, 280)}` };
  } else if (!record.result && record.state === 'needs_attention' && !record.question && ['unknown', 'changed'].includes(record.connection)) {
    event = { id: record.id, key: `${record.id}:attention:${record.connection}`, category: 'failures', at: record.lastCheckedAt ?? record.createdAt ?? 0,
      title: record.title, text: `${record.title} needs attention. ${short(record.notice)}` };
  }
  if (!event || record.notification?.key === event.key && record.notification.deliveredAt != null) return null;
  event.nextAttemptAt = record.notification?.key === event.key ? record.notification.nextAttemptAt ?? 0 : 0;
  return event;
}
function short(text, limit = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= limit) return s;
  const first = s.split(/(?<=[.!?])\s+/)[0];
  return first.length <= limit ? first : s.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
}

export function createSupervisorNotifier({ snapshot, claim, deliver, gates, now = Date.now }) {
  let quietSince = now(), lastDeliveryAt = -Infinity, running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const t = now(), g = gates();
      if (!canInterrupt('failures', { failures: 'immediate' }, g, 0, t)) { quietSince = t; return; }
      if (t - lastDeliveryAt < 10000) return;
      const saved = snapshot(), rules = saved.interruptions;
      const events = saved.supervisors.map(supervisorInterruption).filter(Boolean)
        .filter((e) => e.nextAttemptAt <= t && canInterrupt(e.category, rules, g, t - quietSince, t))
        .sort((a, b) => ({ failures: 0, questions: 1, completions: 2 }[a.category] - { failures: 0, questions: 1, completions: 2 }[b.category]) || a.at - b.at);
      if (!events.length) return;
      const batch = events[0].category === 'completions' ? events.filter((e) => e.category === 'completions').slice(0, 3) : events.slice(0, 1);
      const accepted = [];
      for (const event of batch) if (await claim(event.id, event.key)) accepted.push(event);
      const currentRules = snapshot().interruptions, currentGates = gates();
      const ready = accepted.filter((e) => canInterrupt(e.category, currentRules, currentGates, now() - quietSince, now()));
      if (!ready.length) return;
      const text = ready.length === 1 ? ready[0].text : `${ready.length} supervisors finished: ${ready.map((e) => e.title).join(', ')}. Their briefs are ready.`;
      lastDeliveryAt = t; quietSince = t;
      await deliver({ text, mood: ready[0].category === 'completions' ? 'happy' : 'concerned', events: ready.map(({ id, key }) => ({ id, key })) });
    } finally { running = false; }
  }
  return { tick };
}
