const hudState = {
  snapshot: null,
  selectedSessionId: "orchestrator",
  copiedThreadUri: null,
  sseConnected: false,
  lastEventId: null,
  lastActionError: null,
  planFeedbackDraft: "",
  boardTab: "all",
  expandedMilestones: new Set(),
  collapsedMilestones: new Set(),
  assertionsExpanded: false,
  assertionFilter: "all",
  streamExpanded: false,
  clientRunStartMs: null,
  clientRunKey: null,
  threadFeeds: new Map(),
  threadFeedPending: false,
  sessionSteering: new Map(),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sessionThreadUri(session) {
  const link = [session.link, session.threadUri].find(
    (value) => typeof value === "string" && /^(?:t3-thread:\/\/v1\/|https:\/\/)/.test(value),
  );
  if (link) return link;
  const id = session.childThreadId || session.threadId;
  if (!id) return null;
  return String(id).startsWith("t3-thread://v1/") ? id : `t3-thread://v1/${encodeURIComponent(id)}`;
}

function sessionSelectorId(session) {
  return session.sessionId || session.runId || session.id || null;
}

function threadOpenLink(uri, id = "btn-open-thread-uri") {
  return uri
    ? `<a class="strip-btn thread-open-link" id="${id}" href="${escapeHtml(uri)}">↗ Open Thread</a>`
    : "";
}

function steeringState(session) {
  if (!hudState.sessionSteering.has(session.id))
    hudState.sessionSteering.set(session.id, {
      draft: "",
      pending: false,
      feedback: "",
      failed: false,
    });
  return hudState.sessionSteering.get(session.id);
}

function renderSessionSteering(session) {
  const steering = steeringState(session);
  const available = Boolean(sessionThreadUri(session));
  return `<form id="session-steer-bar" class="session-steer-bar">
    <label for="session-steer-input">Steer Session</label>
    <div class="session-steer-controls">
      <input id="session-steer-input" type="text" placeholder="Send steering instruction to this thread..." value="${escapeHtml(steering.draft)}" aria-describedby="session-steer-feedback" ${!available || steering.pending ? "disabled" : ""}>
      <button type="submit" class="strip-btn" id="btn-steer-session" ${!available || steering.pending || !steering.draft.trim() ? "disabled" : ""}>${steering.pending ? "Sending..." : "Send to Thread"}</button>
    </div>
    <div id="session-steer-feedback" class="session-steer-feedback ${steering.failed ? "is-error" : ""}" role="status" aria-live="polite">${escapeHtml(available ? steering.feedback : "This session has no thread yet.")}</div>
  </form>`;
}

function steeringPayload(session, message) {
  const target = session.runId
    ? { runId: session.runId }
    : session.sessionId
      ? { sessionId: session.sessionId }
      : { featureId: session.featureId };
  if (session.childThreadId) target.childThreadId = session.childThreadId;
  return { ...target, message };
}

async function submitSessionSteering(session) {
  const steering = steeringState(session);
  const message = steering.draft.trim();
  if (!message || steering.pending) return;
  steering.pending = true;
  steering.failed = false;
  steering.feedback = "Sending...";
  renderCenterColumn(hudState.snapshot);
  try {
    const result = await postAction("/api/mission/steer", steeringPayload(session, message));
    steering.draft = "";
    steering.feedback =
      result.delivery === "recorded"
        ? "Recorded locally. The T3 bridge is unavailable."
        : "Sent to thread.";
  } catch (error) {
    steering.failed = true;
    steering.feedback = error.message;
  } finally {
    steering.pending = false;
    renderCenterColumn(hudState.snapshot);
  }
}

function bindSessionSteering(container, session) {
  const form = container.querySelector("#session-steer-bar");
  const input = container.querySelector("#session-steer-input");
  const button = container.querySelector("#btn-steer-session");
  input?.addEventListener("input", () => {
    steeringState(session).draft = input.value;
    if (button) button.disabled = !input.value.trim();
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    return submitSessionSteering(session);
  });
}

function formatDurationHms(totalMs) {
  const safeMs = Math.max(0, Number(totalMs) || 0);
  const totalSec = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatRelativeTime(isoString, fallback = "now") {
  if (!isoString) return fallback;
  const ts = Date.parse(isoString);
  if (Number.isNaN(ts)) return fallback;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return "now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function computeLiveElapsedMs(state) {
  if (!state) return 0;
  let base = typeof state.elapsedMs === "number" ? state.elapsedMs : 0;
  const isRunning =
    state.status === "running" ||
    state.status === "orchestrator_turn" ||
    state.status === "initializing";
  if (isRunning) {
    const started = elapsedStartMs(state);
    if (!Number.isNaN(started) && Date.now() > started) {
      base += Date.now() - started;
    }
  }
  return base;
}

function elapsedStartMs(state) {
  for (const value of [state.lastStartedAt, state.activeWorker?.startedAt, state.planApprovedAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const key = `${state.missionId || "mission"}:${state.pausedAt || ""}`;
  if (hudState.clientRunKey !== key || hudState.clientRunStartMs === null) {
    hudState.clientRunKey = key;
    hudState.clientRunStartMs = Date.now();
  }
  return hudState.clientRunStartMs;
}

function updateElapsedAppearance(state) {
  const active = ["running", "orchestrator_turn", "initializing"].includes(state.status);
  document.getElementById("elapsed-metric")?.classList?.toggle?.("is-ticking", active);
  document
    .getElementById("metric-progress-bar")
    ?.classList?.toggle?.("is-active-execution", active);
  if (!active) {
    hudState.clientRunStartMs = null;
    hudState.clientRunKey = null;
  }
}

function renderReadiness(snapshot) {
  const readiness = snapshot.readiness || snapshot.state?.readiness || {};
  const evaluated = readiness.evaluated === true;
  const score = readiness.score;
  const label = evaluated
    ? `Readiness: Level ${readiness.level} · ${Number(score).toFixed(1)}%`
    : "Readiness: Not Evaluated · Recommend /agent-readiness";
  const tone = evaluated ? (score >= 80 ? "high" : score >= 40 ? "medium" : "low") : "unevaluated";
  const badge = document.getElementById("readiness-badge");
  if (badge) {
    badge.textContent = label;
    badge.dataset.readinessState = tone;
    badge.title = [readiness.summary, readiness.recommendation].filter(Boolean).join(" ") || label;
  }
  const callout = document.getElementById("readiness-callout");
  if (callout) {
    callout.classList.toggle("hidden", evaluated && score >= 60);
    callout.textContent = `${label}. Run /agent-readiness to find repository gaps before starting. This recommendation does not block approval.`;
  }
}

function getStatusBannerText(state, initialized = true) {
  if (initialized === false || state?.initialized === false) {
    return "UNINITIALIZED";
  }
  if (!state) return "PLANNING";
  const st = String(state.status || "planning").toLowerCase();
  if (st === "uninitialized") {
    return "UNINITIALIZED";
  }
  if (st === "awaiting_input") {
    return "AWAITING INPUT";
  }
  if (st === "orchestrator_turn") return "ORCHESTRATOR TURN";
  if (st === "running") return "RUNNING";
  if (st === "paused") return "PAUSED";
  if (st === "completed") return "COMPLETED";
  if (st === "initializing") return "INITIALIZING";
  return st.toUpperCase();
}

function inferSessionRole(item, matchedFeature = null) {
  const roleRaw = String(item?.role || matchedFeature?.role || "")
    .trim()
    .toLowerCase();
  if (roleRaw === "validator") return "Validator";
  if (roleRaw === "explorer") return "Explorer";
  if (roleRaw === "worker") return "Worker";

  const slotRaw = String(item?.slot || matchedFeature?.slot || "")
    .trim()
    .toLowerCase();
  if (slotRaw === "validator") return "Validator";

  const kindRaw = String(item?.kind || matchedFeature?.kind || "")
    .trim()
    .toLowerCase();
  if (["scrutiny", "user-testing", "user_testing", "validator"].includes(kindRaw)) {
    return "Validator";
  }
  if (kindRaw === "explorer") {
    return "Explorer";
  }

  const combinedText = [
    item?.featureId,
    item?.id,
    item?.title,
    item?.featureTitle,
    matchedFeature?.id,
    matchedFeature?.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    combinedText.includes("validator") ||
    combinedText.includes("scrutiny") ||
    combinedText.includes("user-testing") ||
    combinedText.includes("user_testing")
  ) {
    return "Validator";
  }
  if (combinedText.includes("explorer")) {
    return "Explorer";
  }

  return "Worker";
}

function synthesizeSessions(state, features) {
  const explicitSessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const featuresList = Array.isArray(features) ? features : [];
  const byId = new Map();

  for (const [idx, s] of explicitSessions.entries()) {
    const id = sessionSelectorId(s) || `session-${idx + 1}`;
    const matchedFeature = featuresList.find((f) => f.id && f.id === s.featureId) || null;
    const role = inferSessionRole(s, matchedFeature);
    const number = s.workerNumber ?? idx + 1;
    const title =
      s.title || s.featureTitle || matchedFeature?.title || s.featureId || `${role} #${number}`;
    const status = s.status || "completed";

    const sameFeatureSessionCount = s.featureId
      ? explicitSessions.filter((item) => item.featureId === s.featureId).length
      : 1;

    const featureHandoffMatchesRun = Boolean(
      matchedFeature?.lastHandoff &&
      ((s.runId &&
        matchedFeature.lastHandoff.runId &&
        matchedFeature.lastHandoff.runId === s.runId) ||
        (!s.runId &&
          !matchedFeature.lastHandoff.runId &&
          status !== "running" &&
          status !== "paused" &&
          status !== "pending" &&
          sameFeatureSessionCount === 1)),
    );

    const matchingFeatureHandoff = featureHandoffMatchesRun ? matchedFeature.lastHandoff : null;

    const h = s.handoff || matchingFeatureHandoff || {};
    const featureThreadMatchesRun = Boolean(
      matchedFeature?.childThreadId &&
      ((s.runId && matchedFeature.runId && matchedFeature.runId === s.runId) ||
        (!s.runId && sameFeatureSessionCount === 1)),
    );
    const childThreadId =
      s.childThreadId ||
      s.threadId ||
      h.childThreadId ||
      (featureThreadMatchesRun ? matchedFeature.childThreadId : null) ||
      null;

    byId.set(id, {
      id,
      sessionId: sessionSelectorId(s),
      threadUri: sessionThreadUri({ ...h, ...s }),
      runId: s.runId || null,
      role,
      workerNumber: number,
      milestoneId: s.milestoneId || matchedFeature?.milestoneId || "m1",
      featureId: s.featureId || id,
      title,
      label: s.label || `${role} #${number}: ${title}`,
      status,
      timeLabel:
        s.timeLabel ||
        formatRelativeTime(
          s.endedAt || s.startedAt,
          status === "running" ? "now" : status === "pending" ? "queued" : "done",
        ),
      childThreadId,
      kind:
        s.kind || matchedFeature?.kind || (role === "Validator" ? "scrutiny" : "implementation"),
      model: s.model || matchedFeature?.model || null,
      providerInstanceId: s.providerInstanceId || matchedFeature?.providerInstanceId || null,
      handoff: {
        salientSummary:
          s.salientSummary ||
          h.salientSummary ||
          s.whatWasImplemented ||
          h.whatWasImplemented ||
          matchedFeature?.description ||
          (status === "running"
            ? `Running ${title}`
            : status === "paused"
              ? `Paused ${title}`
              : status === "pending"
                ? `Scheduled ${title}`
                : "No handoff summary recorded."),
        whatWasImplemented:
          s.whatWasImplemented || h.whatWasImplemented || "No handoff recorded yet.",
        commandsRun:
          Array.isArray(s.commandsRun) && s.commandsRun.length
            ? s.commandsRun
            : Array.isArray(h.commandsRun) && h.commandsRun.length
              ? h.commandsRun
              : Array.isArray(h.tests)
                ? h.tests
                : [],
        discoveredIssues: Array.isArray(s.discoveredIssues)
          ? s.discoveredIssues
          : Array.isArray(h.discoveredIssues)
            ? h.discoveredIssues
            : [],
        whatWasLeftUndone: Array.isArray(h.whatWasLeftUndone) ? h.whatWasLeftUndone : [],
        commit: h.commit || null,
        branch: h.branch || null,
        testedSha: h.testedSha || null,
        validatorsPassed: h.validatorsPassed ?? null,
      },
    });
  }

  for (const [idx, f] of featuresList.entries()) {
    const matchingSessions = Array.from(byId.values()).filter((s) => s.featureId === f.id);
    if (matchingSessions.length > 0) {
      if (f.lastHandoff && f.lastHandoff.runId) {
        const targetSession = matchingSessions.find(
          (s) => s.runId === f.lastHandoff.runId && s.status !== "running",
        );
        if (targetSession) {
          targetSession.handoff = {
            salientSummary:
              f.lastHandoff.salientSummary ||
              f.lastHandoff.whatWasImplemented ||
              targetSession.handoff.salientSummary,
            whatWasImplemented:
              f.lastHandoff.whatWasImplemented || targetSession.handoff.whatWasImplemented,
            commandsRun: Array.isArray(f.lastHandoff.commandsRun)
              ? f.lastHandoff.commandsRun
              : targetSession.handoff.commandsRun,
            discoveredIssues: Array.isArray(f.lastHandoff.discoveredIssues)
              ? f.lastHandoff.discoveredIssues
              : targetSession.handoff.discoveredIssues,
          };
        }
      }
      continue;
    }

    const role = inferSessionRole(f);
    const number = f.workerNumber ?? idx + 1;
    const id = `session-${f.id || idx + 1}`;
    const title = f.title || f.id;
    const status = f.status || "pending";
    const h = status === "running" || status === "pending" ? {} : f.lastHandoff || {};
    const childThreadId = f.childThreadId || h.childThreadId || null;

    byId.set(id, {
      id,
      sessionId: h.sessionId,
      threadUri: sessionThreadUri({ ...h, ...f }),
      runId: f.runId || h.runId || null,
      role,
      workerNumber: number,
      milestoneId: f.milestoneId || "m1",
      featureId: f.id,
      title,
      label: `${role} #${number}: ${title}`,
      status,
      timeLabel: formatRelativeTime(
        h.completedAt,
        status === "running" ? "now" : status === "pending" ? "queued" : "done",
      ),
      childThreadId,
      kind: f.kind || (role === "Validator" ? "scrutiny" : "implementation"),
      model: f.model || null,
      providerInstanceId: f.providerInstanceId || null,
      handoff: {
        salientSummary:
          h.salientSummary ||
          h.whatWasImplemented ||
          f.description ||
          (status === "running" ? `Running ${title}` : `Scheduled ${title}`),
        whatWasImplemented: h.whatWasImplemented || "No handoff recorded yet.",
        commandsRun:
          Array.isArray(h.commandsRun) && h.commandsRun.length
            ? h.commandsRun
            : Array.isArray(h.tests)
              ? h.tests
              : [],
        discoveredIssues: Array.isArray(h.discoveredIssues) ? h.discoveredIssues : [],
        whatWasLeftUndone: Array.isArray(h.whatWasLeftUndone) ? h.whatWasLeftUndone : [],
        commit: h.commit || null,
        branch: h.branch || null,
        testedSha: h.testedSha || null,
        validatorsPassed: h.validatorsPassed ?? null,
      },
    });
  }

  if (state?.activeWorker) {
    const aw = state.activeWorker;
    const number = aw.workerNumber ?? null;
    const awId =
      aw.sessionId || aw.runId || (number !== null ? `worker-${number}` : "active-worker");
    const matchedFeature = featuresList.find((f) => f.id && f.id === aw.featureId) || null;
    const existing =
      byId.get(awId) ||
      Array.from(byId.values()).find((s) =>
        aw.runId
          ? s.runId === aw.runId
          : (number !== null && s.workerNumber === number) ||
            (aw.featureId && s.featureId === aw.featureId && s.status !== "completed"),
      );
    const role = inferSessionRole(aw, existing || matchedFeature);
    const featureTitle =
      aw.featureTitle ||
      aw.title ||
      existing?.title ||
      matchedFeature?.title ||
      aw.featureId ||
      "Active Feature";
    const status = aw.status || (state.status === "paused" ? "paused" : "running");
    const h = aw.handoff || {};
    const resolvedNumber = number ?? existing?.workerNumber ?? 1;

    const sessionObj = {
      id: existing?.id || awId,
      sessionId: sessionSelectorId(aw),
      threadUri: sessionThreadUri({ ...existing, ...aw }),
      runId: aw.runId || existing?.runId || null,
      role,
      workerNumber: resolvedNumber,
      milestoneId: aw.milestoneId || existing?.milestoneId || matchedFeature?.milestoneId || "m1",
      featureId: aw.featureId || existing?.featureId || awId,
      title: featureTitle,
      label: `${role} #${resolvedNumber}: ${featureTitle}`,
      status,
      timeLabel: "now",
      childThreadId: aw.childThreadId || aw.threadId || existing?.childThreadId || null,
      handoff: {
        salientSummary:
          aw.salientSummary ||
          h.salientSummary ||
          existing?.handoff?.salientSummary ||
          (status === "paused" ? `Paused ${featureTitle}` : `Running ${featureTitle}`),
        whatWasImplemented:
          aw.whatWasImplemented ||
          h.whatWasImplemented ||
          existing?.handoff?.whatWasImplemented ||
          "No handoff recorded yet.",
        commandsRun: Array.isArray(aw.commandsRun)
          ? aw.commandsRun
          : Array.isArray(h.commandsRun)
            ? h.commandsRun
            : Array.isArray(existing?.handoff?.commandsRun)
              ? existing.handoff.commandsRun
              : [],
        discoveredIssues: Array.isArray(aw.discoveredIssues)
          ? aw.discoveredIssues
          : Array.isArray(h.discoveredIssues)
            ? h.discoveredIssues
            : Array.isArray(existing?.handoff?.discoveredIssues)
              ? existing.handoff.discoveredIssues
              : [],
      },
    };
    byId.set(sessionObj.id, sessionObj);
  }

  return Array.from(byId.values());
}

function coalesceProgressLog(entries) {
  if (!Array.isArray(entries)) return [];
  const result = [];
  for (const item of entries) {
    const prev = result[result.length - 1];
    if (prev && item?.type === "model_slots_updated" && prev?.type === "model_slots_updated") {
      result[result.length - 1] = item;
    } else {
      result.push(item);
    }
  }
  return result;
}

function filterOrchestratorStreamEvents(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && e.type !== "model_slots_updated");
}

function activeExecutionClass(state) {
  return ["running", "orchestrator_turn", "initializing"].includes(state.status)
    ? "is-active-execution"
    : "";
}

function normalizeActivityEvent(row) {
  if (typeof row === "string") return { message: row, type: "message" };
  if (!row || row.type === "model_slots_updated") return null;
  const response = row.response?.structuredContent || row.response || {};
  const message =
    row.message || row.text || row.command || row.summary || response.message || response.status;
  return message
    ? { ...row, message: String(message), threadId: row.threadId || row.childThreadId }
    : null;
}

function activityEvents(snapshot) {
  const rows = Array.isArray(snapshot.threadFeed)
    ? snapshot.threadFeed
    : [...filterOrchestratorStreamEvents(snapshot.progressLog), ...(snapshot.observations || [])];
  return rows.map(normalizeActivityEvent).filter(Boolean);
}

function feedRowsHtml(events) {
  return (
    events
      .map(
        (event) => `
    <div class="feed-event-row" data-feed-type="${escapeHtml(event.type || "message")}">
      <div class="feed-event-meta">
        <span class="feed-role">${escapeHtml(event.role || "Orchestrator")}${event.workerNumber ? ` #${escapeHtml(event.workerNumber)}` : ""}</span>
        <span class="feed-type mono">${escapeHtml(event.type || "message")}</span>
        <span class="stream-time mono">${escapeHtml(formatRelativeTime(event.timestamp))}</span>
      </div>
      <div class="feed-event-message">${escapeHtml(event.message)}</div>
    </div>`,
      )
      .join("") || '<div class="feed-empty">No activity recorded yet.</div>'
  );
}

function taskBrief(snapshot, session) {
  const feature = (snapshot.features || []).find((row) => row.id === session.featureId);
  const raw = rawSession(snapshot, session);
  const brief = raw?.taskBrief || raw?.brief || raw?.task || feature?.description || feature?.title;
  return typeof brief === "string"
    ? brief
    : brief?.description || brief?.prompt || "No dispatched task brief recorded yet.";
}

function rawSession(snapshot, session) {
  return snapshot.state.activeWorker?.runId === session.runId
    ? snapshot.state.activeWorker
    : (snapshot.state.sessions || []).find((row) => row.runId === session.runId);
}

function mergeActivityEvents(local, remote = []) {
  return [...new Map([...local, ...remote].map((event) => [JSON.stringify(event), event])).values()]
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))
    .slice(-50);
}

function resolveOverviewFeedSession(snapshot) {
  const sessions = synthesizeSessions(snapshot.state, snapshot.features);
  const activeWorker = snapshot.state?.activeWorker;
  if (!activeWorker) return sessions.findLast((session) => session.childThreadId) || null;
  return (
    (activeWorker.runId && sessions.find((session) => session.runId === activeWorker.runId)) ||
    (activeWorker.childThreadId &&
      sessions.findLast((session) => session.childThreadId === activeWorker.childThreadId)) ||
    (activeWorker.featureId &&
      sessions.findLast((session) => session.featureId === activeWorker.featureId)) ||
    null
  );
}

function renderActivityFeed(snapshot) {
  const expanded = hudState.streamExpanded || hudState.boardTab === "stream";
  const activeSession = resolveOverviewFeedSession(snapshot);
  const remote = activeSession ? hudState.threadFeeds.get(sessionFeedKey(activeSession)) : null;
  const allEvents = mergeActivityEvents(activityEvents(snapshot), remote?.events);
  const isRunning =
    snapshot.state?.status === "running" || snapshot.state?.activeWorker?.status === "running";
  const compactLimit = isRunning ? 8 : 3;
  const events = allEvents.slice(expanded ? -50 : -compactLimit);
  const worker = snapshot.state.activeWorker;
  return `<section class="stream-card live-agent-feed-card">
    <div class="stream-card-header">
      <span class="stream-tag">Live Agent &amp; Orchestrator Activity</span>
      <button type="button" class="strip-btn" id="btn-toggle-stream" aria-expanded="${expanded}" aria-controls="overview-live-feed">${expanded ? `Compact (${compactLimit})` : "Expand Stream"}</button>
    </div>
    ${worker ? `<div class="task-brief"><span class="feed-role">Task brief</span><p>${escapeHtml(taskBrief(snapshot, worker))}</p></div>` : ""}
    <div class="live-agent-feed ${expanded ? "is-expanded" : ""}" id="overview-live-feed">${feedRowsHtml(events)}</div>
  </section>`;
}

function eventMatchesSession(event, session) {
  if (event.runId) return event.runId === session.runId;
  if (event.threadId) return event.threadId === session.childThreadId;
  if (event.sessionId) return event.sessionId === session.id;
  return Boolean(event.featureId && event.featureId === session.featureId && !session.runId);
}

function sessionFeedKey(session) {
  return `${session.runId || session.id}:${session.childThreadId || "local"}`;
}

function renderSessionActivity(snapshot, session) {
  const local = activityEvents(snapshot).filter((event) => eventMatchesSession(event, session));
  const remote = hudState.threadFeeds.get(sessionFeedKey(session));
  const events = mergeActivityEvents(local, remote?.events);
  const pending = rawSession(snapshot, session)?.dispatchPending === true;
  const running = session.status === "running" && !pending;
  return `<section class="stream-card diagnostic-card ${running ? "is-active-execution" : ""}" id="session-live-activity">
    <div class="stream-card-header">
      <span class="handoff-section-title">Live Thread &amp; Agent Activity</span>
      <span class="status-pill ${escapeHtml(session.status)}">${pending ? "Awaiting Orchestrator Dispatch" : running ? '<span class="session-icon running"></span>Live Agent Execution' : escapeHtml(session.status)}</span>
    </div>
    <div class="task-brief"><span class="feed-role">Task brief</span><p>${escapeHtml(taskBrief(snapshot, session))}</p></div>
    ${remote?.unavailable ? '<p class="feed-empty">Thread reader unavailable. Showing recorded Mission activity.</p>' : ""}
    <div class="session-live-feed">${feedRowsHtml(events)}</div>
  </section>`;
}

function bindStreamToggle(streamEl) {
  streamEl?.querySelector?.("#btn-toggle-stream")?.addEventListener?.("click", () => {
    hudState.streamExpanded = !hudState.streamExpanded;
    if (hudState.boardTab === "stream" && !hudState.streamExpanded) hudState.boardTab = "all";
    renderCenterColumn(hudState.snapshot);
  });
}

async function refreshSelectedThread() {
  const snapshot = hudState.snapshot;
  if (!snapshot || hudState.threadFeedPending) return;
  const session =
    hudState.selectedSessionId === "orchestrator"
      ? resolveOverviewFeedSession(snapshot)
      : synthesizeSessions(snapshot.state, snapshot.features).find(
          (row) => row.id === hudState.selectedSessionId,
        );
  if (!session?.childThreadId) return;
  const key = sessionFeedKey(session);
  hudState.threadFeedPending = true;
  try {
    const params = new URLSearchParams({
      threadId: session.childThreadId,
      sessionId: session.runId || session.id,
    });
    const response = await fetch(`/api/mission/thread-feed?${params}`);
    if (!response.ok) return;
    const feed = await response.json();
    hudState.threadFeeds.set(key, feed);
    if (hudState.selectedSessionId === "orchestrator") {
      const stream = document.getElementById("orchestrator-stream");
      const panel = stream?.querySelector(".live-agent-feed-card");
      if (panel) panel.outerHTML = renderActivityFeed(hudState.snapshot);
      bindStreamToggle(stream);
    } else if (hudState.selectedSessionId === session.id) {
      const panel = document.getElementById("session-live-activity");
      if (panel) panel.outerHTML = renderSessionActivity(hudState.snapshot, session);
    }
  } catch {
    // SSE and the recorded Mission feed remain available during transport failures.
  } finally {
    hudState.threadFeedPending = false;
  }
}

function milestoneCollapsed(group, state, assertions) {
  if (group.items.some((feature) => feature.id === state.activeWorker?.featureId)) return false;
  if (hudState.expandedMilestones.has(group.id)) return false;
  if (hudState.collapsedMilestones.has(group.id)) return true;
  return (
    group.items.every((feature) => feature.status === "completed") &&
    assertions.every((assertion) => assertion.status === "passed")
  );
}

function milestoneAssertions(group, assertions) {
  const linked = new Set(
    group.items.flatMap((feature) => feature.fulfills || feature.assertions || []),
  );
  return assertions.filter(
    (assertion) => assertion.milestoneId === group.id || linked.has(assertion.id),
  );
}

function milestoneToggleLabel(collapsed) {
  return collapsed ? "Expand" : "Collapse";
}

function sessionRunningClass(session) {
  return session.status === "running" ? "is-running-session" : "";
}

function orchestratorDotClass(state) {
  if (activeExecutionClass(state)) return "running";
  return state.status === "completed" ? "completed" : "pending";
}

function bindMilestoneToggles(element) {
  element?.querySelectorAll?.("[data-toggle-milestone]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.toggleMilestone;
      const expanded = button.getAttribute("aria-expanded") === "true";
      const include = expanded ? hudState.collapsedMilestones : hudState.expandedMilestones;
      const exclude = expanded ? hudState.expandedMilestones : hudState.collapsedMilestones;
      include.add(id);
      exclude.delete(id);
      button.closest?.(".milestone-swimlane")?.classList.toggle("collapsed", expanded);
      button.setAttribute("aria-expanded", String(!expanded));
      const label = button.querySelector?.(".milestone-toggle-label");
      if (label) label.textContent = milestoneToggleLabel(expanded);
    });
  });
}

function inspectFeatureSession(snapshot, featureId) {
  const sessions = synthesizeSessions(snapshot.state, snapshot.features);
  const match = sessions.findLast((session) => session.featureId === featureId);
  if (!match) return;
  hudState.selectedSessionId = match.id;
  renderCenterColumn(hudState.snapshot);
  renderSessionsColumn(hudState.snapshot);
  void refreshSelectedThread();
}

function bindFeatureSelection(element, snapshot) {
  element?.querySelectorAll?.(".feature-row").forEach((row) => {
    row.addEventListener("click", () => inspectFeatureSession(snapshot, row.dataset.featureId));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      inspectFeatureSession(snapshot, row.dataset.featureId);
    });
  });
}

function renderAssertionDisclosure(snapshot) {
  const assertions = snapshot.state.assertions || [];
  const collapsed =
    hudState.boardTab === "all" && assertions.length > 6 && !hudState.assertionsExpanded;
  const list = document.getElementById("assertions-list");
  list?.classList?.toggle?.("is-collapsed-drawer", collapsed);
  if (list)
    list.dataset.assertionFilter =
      hudState.boardTab === "contract" ? hudState.assertionFilter : "all";
  const toggle = document.getElementById("btn-toggle-assertions");
  if (toggle) {
    toggle.textContent = collapsed
      ? `Show all ${assertions.length} assertions`
      : "Collapse assertions";
    toggle.setAttribute?.("aria-expanded", String(!collapsed));
    toggle.classList.toggle("tab-hidden", hudState.boardTab !== "all" || assertions.length <= 6);
  }
  document
    .getElementById("assertion-filters")
    ?.classList?.toggle?.("tab-hidden", hudState.boardTab !== "contract");
}

function renderBoardDisclosure(snapshot) {
  const tab = hudState.boardTab;
  for (const [id, hidden] of [
    ["features-section", tab === "contract" || tab === "stream"],
    ["assertions-section", tab === "features" || tab === "stream"],
    ["orchestrator-stream", tab === "features" || tab === "contract"],
  ])
    document.getElementById(id)?.classList?.toggle?.("tab-hidden", hidden);
  document
    .getElementById("board-view-tabs")
    ?.querySelectorAll?.("[data-board-tab]")
    .forEach((button) => {
      const selected = button.dataset.boardTab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  renderAssertionDisclosure(snapshot);
}

function selectBoardTab(button) {
  hudState.boardTab = button.dataset.boardTab;
  if (hudState.boardTab === "stream") hudState.streamExpanded = true;
  renderCenterColumn(hudState.snapshot);
}

function bindBoardListeners() {
  const tabs = document.getElementById("board-view-tabs");
  const buttons = Array.from(tabs?.querySelectorAll?.("[data-board-tab]") || []);
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => selectBoardTab(button));
    button.addEventListener("keydown", (event) => {
      const indices = {
        ArrowRight: (index + 1) % buttons.length,
        ArrowLeft: (index + buttons.length - 1) % buttons.length,
        Home: 0,
        End: buttons.length - 1,
      };
      if (!(event.key in indices)) return;
      event.preventDefault();
      const target = buttons[indices[event.key]];
      selectBoardTab(target);
      target.focus();
    });
  });
  document.getElementById("btn-toggle-assertions")?.addEventListener?.("click", () => {
    hudState.assertionsExpanded = !hudState.assertionsExpanded;
    renderAssertionDisclosure(hudState.snapshot);
  });
  document
    .getElementById("assertion-filters")
    ?.querySelectorAll?.("[data-assertion-filter]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        hudState.assertionFilter = button.dataset.assertionFilter;
        document
          .getElementById("assertion-filters")
          .querySelectorAll("button")
          .forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        renderAssertionDisclosure(hudState.snapshot);
      });
    });
}

function formatApiErrorMessage(status, rawText) {
  let raw = String(rawText ?? "").trim();
  let resolvedStatus = status;
  const httpMatch = raw.match(/^HTTP\s+(\d+)\s*:\s*([\s\S]*)$/i);
  if (httpMatch) {
    if (!resolvedStatus) resolvedStatus = Number(httpMatch[1]);
    raw = httpMatch[2].trim();
  }
  const statusLabel = resolvedStatus ? `HTTP ${resolvedStatus}` : "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const baseSummary = String(
          parsed.diagnostic ||
            parsed.error ||
            parsed.gitCheck?.summary ||
            parsed.message ||
            statusLabel ||
            "Request failed",
        )
          .replace(/\s+/g, " ")
          .trim();
        const reasonSuffix =
          parsed.reasonCode &&
          parsed.reasonCode !== parsed.code &&
          !baseSummary.includes(String(parsed.reasonCode))
            ? ` (${parsed.reasonCode})`
            : "";
        const codePrefix =
          parsed.code &&
          !baseSummary.startsWith(`${parsed.code}:`) &&
          !baseSummary.includes(String(parsed.code))
            ? `${parsed.code}${reasonSuffix}: `
            : reasonSuffix
              ? `${parsed.reasonCode}: `
              : "";
        const withCode = `${codePrefix}${baseSummary}`.trim();
        const full =
          statusLabel && !withCode.includes(statusLabel)
            ? `${statusLabel} \u00b7 ${withCode}`
            : withCode;
        return full.length > 240 ? `${full.slice(0, 237)}...` : full;
      }
    } catch {
      // Fall through to plain-text sanitization
    }
  }
  const stripped = raw
    .replace(/\{[\s\S]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = stripped
    ? statusLabel && !stripped.includes(statusLabel)
      ? `${statusLabel}: ${stripped}`
      : stripped
    : statusLabel || "Request failed";
  return fallback.length > 240 ? `${fallback.slice(0, 237)}...` : fallback;
}

function handleActionError(err) {
  const rawMsg = err?.message || String(err);
  hudState.lastActionError = formatApiErrorMessage(null, rawMsg);
  const subEl = document.getElementById("status-strip-subtext");
  if (subEl) {
    const rev = hudState.snapshot?.state?.revision;
    subEl.textContent =
      rev != null
        ? `Revision #${rev} \u00b7 ${hudState.lastActionError}`
        : hudState.lastActionError;
  }
  const diagEl = document.getElementById("resume-diagnostic-card");
  if (diagEl) {
    const statusText = hudState.snapshot?.state?.status || "paused";
    diagEl.classList.add("error");
    diagEl.innerHTML = `
      <div class="stream-card-header">
        <span class="stream-tag">Action Blocked</span>
        <span class="stream-time mono">${escapeHtml(statusText)}</span>
      </div>
      <div class="stream-body">${escapeHtml(hudState.lastActionError)}</div>
    `;
  }
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(formatApiErrorMessage(res.status, errText));
  }
  hudState.lastActionError = null;
  const data = await res.json();
  if (data?.snapshot) {
    applySnapshot(data.snapshot);
  }
  return data;
}

const postAction = postJson;

function renderTopBar(snapshot) {
  renderReadiness(snapshot);
  const { state = {}, features } = snapshot;
  const repoEl = document.getElementById("mission-repo-path");
  const titleEl = document.getElementById("mission-title");
  const timeEl = document.getElementById("metric-time");
  const progressEl = document.getElementById("metric-progress");
  const progressBarEl = document.getElementById("metric-progress-bar");
  const contractEl = document.getElementById("metric-contract");
  const contractBarEl = document.getElementById("metric-contract-bar");
  const stripLabelEl = document.getElementById("status-strip-label");

  const isUninitialized =
    snapshot.initialized === false ||
    state?.initialized === false ||
    state?.status === "uninitialized";
  if (stripLabelEl && isUninitialized) {
    stripLabelEl.textContent = "UNINITIALIZED";
  }

  if (repoEl) repoEl.textContent = state.repoPath || "";
  if (titleEl) {
    titleEl.textContent =
      state.title ||
      (isUninitialized ? "Waiting for Mission Initialization" : "T3 Mission Control");
  }

  const elapsedMs = computeLiveElapsedMs(state);
  if (timeEl) timeEl.textContent = formatDurationHms(elapsedMs);
  updateElapsedAppearance(state);

  const totalFeatures = Array.isArray(features) ? features.length : 0;
  const completedFeatures = Array.isArray(features)
    ? features.filter((f) => f.status === "completed").length
    : 0;
  if (progressEl) {
    progressEl.textContent = `${completedFeatures}/${totalFeatures}`;
  }
  if (progressBarEl) {
    const pct = totalFeatures > 0 ? Math.round((completedFeatures / totalFeatures) * 100) : 0;
    progressBarEl.style.width = `${pct}%`;
  }

  const assertions = Array.isArray(state.assertions) ? state.assertions : [];
  const passedAssertions = assertions.filter((a) => a.status === "passed").length;
  if (contractEl) {
    contractEl.textContent = `${passedAssertions}/${assertions.length} PASSED`;
  }
  if (contractBarEl) {
    const cPct =
      assertions.length > 0 ? Math.round((passedAssertions / assertions.length) * 100) : 0;
    contractBarEl.style.width = `${cPct}%`;
  }
}

function renderStatusStrip(snapshot) {
  const { state = {}, features } = snapshot;
  const stripEl = document.getElementById("status-strip");
  const labelEl = document.getElementById("status-strip-label");
  const subEl = document.getElementById("status-strip-subtext");
  const approveBtn = document.getElementById("strip-approve-btn");
  const pauseBtn = document.getElementById("btn-pause");
  const resumeBtn = document.getElementById("btn-resume");
  const stepperTrackEl = document.getElementById("milestone-stepper-track");
  const pipelineTextEl = document.getElementById("pipeline-text");

  const isUninitialized =
    snapshot.initialized === false ||
    state?.initialized === false ||
    state?.status === "uninitialized";
  const status = isUninitialized ? "uninitialized" : state.status || "planning";
  if (stripEl) stripEl.dataset.status = status;
  if (labelEl) {
    labelEl.textContent = isUninitialized
      ? "UNINITIALIZED"
      : getStatusBannerText(state, snapshot.initialized);
  }

  const activeRole = state.activeWorker ? inferSessionRole(state.activeWorker) : "Worker";
  const workerNumStr =
    state.activeWorker?.workerNumber != null ? ` #${state.activeWorker.workerNumber}` : "";
  const isDispatchPending = Boolean(state.activeWorker?.dispatchPending === true);
  const activeWorkerSummary = state.activeWorker
    ? isDispatchPending
      ? ` \u00b7 ${activeRole}${workerNumStr} (Approved \u2014 waiting for Orchestrator to dispatch)`
      : ` \u00b7 ${activeRole}${workerNumStr} (${state.activeWorker.status || status})`
    : "";
  const activeError = status !== "completed" ? hudState.lastActionError : null;
  if (subEl) {
    subEl.textContent = activeError
      ? `Revision #${state.revision ?? 0} \u00b7 ${activeError}`
      : `Revision #${state.revision ?? 0}${activeWorkerSummary}`;
  }

  const needsApproval = !isUninitialized && status === "awaiting_input" && !state.planAccepted;
  if (approveBtn) {
    approveBtn.classList.toggle("hidden", !needsApproval);
    approveBtn.classList.toggle("is-primary-action", needsApproval);
  }
  if (pauseBtn) {
    pauseBtn.disabled = Boolean(
      isUninitialized ||
      status === "completed" ||
      status === "paused" ||
      (status === "awaiting_input" && !state.planAccepted),
    );
    pauseBtn.classList.toggle(
      "is-primary-action",
      status === "running" || status === "orchestrator_turn",
    );
  }
  if (resumeBtn) {
    resumeBtn.disabled = Boolean(
      isUninitialized ||
      status === "completed" ||
      status === "running" ||
      (status === "awaiting_input" && !state.planAccepted),
    );
    resumeBtn.classList.toggle("is-primary-action", status === "paused");
  }

  // Render Milestone Pipeline Stepper Strip
  const milestones = Array.isArray(state.milestones) ? state.milestones : [];
  const featuresList = Array.isArray(features) ? features : [];
  const assertionsList = Array.isArray(state.assertions) ? state.assertions : [];

  if (stepperTrackEl) {
    if (milestones.length > 0) {
      stepperTrackEl.innerHTML = milestones
        .map((m, idx) => {
          const mFeatures = featuresList.filter((f) => f.milestoneId === m.id);
          const doneCount = mFeatures.filter((f) => f.status === "completed").length;
          const isRunning = mFeatures.some((f) => f.status === "running");
          const allDone = mFeatures.length > 0 && doneCount === mFeatures.length;
          const pillClass = allDone ? "step-completed" : isRunning ? "step-active" : "";
          const badgeIcon = allDone ? "\u2713" : isRunning ? "\u25cf" : "";
          const arrow =
            idx < milestones.length - 1 ? `<span class="milestone-step-arrow">\u2192</span>` : "";
          return `
            <span class="milestone-step-pill ${pillClass}" data-milestone-id="${escapeHtml(m.id)}">
              <strong class="mono">${escapeHtml(m.id.toUpperCase())}</strong>
              <span>${escapeHtml(m.title || m.id)}</span>
              <span class="mono">${doneCount}/${mFeatures.length}${badgeIcon ? ` ${badgeIcon}` : ""}</span>
            </span>
            ${arrow}
          `;
        })
        .join("");
    } else {
      stepperTrackEl.innerHTML = "";
    }
  }

  if (pipelineTextEl) {
    if (milestones.length >= 1) {
      const mLabels = milestones.map((m) => {
        const mFeatures = featuresList.filter((f) => f.milestoneId === m.id);
        const mAssertions = assertionsList.filter((a) => a.milestoneId === m.id);
        const doneCount = mFeatures.filter((f) => f.status === "completed").length;
        const allFeaturesDone = mFeatures.length > 0 && doneCount === mFeatures.length;
        const allAssertionsPassed =
          mAssertions.length === 0 || mAssertions.every((a) => a.status === "passed");
        return allFeaturesDone && allAssertionsPassed
          ? `${m.id.toUpperCase()} \u2713`
          : `${m.id.toUpperCase()} (${m.title || m.id} ${doneCount}/${mFeatures.length})`;
      });
      pipelineTextEl.textContent = mLabels.join(" \u2192 ");
    } else {
      pipelineTextEl.textContent = isUninitialized
        ? "Waiting for mission initialization"
        : "No milestones registered yet";
    }
  }
}

function renderSessionsColumn(snapshot) {
  const { state = {}, features } = snapshot;
  const listEl = document.getElementById("sessions-list");
  const countEl = document.getElementById("sessions-count");
  if (!listEl) return;

  const sessions = synthesizeSessions(state, features);
  if (countEl) countEl.textContent = String(sessions.length + 1);

  const milestones = Array.isArray(state.milestones) ? state.milestones : [];

  let html = `
    <button
      type="button"
      class="session-item ${hudState.selectedSessionId === "orchestrator" ? "active" : ""}"
      data-session-id="orchestrator"
    >
      <span class="session-item-left">
        <span class="session-icon ${orchestratorDotClass(state)}"></span>
        <span class="session-label">Orchestrator Overview</span>
      </span>
      <span class="session-time mono">live</span>
    </button>
  `;

  const grouped = new Map();
  for (const m of milestones) {
    grouped.set(m.id, { title: `${m.id.toUpperCase()} \u00b7 ${m.title || m.id}`, items: [] });
  }
  for (const s of sessions) {
    const mId = s.milestoneId || milestones[0]?.id || "m1";
    if (!grouped.has(mId)) {
      grouped.set(mId, { title: mId.toUpperCase(), items: [] });
    }
    grouped.get(mId).items.push(s);
  }

  for (const [, group] of grouped.entries()) {
    if (group.items.length === 0) continue;
    html += `<div class="session-group-header">${escapeHtml(group.title)}</div>`;
    for (const item of group.items) {
      const isSelected = hudState.selectedSessionId === item.id;
      const dotClass =
        item.status === "running"
          ? "running"
          : item.status === "paused"
            ? "paused"
            : item.status === "failed"
              ? "failed"
              : item.status === "pending"
                ? "pending"
                : "completed";
      html += `
        <button
          type="button"
          class="session-item ${isSelected ? "active" : ""} ${sessionRunningClass(item)}"
          data-session-id="${escapeHtml(item.id)}"
          data-feature-id="${escapeHtml(item.featureId || "")}"
        >
          <span class="session-item-left">
            <span class="session-icon ${dotClass}"></span>
            <span class="session-label">${escapeHtml(item.label)}</span>
          </span>
          <span class="session-time mono">${escapeHtml(item.timeLabel)}</span>
        </button>
      `;
    }
  }

  listEl.innerHTML = html;

  listEl.querySelectorAll(".session-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      hudState.selectedSessionId = btn.dataset.sessionId || "orchestrator";
      renderCenterColumn(hudState.snapshot);
      renderSessionsColumn(hudState.snapshot);
      void refreshSelectedThread();
    });
  });
}

function renderMilestoneStart(group, state, assertions) {
  const doneInGroup = group.items.filter((f) => f.status === "completed").length;
  const groupAssertions = milestoneAssertions(group, assertions);
  const passedInGroup = groupAssertions.filter((a) => a.status === "passed").length;
  const collapsed = milestoneCollapsed(group, state, groupAssertions);
  const assertionMeta =
    groupAssertions.length > 0
      ? ` \u00b7 ${passedInGroup}/${groupAssertions.length} assertions`
      : "";

  return `
        <div class="milestone-swimlane ${collapsed ? "collapsed" : ""}" data-milestone-id="${escapeHtml(group.id)}">
          <button type="button" class="milestone-swimlane-header" data-toggle-milestone="${escapeHtml(group.id)}" aria-expanded="${!collapsed}" aria-controls="milestone-body-${escapeHtml(group.id)}">
            <div class="milestone-swimlane-title">
              <span class="milestone-badge">${escapeHtml(group.id.toUpperCase())}</span>
              <span>${escapeHtml(group.title)}</span>
            </div>
            <span class="milestone-swimlane-meta mono">${doneInGroup}/${group.items.length} features${escapeHtml(assertionMeta)}</span>
            <span class="milestone-toggle-label">${milestoneToggleLabel(collapsed)}</span>
          </button>
          <div class="milestone-features-body" id="milestone-body-${escapeHtml(group.id)}">
      `;
}

function renderFeaturesAndAssertions(snapshot) {
  const { state = {}, features } = snapshot;
  const featuresList = Array.isArray(features) ? features : [];
  const assertions = Array.isArray(state.assertions) ? state.assertions : [];
  const milestones = Array.isArray(state.milestones) ? state.milestones : [];

  // 1. Features Swimlanes (Full list — never truncated)
  const featuresCountEl = document.getElementById("features-count");
  const featuresListEl = document.getElementById("features-list");
  const totalFeatures = featuresList.length;
  const completedFeatures = featuresList.filter((f) => f.status === "completed").length;
  if (featuresCountEl) {
    featuresCountEl.textContent = `${completedFeatures}/${totalFeatures}`;
  }

  const assertionMap = new Map();
  for (const a of assertions) {
    if (a?.id) assertionMap.set(a.id, a);
  }

  if (featuresListEl) {
    const groups = new Map();
    for (const m of milestones) {
      groups.set(m.id, { id: m.id, title: m.title || m.id, items: [] });
    }
    for (const f of featuresList) {
      const mId = f.milestoneId || milestones[0]?.id || "m1";
      if (!groups.has(mId)) {
        groups.set(mId, { id: mId, title: mId.toUpperCase(), items: [] });
      }
      groups.get(mId).items.push(f);
    }

    let fHtml = "";
    for (const [, group] of groups.entries()) {
      if (group.items.length === 0) continue;
      fHtml += renderMilestoneStart(group, state, assertions);

      for (const f of group.items) {
        const st = String(f.status || "pending").toLowerCase();
        const checkClass =
          st === "completed"
            ? "done"
            : st === "running"
              ? "running"
              : st === "paused"
                ? "paused"
                : "";
        const icon =
          st === "completed"
            ? "\u2713"
            : st === "running"
              ? "\u25cf"
              : st === "paused"
                ? "||"
                : "\u2022";
        const kindLabel = f.kind || f.role || "implementation";
        const rawTargetOverride = f.target ?? f.workerTarget ?? f.slotConfig ?? f.model ?? null;
        const overrideModelLabel =
          typeof rawTargetOverride === "string"
            ? rawTargetOverride.trim()
            : rawTargetOverride && typeof rawTargetOverride === "object"
              ? String(
                  rawTargetOverride.model || rawTargetOverride.id || rawTargetOverride.label || "",
                ).trim()
              : "";
        const modelBadgeHtml = overrideModelLabel
          ? `<span class="feature-model-pill feature-kind-pill mono" data-feature-model="${escapeHtml(overrideModelLabel)}">${escapeHtml(overrideModelLabel)}</span>`
          : "";
        const isFeatureDispatchPending = Boolean(
          f.dispatchPending === true ||
          (state.activeWorker?.featureId === f.id && state.activeWorker?.dispatchPending === true),
        );
        const dispatchPendingPillHtml = isFeatureDispatchPending
          ? `<span class="status-pill awaiting-dispatch" data-dispatch-pending="true">Awaiting Orchestrator Dispatch</span>`
          : "";
        const linkedIds = Array.isArray(f.fulfills)
          ? f.fulfills
          : Array.isArray(f.assertions)
            ? f.assertions
            : [];
        const valPillsHtml = linkedIds.length
          ? `<div class="feature-val-pills">${linkedIds
              .map((valId) => {
                const aObj = assertionMap.get(valId);
                const aSt = String(aObj?.status || "pending").toLowerCase();
                return `<span class="val-pill ${escapeHtml(aSt)}">${escapeHtml(valId)}</span>`;
              })
              .join("")}</div>`
          : "";

        fHtml += `
          <div class="feature-row" data-feature-id="${escapeHtml(f.id)}" data-feature-status="${escapeHtml(st)}" role="button" tabindex="0" aria-label="Inspect ${escapeHtml(f.title || f.id)}">
            <div class="feature-row-main">
              <span class="feature-check ${checkClass}">${icon}</span>
              <div class="feature-info">
                <div class="feature-title-row">
                  <span class="feature-title">${escapeHtml(f.title || f.id)}</span>
                  <span class="feature-kind-pill mono">${escapeHtml(kindLabel)}</span>
                  ${modelBadgeHtml}
                </div>
                ${
                  f.lastHandoff?.whatWasImplemented
                    ? `<div class="feature-handoff-preview">${escapeHtml(f.lastHandoff.whatWasImplemented)}</div>`
                    : f.description
                      ? `<div class="feature-handoff-preview muted">${escapeHtml(f.description)}</div>`
                      : ""
                }
                ${valPillsHtml}
              </div>
            </div>
            <div class="feature-row-right">
              ${dispatchPendingPillHtml}
              <span class="status-pill ${escapeHtml(st)}">${escapeHtml(st)}</span>
            </div>
          </div>
        `;
      }
      fHtml += `</div></div>`;
    }

    featuresListEl.innerHTML =
      fHtml ||
      `<div style="padding:12px 14px;color:var(--text-muted);font-size:12px;">No features planned yet.</div>`;

    bindFeatureSelection(featuresListEl, snapshot);
    bindMilestoneToggles(featuresListEl);
  }

  // 2. Validation Contract Matrix (Full list — never truncated)
  const assertionsCountEl = document.getElementById("assertions-count");
  const assertionsListEl = document.getElementById("assertions-list");
  const passedAssertions = assertions.filter((a) => a.status === "passed").length;
  if (assertionsCountEl) {
    assertionsCountEl.textContent = `${passedAssertions}/${assertions.length}`;
  }
  if (assertionsListEl) {
    assertionsListEl.innerHTML = assertions.length
      ? assertions
          .map((a) => {
            const st = String(a.status || "pending").toLowerCase();
            const mBadge = a.milestoneId
              ? `<span class="milestone-badge">${escapeHtml(String(a.milestoneId).toUpperCase())}</span>`
              : "";
            return `
              <div class="assertion-row" data-assertion-id="${escapeHtml(a.id)}" data-assertion-status="${escapeHtml(st)}">
                <div class="assertion-main">
                  <span class="assertion-id-badge">${escapeHtml(a.id)}</span>
                  ${mBadge}
                  <span class="assertion-desc">${escapeHtml(a.description || "")}</span>
                </div>
                <span class="status-pill ${escapeHtml(st)}">${escapeHtml(st)}</span>
              </div>
            `;
          })
          .join("")
      : `<div style="padding:12px 14px;color:var(--text-muted);font-size:12px;">No validation assertions registered yet.</div>`;
  }
}

function captureInputFocus(id) {
  const input = document.activeElement;
  return input?.id === id ? { start: input.selectionStart, end: input.selectionEnd } : null;
}

function restoreFeedbackFocus(input, selection) {
  if (!input || !selection) return;
  input.focus?.({ preventScroll: true });
  input.setSelectionRange?.(selection.start, selection.end);
}

function renderCenterColumn(snapshot) {
  const { initialized, state = {}, features } = snapshot;
  const onboardingEl = document.getElementById("onboarding-card");
  const approvalEl = document.getElementById("plan-approval-card");
  const inspectorEl = document.getElementById("session-inspector");
  const handoffEl = document.getElementById("session-handoff-view");
  const streamEl = document.getElementById("orchestrator-stream");

  // 1. Uninitialized onboarding notice
  if (onboardingEl) {
    if (!initialized) {
      onboardingEl.classList.remove("hidden");
      onboardingEl.innerHTML = `
        <div class="approval-badge" style="margin-bottom:8px;">UNINITIALIZED</div>
        <h2>${escapeHtml(state.onboarding?.headline || "Mission directory (.mission/) is not initialized yet")}</h2>
        <p>${escapeHtml(state.onboarding?.instructions || "Use /mission <request> in T3 Code to propose a mission plan and Validation Contract.")}</p>
      `;
    } else {
      onboardingEl.classList.add("hidden");
    }
  }

  // 2. High-Clarity Plan Review Banner when status === "awaiting_input" && !planAccepted
  const showApprovalCard = state.status === "awaiting_input" && !state.planAccepted;
  const feedbackFocus = captureInputFocus("plan-feedback");
  if (approvalEl) {
    if (showApprovalCard) {
      if (
        typeof approvalEl.innerHTML === "string" &&
        approvalEl.innerHTML.includes('id="plan-feedback"')
      ) {
        const existingFeedbackInput = approvalEl.querySelector?.("#plan-feedback");
        if (existingFeedbackInput && typeof existingFeedbackInput.value === "string") {
          hudState.planFeedbackDraft = existingFeedbackInput.value;
        }
      }
      approvalEl.classList.remove("hidden");
      const milestones = Array.isArray(state.milestones) ? state.milestones : [];
      const featuresList = Array.isArray(features) ? features : [];
      const assertions = Array.isArray(state.assertions) ? state.assertions : [];
      const draftValue = hudState.planFeedbackDraft || "";
      approvalEl.innerHTML = `
        <div class="approval-banner-top">
          <div class="approval-heading-group">
            <div class="approval-badge-row">
              <span class="approval-badge">Plan Review &amp; Validation Contract</span>
              <div class="approval-summary-pills">
                <span class="approval-stat-pill mono">${milestones.length} Milestones</span>
                <span class="approval-stat-pill mono">${featuresList.length} Planned Features</span>
                <span class="approval-stat-pill mono">${assertions.length} Validation Assertions</span>
              </div>
            </div>
            <h2 class="approval-title">${escapeHtml(state.title || "Mission Plan Ready for Approval")}</h2>
            <div class="approval-hint">Review milestones and the Validation Contract, then approve to dispatch the first worker or request revisions.</div>
          </div>
        </div>
        <div class="approval-feedback-group">
          <label class="approval-feedback-label" for="plan-feedback">Revision Feedback <span class="approval-feedback-optional">(optional, sent with Request Changes)</span></label>
          <div class="approval-controls-row">
            <input id="plan-feedback" type="text" class="plan-feedback-input" placeholder="Describe requested changes to milestones, features, or VAL-* assertions..." value="${escapeHtml(draftValue)}">
            <div class="approval-actions approval-actions-bar">
              <button type="button" class="strip-btn btn-request-changes" id="btn-reject-plan" data-action="reject-plan">Request Changes</button>
              <button type="button" class="btn-primary-approve" id="btn-approve" data-testid="btn-approve-mission" data-action="approve">\u2713 Approve &amp; Start Mission</button>
            </div>
          </div>
        </div>
      `;
      const feedbackInputEl = approvalEl.querySelector("#plan-feedback");
      if (feedbackInputEl) {
        if (draftValue) {
          feedbackInputEl.value = draftValue;
        }
        feedbackInputEl.addEventListener?.("input", (ev) => {
          hudState.planFeedbackDraft = ev?.target?.value ?? feedbackInputEl.value ?? "";
        });
        feedbackInputEl.addEventListener?.("change", (ev) => {
          hudState.planFeedbackDraft = ev?.target?.value ?? feedbackInputEl.value ?? "";
        });
      }
      approvalEl.querySelector("#btn-reject-plan")?.addEventListener("click", async () => {
        const inputBeforeSubmit = approvalEl.querySelector("#plan-feedback");
        const currentFeedback = inputBeforeSubmit?.value || hudState.planFeedbackDraft || "";
        try {
          hudState.planFeedbackDraft = "";
          if (inputBeforeSubmit) inputBeforeSubmit.value = "";
          await postAction("/api/mission/reject", {
            feedback: currentFeedback,
          });
          hudState.planFeedbackDraft = "";
          const inputAfterSubmit = approvalEl.querySelector("#plan-feedback");
          if (inputAfterSubmit) inputAfterSubmit.value = "";
        } catch (err) {
          hudState.planFeedbackDraft = currentFeedback;
          const inputOnError = approvalEl.querySelector("#plan-feedback");
          if (inputOnError) inputOnError.value = currentFeedback;
          handleActionError(err);
        }
      });
      const approveBtn = approvalEl.querySelector("#btn-approve");
      approveBtn?.addEventListener("click", async () => {
        try {
          await triggerApprove();
        } catch (err) {
          handleActionError(err);
        }
      });
      restoreFeedbackFocus(feedbackInputEl, feedbackFocus);
    } else {
      hudState.planFeedbackDraft = "";
      approvalEl.innerHTML = "";
      approvalEl.classList.add("hidden");
    }
  }

  // 3. Session Handoff Inspector when a Worker/Validator session is selected
  const sessions = synthesizeSessions(state, features);
  const selectedSession =
    hudState.selectedSessionId !== "orchestrator"
      ? sessions.find((s) => s.id === hudState.selectedSessionId) || null
      : null;

  const boardEl = document.getElementById("execution-board");
  if (handoffEl) {
    if (selectedSession) {
      inspectorEl?.classList.remove("hidden");
      handoffEl.classList.remove("hidden");
      boardEl?.classList.add("hidden");
      const threadUri = sessionThreadUri(selectedSession);
      const steerFocus = captureInputFocus("session-steer-input");
      const commands = Array.isArray(selectedSession.handoff?.commandsRun)
        ? selectedSession.handoff.commandsRun
        : [];
      const issues = Array.isArray(selectedSession.handoff?.discoveredIssues)
        ? selectedSession.handoff.discoveredIssues
        : [];
      const leftUndone = Array.isArray(selectedSession.handoff?.whatWasLeftUndone)
        ? selectedSession.handoff.whatWasLeftUndone
        : [];
      const isValidator = selectedSession.role === "Validator";
      const kindBadge = isValidator
        ? selectedSession.kind === "user_testing"
          ? "User-Testing Validator"
          : "Scrutiny Validator"
        : "Implementation Worker";
      const shaLabel = isValidator
        ? selectedSession.handoff?.testedSha || selectedSession.handoff?.commit || ""
        : selectedSession.handoff?.commit || "";
      const branchLabel = selectedSession.handoff?.branch || "";
      const modelMeta = [selectedSession.providerInstanceId, selectedSession.model]
        .filter(Boolean)
        .join(" / ");

      handoffEl.innerHTML = `
        <div class="handoff-header">
          <div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <span class="status-pill ${escapeHtml(selectedSession.status)}">${escapeHtml(kindBadge)} \u00b7 ${escapeHtml(selectedSession.status)}</span>
              ${modelMeta ? `<span class="feature-kind-pill mono">${escapeHtml(modelMeta)}</span>` : ""}
            </div>
            <h3 class="handoff-title" style="margin-top:8px;">${escapeHtml(selectedSession.label)}</h3>
            <details class="handoff-git-meta"><summary>Git metadata</summary>
              ${shaLabel ? `<span class="feature-kind-pill mono" title="${escapeHtml(shaLabel)}">${isValidator ? "Audited SHA" : "Commit"}: ${escapeHtml(shaLabel.substring(0, 8))}</span>` : ""}
              ${branchLabel ? `<span class="feature-kind-pill mono">${escapeHtml(branchLabel)}</span>` : ""}
            </details>
          </div>
          <div class="handoff-link-chip">
            <code class="mono" id="handoff-thread-uri">${escapeHtml(threadUri || "Unavailable")}</code>
            ${threadOpenLink(threadUri)}
            <button
              type="button"
              class="strip-btn"
              id="btn-copy-thread-uri"
              data-thread-uri="${escapeHtml(threadUri)}"
              ${threadUri ? "" : "disabled"}
            >
              ${hudState.copiedThreadUri === threadUri ? "\u2713 Copied" : "Copy URI"}
            </button>
            <button type="button" class="strip-btn" id="btn-back-orchestrator">
              \u2190 Back to Overview
            </button>
          </div>
        </div>

        ${renderSessionSteering(selectedSession)}

        ${renderSessionActivity(snapshot, selectedSession)}

        <div>
          <div class="handoff-section-title">${isValidator ? "Validation Verdict & Summary" : "Salient Summary"}</div>
          <div class="handoff-box" id="handoff-salient-summary">
            ${escapeHtml(selectedSession.handoff?.salientSummary || "No summary recorded.")}
          </div>
        </div>

        <div>
          <div class="handoff-section-title">${isValidator ? "Detailed Audit & Sandbox Verification Output" : "What Was Implemented (Agent Output)"}</div>
          <div class="handoff-box" id="handoff-what-was-implemented">
            ${escapeHtml(selectedSession.handoff?.whatWasImplemented || "No handoff recorded yet.")}
          </div>
        </div>

        <div>
          <div class="handoff-section-title">${isValidator ? "Verification Checks Executed" : "Commands & Tests Run"} (${commands.length})</div>
          <div class="handoff-box mono" id="handoff-commands-run">
            ${
              commands.length
                ? commands
                    .map((cmd) => {
                      if (typeof cmd === "string") {
                        return `<div class="cmd-line">$ ${escapeHtml(cmd)}</div>`;
                      }
                      const st = String(cmd.status || "passed").toUpperCase();
                      return `<div class="cmd-line"><span class="cmd-status-badge ${escapeHtml(String(cmd.status || "passed").toLowerCase())}">[${escapeHtml(st)}]</span> $ ${escapeHtml(cmd.command || JSON.stringify(cmd))}</div>`;
                    })
                    .join("")
                : "No commands recorded yet."
            }
          </div>
        </div>

        <div>
          <div class="handoff-section-title">${isValidator ? "Audit Findings & Discovered Issues" : "Discovered Issues"} (${issues.length})</div>
          <div class="handoff-box" id="handoff-discovered-issues">
            ${
              issues.length
                ? issues
                    .map((iss) =>
                      typeof iss === "string"
                        ? `\u2022 ${escapeHtml(iss)}`
                        : `\u2022 ${escapeHtml(iss.summary || iss.description || JSON.stringify(iss))}`,
                    )
                    .join("<br/>")
                : "No issues recorded yet."
            }
          </div>
        </div>
        ${
          leftUndone.length
            ? `<div>
                <div class="handoff-section-title">Notes / Deferred Items (${leftUndone.length})</div>
                <div class="handoff-box">${leftUndone.map((item) => `\u2022 ${escapeHtml(typeof item === "string" ? item : JSON.stringify(item))}`).join("<br/>")}</div>
              </div>`
            : ""
        }
      `;

      bindSessionSteering(handoffEl, selectedSession);
      restoreFeedbackFocus(handoffEl.querySelector("#session-steer-input"), steerFocus);

      handoffEl.querySelector("#btn-back-orchestrator")?.addEventListener("click", () => {
        hudState.selectedSessionId = "orchestrator";
        renderCenterColumn(hudState.snapshot);
        renderSessionsColumn(hudState.snapshot);
      });

      handoffEl.querySelector("#btn-copy-thread-uri")?.addEventListener("click", async (e) => {
        const uri = e.currentTarget.dataset.threadUri;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(uri);
          }
        } catch {
          /* Optional cleanup or data is unavailable; retain the current state. */
        }
        hudState.copiedThreadUri = uri;
        renderCenterColumn(hudState.snapshot);
      });
    } else {
      inspectorEl?.classList.add("hidden");
      handoffEl.classList.add("hidden");
      boardEl?.classList.remove("hidden");
    }
  }

  // 4. Orchestrator Status & Diagnostic Stream (Zero model_slots_updated spam)
  if (streamEl) {
    const featuresList = Array.isArray(features) ? features : [];
    const totalFeatures = featuresList.length;
    const completedFeatures = featuresList.filter((f) => f.status === "completed").length;
    const isCompleted =
      state.status === "completed" ||
      (!state.activeWorker && completedFeatures === totalFeatures && totalFeatures > 0);

    const activeRole = state.activeWorker ? inferSessionRole(state.activeWorker) : "Worker";
    const activeWorkerNum =
      state.activeWorker?.workerNumber != null ? ` #${state.activeWorker.workerNumber}` : "";
    const activeWorkerTitle =
      state.activeWorker?.featureTitle ||
      state.activeWorker?.title ||
      state.activeWorker?.featureId ||
      "active feature";

    const activeError = !isCompleted ? hudState.lastActionError : null;
    const showResumeDiagnostic =
      Boolean(state.lastResumeDiagnostic) &&
      !isCompleted &&
      (state.status === "paused" ||
        (state.activeWorker?.resumePending === true &&
          Boolean(state.activeWorker?.featureId) &&
          String(state.lastResumeDiagnostic).includes(state.activeWorker.featureId)));

    const isDispatchPending = Boolean(state.activeWorker?.dispatchPending === true);
    const resumeDiagnostic = activeError
      ? activeError
      : isCompleted
        ? "All milestones, features, and validation assertions completed."
        : showResumeDiagnostic
          ? state.lastResumeDiagnostic
          : state.activeWorker
            ? isDispatchPending
              ? `Approved \u2014 waiting for Orchestrator to dispatch ${activeRole}${activeWorkerNum} (${activeWorkerTitle}).`
              : `${activeRole}${activeWorkerNum} (${activeWorkerTitle}) is currently ${state.activeWorker.status || state.status}.`
            : `Mission status is ${state.status || "planning"}.`;

    streamEl.innerHTML = `
      <div class="owner-thread-link">${threadOpenLink(sessionThreadUri({ childThreadId: state.ownerThreadId }), selectedSession ? "btn-open-owner-thread-uri" : "btn-open-thread-uri")}</div>
      <div class="stream-card diagnostic-card ${activeError ? "error" : ""} ${activeExecutionClass(state)}" id="resume-diagnostic-card">
        <div class="stream-card-header">
          <span class="stream-tag">${activeError ? "Action Blocked" : isDispatchPending ? "Awaiting Orchestrator Dispatch" : "Execution Status"}</span>
          <span class="stream-time mono">${escapeHtml(isDispatchPending ? "Approved — waiting for Orchestrator to dispatch" : state.status || "planning")}</span>
        </div>
        <div class="stream-body">${escapeHtml(resumeDiagnostic)}</div>
      </div>
      ${renderActivityFeed(snapshot)}
    `;
    bindStreamToggle(streamEl);
  }

  // 5. Render Milestone Swimlanes & Validation Contract Matrix
  renderFeaturesAndAssertions(snapshot);
  renderBoardDisclosure(snapshot);
}

function renderRightColumn(snapshot) {
  const { modelSettings, progressLog, catalog } = snapshot;

  const effortLevelNames = {
    1: "minimal",
    2: "low",
    3: "medium",
    4: "high",
    5: "max",
  };

  // 1. Role Models 3-Slot Controls
  for (const slot of ["orchestrator", "worker", "validator"]) {
    const selectEl = document.getElementById(`model-select-${slot}`);
    const barsEl = document.getElementById(`effort-bars-${slot}`);
    const slotCfg = modelSettings?.[slot] || {};
    const currentModel = slotCfg.model || "gpt-6.1-sol";
    const currentEffort = Number(slotCfg.effort || slotCfg.options?.effort || 4);

    const optionsList = Array.isArray(catalog) ? [...catalog] : [];
    const catalogEntry = optionsList.find((c) => c.model === currentModel || c.id === currentModel);
    const supportsEffort =
      catalogEntry?.supportsEffort !== undefined
        ? Boolean(catalogEntry.supportsEffort)
        : slotCfg.supportsEffort !== undefined
          ? Boolean(slotCfg.supportsEffort)
          : slotCfg.providerInstanceId !== "antigravity" &&
            !/-(low|medium|high)$/i.test(currentModel);

    if (!catalogEntry) {
      optionsList.unshift({
        id: currentModel,
        model: currentModel,
        label: slotCfg.label || currentModel,
        providerInstanceId: slotCfg.providerInstanceId || "custom",
        supportsEffort,
        effort: supportsEffort ? currentEffort : null,
      });
    }

    if (selectEl) {
      selectEl.innerHTML = optionsList
        .map(
          (item) => `
            <option
              value="${escapeHtml(item.model)}"
              data-provider="${escapeHtml(item.providerInstanceId || "")}"
              data-label="${escapeHtml(item.label || item.model)}"
              data-supports-effort="${item.supportsEffort !== false}"
              data-effort="${escapeHtml(item.supportsEffort === false ? "" : item.effort || 4)}"
              ${item.model === currentModel ? "selected" : ""}
            >
              ${escapeHtml(item.label || item.model)}
            </option>
          `,
        )
        .join("");
    }

    if (barsEl) {
      if (!supportsEffort) {
        barsEl.classList.add("hidden");
        barsEl.style.display = "none";
        barsEl.innerHTML = "";
        barsEl.setAttribute?.("aria-hidden", "true");
      } else {
        barsEl.classList.remove("hidden");
        barsEl.style.display = "";
        barsEl.removeAttribute?.("aria-hidden");

        const effortLabels = {
          1: "Minimal",
          2: "Low",
          3: "Medium",
          4: "High",
          5: "Max",
        };
        let optionsHtml = "";
        let legacyBtnsHtml = "";
        for (let level = 1; level <= 5; level++) {
          const isActive = level <= currentEffort;
          const isSelected = level === currentEffort;
          const levelName = effortLevelNames[level] || "high";
          const displayLabel = effortLabels[level] || levelName;
          optionsHtml += `<option value="${level}" ${isSelected ? "selected" : ""}>${displayLabel}</option>`;
          legacyBtnsHtml += `<button type="button" class="effort-bar-btn ${isActive ? "filled active" : ""}" data-slot="${slot}" data-effort="${level}" title="Reasoning Effort: ${levelName} (${level}/5)" aria-label="${slot} effort ${level}" style="display:none;"></button>`;
        }
        barsEl.innerHTML = `
          <select
            class="slot-effort-select"
            id="effort-select-${slot}"
            data-slot="${slot}"
            title="Reasoning Effort"
            aria-label="${slot} Reasoning Effort"
          >${optionsHtml}</select>
          ${legacyBtnsHtml}
        `;

        const effortSelectEl = barsEl.querySelector?.(".slot-effort-select");
        effortSelectEl?.addEventListener("change", async (e) => {
          try {
            const newEffort = Number(e.target.value || 4);
            await updateModelSlot(slot, {
              model: selectEl?.value || currentModel,
              effort: newEffort,
            });
          } catch (err) {
            handleActionError(err);
          }
        });

        barsEl.querySelectorAll(".effort-bar-btn").forEach((btn) => {
          btn.addEventListener("click", async () => {
            try {
              const newEffort = Number(btn.dataset.effort || 4);
              await updateModelSlot(slot, {
                model: selectEl?.value || currentModel,
                effort: newEffort,
              });
            } catch (err) {
              handleActionError(err);
            }
          });
        });
      }
    }
  }

  // 2. Activity Timeline (coalesces consecutive model_slots_updated entries)
  const logCountEl = document.getElementById("progress-log-count");
  const logListEl = document.getElementById("progress-log-list");
  const coalesced = coalesceProgressLog(progressLog || []);
  const entries = [...coalesced].reverse();
  if (logCountEl) logCountEl.textContent = String(entries.length);

  if (logListEl) {
    logListEl.innerHTML = entries.length
      ? entries
          .map(
            (item) => `
              <div class="log-row" data-log-seq="${escapeHtml(item.seq || "")}" data-log-type="${escapeHtml(item.type || "info")}">
                <div class="log-row-top">
                  <span class="log-type mono">${escapeHtml(item.type || "event")}</span>
                  <span class="log-time mono">${escapeHtml(formatRelativeTime(item.timestamp, "now"))}</span>
                </div>
                <span class="log-msg">${escapeHtml(item.message)}</span>
              </div>
            `,
          )
          .join("")
      : `<div style="color:var(--text-muted);font-size:12px;">No activity events yet.</div>`;
  }
}

export function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const prevRev = hudState.snapshot?.state?.revision;
  const nextStatus = snapshot?.state?.status;
  const nextRev = snapshot?.state?.revision;
  if (
    nextStatus === "running" ||
    nextStatus === "completed" ||
    (prevRev != null &&
      nextRev != null &&
      nextRev > prevRev &&
      nextStatus !== "paused" &&
      nextStatus !== "blocked")
  ) {
    hudState.lastActionError = null;
  }
  hudState.snapshot = snapshot;
  renderTopBar(snapshot);
  renderStatusStrip(snapshot);
  renderSessionsColumn(snapshot);
  renderCenterColumn(snapshot);
  renderRightColumn(snapshot);
}

async function triggerApprove() {
  try {
    await postAction("/api/mission/approve", {
      approvedBy: "user",
    });
    hudState.planFeedbackDraft = "";
    const approvalEl = document.getElementById("plan-approval-card");
    const inputAfterApprove = approvalEl?.querySelector?.("#plan-feedback");
    if (inputAfterApprove) inputAfterApprove.value = "";
  } catch (err) {
    handleActionError(err);
  }
}

async function triggerPause() {
  try {
    await postAction("/api/mission/pause", {
      requestedBy: "user",
    });
  } catch (err) {
    handleActionError(err);
  }
}

async function triggerResume() {
  try {
    await postAction("/api/mission/resume", {
      trigger: "[resume the mission]",
    });
  } catch (err) {
    handleActionError(err);
  }
}

async function updateModelSlot(slot, { model, providerInstanceId, label, effort }) {
  const statusEl = document.getElementById("model-save-status");
  if (statusEl) statusEl.textContent = "Saving...";
  const payload = { slot, model, providerInstanceId, label };
  if (effort !== undefined && effort !== null) {
    payload.effort = effort;
  }
  try {
    await postAction("/api/mission/model-slots", payload);
    if (statusEl) statusEl.textContent = "Saved";
  } catch (err) {
    if (statusEl) statusEl.textContent = "Error";
    handleActionError(err);
  }
}

function bindStaticListeners() {
  bindBoardListeners();
  document.getElementById("strip-approve-btn")?.addEventListener("click", async () => {
    try {
      await triggerApprove();
    } catch (err) {
      handleActionError(err);
    }
  });
  document.getElementById("btn-pause")?.addEventListener("click", async () => {
    try {
      await triggerPause();
    } catch (err) {
      handleActionError(err);
    }
  });
  document.getElementById("btn-resume")?.addEventListener("click", async () => {
    try {
      await triggerResume();
    } catch (err) {
      handleActionError(err);
    }
  });

  for (const slot of ["orchestrator", "worker", "validator"]) {
    const selectEl = document.getElementById(`model-select-${slot}`);
    selectEl?.addEventListener("change", async (e) => {
      try {
        const opt = e.target.selectedOptions?.[0];
        const model = e.target.value;
        const providerInstanceId = opt?.dataset?.provider || undefined;
        const label = opt?.dataset?.label || undefined;
        const optSupportsEffort = opt?.dataset?.supportsEffort !== "false";
        const currentEffort = optSupportsEffort
          ? hudState.snapshot?.modelSettings?.[slot]?.effort || Number(opt?.dataset?.effort || 4)
          : null;
        await updateModelSlot(slot, {
          model,
          providerInstanceId,
          label,
          ...(optSupportsEffort ? { effort: currentEffort } : {}),
        });
      } catch (err) {
        handleActionError(err);
      }
    });
  }
}

function connectSseStream() {
  const indicatorEl = document.getElementById("sse-indicator");
  const url = hudState.lastEventId
    ? `/api/mission/stream?lastEventId=${encodeURIComponent(hudState.lastEventId)}`
    : "/api/mission/stream";
  const es = new EventSource(url);

  es.addEventListener("open", () => {
    hudState.sseConnected = true;
    if (indicatorEl) indicatorEl.textContent = "\u25cf Live";
  });

  es.addEventListener("mission_snapshot", (event) => {
    if (event.lastEventId) {
      hudState.lastEventId = event.lastEventId;
    }
    try {
      const payload = JSON.parse(event.data);
      applySnapshot(payload);
    } catch {
      /* Optional cleanup or data is unavailable; retain the current state. */
    }
  });

  es.addEventListener("error", () => {
    hudState.sseConnected = false;
    if (indicatorEl) indicatorEl.textContent = "\u25cb Reconnecting";
  });
}

function startLiveElapsedTicker() {
  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    const snapshot = hudState.snapshot;
    if (snapshot?.state) {
      const timeEl = document.getElementById("metric-time");
      if (timeEl) {
        timeEl.textContent = formatDurationHms(computeLiveElapsedMs(snapshot.state));
      }
      if (
        ticks % 2 === 0 &&
        (snapshot.state.status === "running" ||
          snapshot.state.status === "orchestrator_turn" ||
          snapshot.state.activeWorker?.childThreadId)
      )
        void refreshSelectedThread();
    }
  }, 1000);
}

async function initHud() {
  bindStaticListeners();
  try {
    const res = await fetch("/api/mission/state");
    if (res.ok) {
      const snapshot = await res.json();
      applySnapshot(snapshot);
    }
  } catch {
    /* Optional cleanup or data is unavailable; retain the current state. */
  }

  connectSseStream();
  startLiveElapsedTicker();
  setInterval(refreshSelectedThread, 4000);
}

initHud();
