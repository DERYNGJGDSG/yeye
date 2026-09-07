const APP_KEY = "system-analyst-mvp-v1";
const EXAM_DATE = "2026-10-24";
const DAY_MS = 24 * 60 * 60 * 1000;

const TIMER_MODES = {
  weekday: {
    label: "工作日 150 分钟",
    stages: [
      ["闭卷回忆", 15],
      ["定点学习", 60],
      ["强制输出", 45],
      ["订正", 20],
      ["收尾", 10]
    ]
  },
  weekend: {
    label: "周末 5 小时",
    stages: [
      ["主题学习", 110],
      ["休息", 20],
      ["计时输出", 110],
      ["复盘", 60]
    ]
  },
  simulation: {
    label: "全真模拟",
    stages: [
      ["综合＋案例", 240],
      ["中间休息", 30],
      ["论文", 120]
    ]
  }
};

let currentView = "today";
let timerInterval = null;
let toastTimeout = null;
let state = loadState();

const app = document.getElementById("app");
const toastElement = document.getElementById("toast");
const sidebar = document.getElementById("sidebar");

function parseDate(iso) {
  const [year, month, dayNumber] = iso.split("-").map(Number);
  return new Date(year, month - 1, dayNumber, 12, 0, 0, 0);
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateLabel(iso, format = "short") {
  const date = parseDate(iso);
  if (format === "long") return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return `${String(date.getMonth() + 1).padStart(2, "0")} / ${String(date.getDate()).padStart(2, "0")}`;
}

function daysBetween(fromIso, toIso) {
  return Math.round((parseDate(toIso) - parseDate(fromIso)) / DAY_MS);
}

function getInitialDate() {
  const current = todayIso();
  if (PLAN.some((item) => item.date === current)) return current;
  if (current < PLAN[0].date) return PLAN[0].date;
  return PLAN[PLAN.length - 1].date;
}

function timerForMode(mode) {
  const selected = TIMER_MODES[mode] || TIMER_MODES.weekday;
  return {
    mode: TIMER_MODES[mode] ? mode : "weekday",
    stageIndex: 0,
    remaining: selected.stages[0][1] * 60,
    running: false,
    lastTick: null
  };
}

function suggestedTimerMode(item) {
  if (!item) return "weekday";
  if (item.type === "simulation") return "simulation";
  return item.hours === "5h" ? "weekend" : "weekday";
}

function makeDefaultState() {
  const selectedDay = PLAN.find((item) => item.date === getInitialDate()) || PLAN[0];
  const suggestedMode = suggestedTimerMode(selectedDay);
  return {
    selectedDate: selectedDay.date,
    completed: {},
    notes: {},
    scores: [],
    retests: [],
    essayCards: TOPICS.map((topic, index) => ({
      id: `card-${index + 1}`,
      topic,
      background: "",
      role: "",
      points: "",
      metrics: "",
      limitation: "",
      keywords: ""
    })),
    essays: [
      { id: "essay-1", label: "论文 1", plannedDate: "2026-09-13", completed: false, score: "" },
      { id: "essay-2", label: "论文 2", plannedDate: "2026-09-20", completed: false, score: "" },
      { id: "essay-3", label: "论文 3", plannedDate: "2026-09-27", completed: false, score: "" },
      { id: "essay-4", label: "论文 4", plannedDate: "2026-10-10", completed: false, score: "" },
      { id: "essay-5", label: "论文 5", plannedDate: "2026-10-18", completed: false, score: "" }
    ],
    timer: timerForMode(suggestedMode)
  };
}

function loadState() {
  const base = makeDefaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(APP_KEY) || "null");
    if (!saved) return base;
    const mergedCards = base.essayCards.map((card) => ({
      ...card,
      ...(Array.isArray(saved.essayCards) ? saved.essayCards.find((item) => item.id === card.id) : {})
    }));
    const mergedEssays = base.essays.map((essay) => ({
      ...essay,
      ...(Array.isArray(saved.essays) ? saved.essays.find((item) => item.id === essay.id) : {})
    }));
    const timer = saved.timer && TIMER_MODES[saved.timer.mode] ? { ...timerForMode(saved.timer.mode), ...saved.timer } : base.timer;
    timer.running = false;
    timer.lastTick = null;
    return {
      ...base,
      ...saved,
      selectedDate: PLAN.some((item) => item.date === saved.selectedDate) ? saved.selectedDate : base.selectedDate,
      completed: saved.completed && typeof saved.completed === "object" ? saved.completed : {},
      notes: saved.notes && typeof saved.notes === "object" ? saved.notes : {},
      scores: Array.isArray(saved.scores) ? saved.scores : [],
      retests: Array.isArray(saved.retests) ? saved.retests : [],
      essayCards: mergedCards,
      essays: mergedEssays,
      timer
    };
  } catch (error) {
    return base;
  }
}

function saveState() {
  try {
    localStorage.setItem(APP_KEY, JSON.stringify(state));
  } catch (error) {
    showToast("浏览器暂时无法保存，请使用导出备份");
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTimer(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function selectedDay() {
  return PLAN.find((item) => item.date === state.selectedDate) || PLAN[0];
}

function isTaskDone(dayNumber, taskId) {
  return Boolean(state.completed[`${dayNumber}:${taskId}`]);
}

function dayCompletion(item) {
  const total = item.tasks.length;
  const done = item.tasks.filter((task) => isTaskDone(item.number, task.id)).length;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

function overallCompletion() {
  const total = PLAN.reduce((sum, item) => sum + item.tasks.length, 0);
  const done = PLAN.reduce((sum, item) => sum + dayCompletion(item).done, 0);
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

function latestScore(subject) {
  return state.scores
    .filter((entry) => entry.subject === subject)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

function scoreStatus(subject, score) {
  if (score === null || score === undefined || score === "") return { label: "待记录", className: "risk-warn" };
  const config = SUBJECTS.find((item) => item.id === subject);
  const number = Number(score);
  if (number < config.pass) return { label: "需要救援", className: "risk-danger" };
  if (number < config.target) return { label: "继续巩固", className: "risk-warn" };
  return { label: "达到目标", className: "risk-safe" };
}

function scoreCard(subjectConfig) {
  const latest = latestScore(subjectConfig.id);
  const value = latest ? Number(latest.score) : null;
  const status = scoreStatus(subjectConfig.id, value);
  const width = value === null ? 0 : Math.min(100, Math.round((value / 75) * 100));
  return `
    <article class="score-card subject-accent-${subjectConfig.color}">
      <div class="score-card-header">
        <div class="subject-name">${escapeHtml(subjectConfig.short)}</div>
        <span class="score-pill ${status.className}">${status.label}</span>
      </div>
      <div class="score-number ${value === null ? "empty" : ""}">${value === null ? "—" : escapeHtml(value)}</div>
      <div class="score-meta">目标 ${subjectConfig.target} · 合格线 ${subjectConfig.pass}${latest ? ` · ${escapeHtml(dateLabel(latest.date))}` : ""}</div>
      <div class="score-track"><span class="${subjectConfig.color}" style="width:${width}%"></span></div>
    </article>`;
}

function examCountdown() {
  const days = daysBetween(todayIso(), EXAM_DATE);
  if (days > 0) return `还有 ${days} 天`;
  if (days === 0) return "今天考试";
  return "考试已结束";
}

function updateHeader() {
  const kicker = document.getElementById("page-kicker");
  const title = document.getElementById("page-title");
  const headings = {
    today: ["今日执行", `D${selectedDay().number} · ${dateLabel(selectedDay().date, "long")}`],
    plan: ["49 天路线", "完整备考计划"],
    review: ["结果与复测", "复盘" ]
  };
  const [nextKicker, nextTitle] = headings[currentView] || headings.today;
  if (kicker) kicker.textContent = nextKicker;
  if (title) title.textContent = nextTitle;
  const countdown = document.getElementById("sidebar-countdown");
  if (countdown) countdown.textContent = examCountdown();
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === currentView));
}

function render() {
  updateHeader();
  if (currentView === "plan") app.innerHTML = renderPlanView();
  else if (currentView === "review") app.innerHTML = renderReviewView();
  else app.innerHTML = renderTodayView();
  updateTimerDisplay();
  if (currentView === "today") ensureTimerInterval();
}

function renderTodayView() {
  const item = selectedDay();
  const completion = dayCompletion(item);
  const overall = overallCompletion();
  const isToday = item.date === todayIso();
  if (item.date === EXAM_DATE) return renderExamDay();
  const modeHint = suggestedTimerMode(item);
  const modeLabel = TIMER_MODES[modeHint].label;
  return `
    <div class="view-stack">
      <section class="hero-grid">
        <article class="hero-card primary">
          <div class="eyebrow">${isToday ? "今天" : "所选日期"} · ${escapeHtml(item.week)}</div>
          <h2>${escapeHtml(item.title)}</h2>
          <p class="hero-caption">${escapeHtml(item.deliverable)}</p>
          <div class="hero-meta">
            <span class="hero-pill">${escapeHtml(dateLabel(item.date, "long"))} ${escapeHtml(item.weekday)}</span>
            <span class="hero-pill">${escapeHtml(item.hours)}</span>
            <span class="hero-pill">今日完成 ${completion.done}/${completion.total}</span>
          </div>
          <div class="hero-actions">
            <button class="primary-button" type="button" data-action="scroll-to" data-target="timer-card">开始 ${escapeHtml(modeLabel)}</button>
            ${!isToday ? '<button class="secondary-button" type="button" data-action="jump-today">回到今天</button>' : ""}
          </div>
        </article>
        <article class="card progress-card">
          <div class="progress-top">
            <div>
              <div class="progress-title">计划执行率</div>
              <div class="progress-subtitle">完成每日任务即可推进进度。只记录结果，不追求盲目时长。</div>
            </div>
            <div class="progress-ring" style="--progress:${overall.percent}%"><span>${overall.percent}%</span></div>
          </div>
          <div>
            <div class="progress-bar"><span style="width:${overall.percent}%"></span></div>
            <div class="progress-foot"><span>${overall.done} / ${overall.total} 个任务</span><span>考试 ${dateLabel(EXAM_DATE, "long")}</span></div>
          </div>
        </article>
      </section>

      <section class="card">
        <div class="section-heading">
          <div><h2>今日计划</h2><p>先完成 A 项；B 项只在时间充足时补强。</p></div>
          <span class="muted">验收：${escapeHtml(item.deliverable)}</span>
        </div>
        <div class="task-list">
          ${item.tasks.map((task) => `
            <label class="task-row ${isTaskDone(item.number, task.id) ? "done" : ""}">
              <input class="task-checkbox" type="checkbox" data-action="toggle-task" data-day="${item.number}" data-task="${escapeHtml(task.id)}" ${isTaskDone(item.number, task.id) ? "checked" : ""} />
              <span class="task-content"><span class="task-line"><span class="priority priority-${task.priority.toLowerCase()}">${task.priority}</span><span class="task-text">${escapeHtml(task.text)}</span></span></span>
            </label>`).join("")}
        </div>
        <div class="deliverable-box"><strong>今日验收产出</strong>${escapeHtml(item.deliverable)}</div>
        <div class="field" style="margin-top:14px"><label for="daily-note">快速记录</label><textarea class="note-box" id="daily-note" data-note-date="${item.date}" placeholder="记下分数、错因、复测日期，或一句收尾总结……">${escapeHtml(state.notes[item.date] || "")}</textarea></div>
      </section>

      <section class="stats-grid">
        ${SUBJECTS.map((subject) => {
          const latest = latestScore(subject.id);
          const status = scoreStatus(subject.id, latest ? latest.score : "");
          return `<article class="stat-card subject-accent-${subject.color}"><div class="stat-label">${escapeHtml(subject.short)}</div><div class="stat-value">${latest ? escapeHtml(latest.score) : "—"}</div><div class="stat-note">${status.label} · 目标 ${subject.target}</div></article>`;
        }).join("")}
      </section>

      ${renderTimerCard(modeHint)}

      <section class="quick-grid">
        <article class="quick-card"><h3>今天的原则</h3><p>如果只能学习 60 分钟，保留计时输出、订正和复测，不补看长视频。</p><button class="secondary-button full-button" type="button" data-action="set-view" data-view="review">去看复测清单</button></article>
        <article class="quick-card"><h3>需要调整计划？</h3><p>中断时不要双倍补课，把未完成 A 项移到最近 B 项时段，模拟日保持不变。</p><button class="secondary-button full-button" type="button" data-action="set-view" data-view="plan">打开完整计划</button></article>
      </section>
    </div>`;
}

function renderExamDay() {
  return `
    <div class="view-stack">
      <section class="exam-day">
        <div class="big-symbol">✓</div>
        <h2>今天是考试日</h2>
        <p>按照准考证和考场指令执行。提前到场，先做确定题；论文优先选择与你的项目素材最匹配的题目。</p>
        <div class="hero-actions" style="justify-content:center"><button class="primary-button" type="button" data-action="set-view" data-view="review">查看最后复盘</button></div>
      </section>
    </div>`;
}

function renderTimerCard(suggestedMode) {
  const timer = state.timer;
  const mode = TIMER_MODES[timer.mode] || TIMER_MODES.weekday;
  const currentStage = mode.stages[timer.stageIndex] || mode.stages[0];
  const totalSeconds = currentStage[1] * 60;
  const percent = totalSeconds ? Math.min(100, Math.max(0, Math.round((1 - timer.remaining / totalSeconds) * 100))) : 0;
  const buttonLabel = timer.running ? "暂停" : timer.remaining === 0 ? "重新开始" : "开始";
  return `
    <section class="timer-card" id="timer-card">
      <div>
        <div class="eyebrow">专注计时</div>
        <div class="timer-mode">
          ${Object.entries(TIMER_MODES).map(([key, item]) => `<button class="mode-button ${timer.mode === key ? "active" : ""}" type="button" data-action="timer-mode" data-mode="${key}">${escapeHtml(item.label)}</button>`).join("")}
        </div>
        <div class="timer-stage" style="margin-top:20px">当前环节 · ${escapeHtml(currentStage[0])}</div>
        <div class="timer-display" data-timer-display>${formatTimer(timer.remaining)}</div>
        <div class="timer-progress"><span data-timer-progress style="width:${percent}%"></span></div>
        <div class="timer-controls">
          <button class="primary-button" type="button" data-action="timer-toggle">${buttonLabel}</button>
          <button class="secondary-button" type="button" data-action="timer-next">跳过到下一环节</button>
          <button class="secondary-button" type="button" data-action="timer-reset">重置</button>
        </div>
        <div class="muted" style="margin-top:12px">建议模式：${escapeHtml(TIMER_MODES[suggestedMode].label)}。计时只是辅助，完成任务才算推进。</div>
      </div>
      <div class="timer-stages">
        ${mode.stages.map((stage, index) => {
          const isDone = index < timer.stageIndex || (index === timer.stageIndex && timer.remaining === 0 && index === mode.stages.length - 1);
          return `<div class="timer-stage-row ${index === timer.stageIndex ? "active" : ""} ${isDone ? "done" : ""}"><span>${isDone ? "✓ " : ""}${escapeHtml(stage[0])}</span><span>${stage[1]} 分钟</span></div>`;
        }).join("")}
      </div>
    </section>`;
}

function renderPlanView() {
  const overall = overallCompletion();
  return `
    <div class="view-stack">
      <section class="hero-grid">
        <article class="hero-card primary">
          <div class="eyebrow">路线总览</div>
          <h2>把 49 天变成每天的一小步。</h2>
          <p class="hero-caption">计划已经按 W1—W7 编排。点选任意一天，今日页会切换到对应任务和计时模板。</p>
          <div class="hero-meta"><span class="hero-pill">${overall.percent}% 已执行</span><span class="hero-pill">${overall.done} 个任务完成</span></div>
        </article>
        <article class="card progress-card">
          <div class="progress-title">目标结构</div>
          <div class="progress-subtitle">综合 ≥52 · 案例 ≥50 · 论文 ≥50</div>
          <div class="progress-foot" style="margin-top:20px"><span>工作日 2.5 小时</span><span>周末 5 小时</span></div>
          <button class="secondary-button full-button" style="margin-top:14px" type="button" data-action="jump-today">定位今天</button>
        </article>
      </section>
      <div class="week-grid">
        ${WEEK_META.map((week) => {
          const days = PLAN.filter((item) => item.week === week.id);
          return `<section class="week-card">
            <div class="week-header"><div><div class="week-code">${week.id}</div><div class="week-range">${week.range}</div></div><div class="week-theme">${escapeHtml(week.theme)}</div></div>
            <div class="day-list">${days.map((item) => {
              const progress = dayCompletion(item);
              const status = progress.done === progress.total ? "complete" : progress.done > 0 ? "partial" : "";
              return `<div class="day-row ${item.date === state.selectedDate ? "selected" : ""}" data-action="select-day" data-date="${item.date}">
                <div class="day-number">D${item.number}</div>
                <div class="day-info"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(dateLabel(item.date))} ${escapeHtml(item.weekday)} · ${escapeHtml(item.hours)} · ${progress.done}/${progress.total}</span></div>
                ${item.type === "simulation" ? '<span class="day-simulation">模拟</span>' : ""}
                <span class="day-status ${status}"></span>
              </div>`;
            }).join("")}</div>
          </section>`;
        }).join("")}
      </div>
    </div>`;
}

function renderReviewView() {
  const selected = state.selectedDate;
  const dueRetests = [...state.retests].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return `
    <div class="view-stack">
      <section>
        <div class="section-heading"><div><h2>三科闸门</h2><p>记录最近一次成绩，App 会按计划目标自动显示状态。</p></div><span class="muted">合格线都是 45 分</span></div>
        <div class="score-grid">${SUBJECTS.map(scoreCard).join("")}</div>
      </section>

      <section class="split-grid">
        <div class="stack">
          <article class="card">
            <div class="section-heading"><div><h2>记录成绩</h2><p>模拟、诊断或日常训练都可以记录。</p></div></div>
            <form data-form="score">
              <div class="form-grid">
                <div class="field"><label for="score-date">日期</label><input id="score-date" name="date" type="date" value="${selected}" required /></div>
                <div class="field"><label for="score-kind">类型</label><select id="score-kind" name="kind"><option>全真模拟</option><option>阶段闸门</option><option>日常训练</option><option>诊断</option></select></div>
                <div class="field"><label for="score-subject">科目</label><select id="score-subject" name="subject">${SUBJECTS.map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.id)}</option>`).join("")}</select></div>
                <div class="field"><label for="score-value">分数（0—75）</label><input id="score-value" name="score" type="number" min="0" max="75" step="1" placeholder="例如 52" required /></div>
              </div>
              <div class="form-actions"><button class="primary-button" type="submit">保存成绩</button></div>
            </form>
          </article>

          <article class="card">
            <div class="section-heading"><div><h2>错题复测</h2><p>只写错因、一行规则和复测日期。</p></div></div>
            <form data-form="retest">
              <div class="inline-form">
                <div class="field"><label for="retest-rule">规则 / 错因</label><input id="retest-rule" name="rule" placeholder="例如：DFD 平衡原则漏项" required /></div>
                <div class="field"><label for="retest-date">复测日期</label><input id="retest-date" name="date" type="date" value="${selected}" required /></div>
                <button class="primary-button" type="submit">加入复测</button>
              </div>
            </form>
            <div class="review-list" style="margin-top:15px">${dueRetests.length ? dueRetests.map(renderRetest).join("") : '<div class="empty-state">还没有复测项。今天订正时顺手加一条。</div>'}</div>
          </article>
        </div>

        <div class="stack">
          <article class="card">
            <div class="section-heading"><div><h2>论文完成记录</h2><p>5 篇完整限时文，记录完成与自评分。</p></div></div>
            <div class="essay-records">${state.essays.map((essay) => `
              <div class="essay-record">
                <input class="review-check" type="checkbox" data-action="toggle-essay" data-essay-id="${essay.id}" ${essay.completed ? "checked" : ""} />
                <div><strong>${escapeHtml(essay.label)}</strong><br /><small>计划 ${escapeHtml(dateLabel(essay.plannedDate))} · ${essay.completed ? "已完成" : "待完成"}</small></div>
                <input type="number" min="0" max="20" step="1" placeholder="自评/20" value="${escapeHtml(essay.score)}" data-essay-score="${essay.id}" aria-label="${escapeHtml(essay.label)}自评分" />
              </div>`).join("")}</div>
          </article>
          <article class="card">
            <div class="section-heading"><div><h2>六张论文论题卡</h2><p>填入自己的项目素材，不写万能模板。</p></div></div>
            <div class="essay-grid">${state.essayCards.map(renderEssayCard).join("")}</div>
          </article>
        </div>
      </section>

      <section class="card">
        <div class="section-heading"><div><h2>最近成绩</h2><p>用于观察趋势，不把看了多少小时当成结果。</p></div></div>
        ${state.scores.length ? `<div class="review-list">${[...state.scores].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12).map((entry) => `<div class="review-item"><span class="mini-tag">${escapeHtml(entry.subject)}</span><div class="review-text"><strong>${escapeHtml(entry.score)} 分 · ${escapeHtml(entry.kind || "训练")}</strong><div class="review-date">${escapeHtml(dateLabel(entry.date, "long"))}</div></div></div>`).join("")}</div>` : '<div class="empty-state">还没有成绩记录。完成一次诊断或模拟后，在上面记录。</div>'}
      </section>
    </div>`;
}

function renderRetest(item) {
  const overdue = item.date < selectedDay().date && !item.done;
  return `<label class="review-item ${overdue ? "overdue" : ""} ${item.done ? "done" : ""}">
    <input class="review-check" type="checkbox" data-action="toggle-retest" data-retest-id="${escapeHtml(item.id)}" ${item.done ? "checked" : ""} />
    <span class="review-text"><strong>${escapeHtml(item.rule)}</strong><div class="review-date">${overdue ? "已逾期 · " : "复测 · "}${escapeHtml(dateLabel(item.date, "long"))}</div></span>
    <button class="small-button" type="button" data-action="remove-retest" data-retest-id="${escapeHtml(item.id)}">删除</button>
  </label>`;
}

function renderEssayCard(card) {
  return `<article class="essay-card">
    <h3>${escapeHtml(card.topic)}</h3>
    <div class="field"><label>项目背景</label><textarea data-card-id="${card.id}" data-card-field="background" placeholder="行业、用户、规模、周期、约束">${escapeHtml(card.background)}</textarea></div>
    <div class="field"><label>本人角色与边界</label><textarea data-card-id="${card.id}" data-card-field="role" placeholder="我负责什么，与谁协作">${escapeHtml(card.role)}</textarea></div>
    <div class="field"><label>三个论点 / 决策</label><textarea data-card-id="${card.id}" data-card-field="points" placeholder="问题 → 判断 → 措施 → 权衡 → 结果">${escapeHtml(card.points)}</textarea></div>
    <div class="field"><label>指标、局限、关键词</label><textarea data-card-id="${card.id}" data-card-field="metrics" placeholder="量化指标；失败/改进；题干关键词">${escapeHtml(card.metrics)}</textarea></div>
  </article>`;
}

function showToast(message) {
  if (!toastElement) return;
  toastElement.textContent = message;
  toastElement.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toastElement.classList.remove("show"), 2300);
}

function setView(view) {
  if (!view || !["today", "plan", "review"].includes(view)) return;
  currentView = view;
  sidebar.classList.remove("open");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function ensureTimerInterval() {
  if (timerInterval) return;
  timerInterval = window.setInterval(tickTimer, 1000);
}

function tickTimer() {
  const timer = state.timer;
  if (!timer || !timer.running) return;
  const now = Date.now();
  const last = timer.lastTick || now;
  const elapsed = Math.floor((now - last) / 1000);
  if (elapsed < 1) return;
  timer.remaining -= elapsed;
  timer.lastTick = last + elapsed * 1000;
  if (timer.remaining <= 0) {
    timer.remaining = 0;
    timer.running = false;
    saveState();
    render();
    showToast("这个计时环节完成了");
    return;
  }
  if (elapsed >= 5 || now % 5000 < 1000) saveState();
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const display = document.querySelector("[data-timer-display]");
  const progressElement = document.querySelector("[data-timer-progress]");
  if (!display || !progressElement) return;
  const mode = TIMER_MODES[state.timer.mode] || TIMER_MODES.weekday;
  const stage = mode.stages[state.timer.stageIndex] || mode.stages[0];
  const total = stage[1] * 60;
  const percent = total ? Math.min(100, Math.max(0, Math.round((1 - state.timer.remaining / total) * 100))) : 0;
  display.textContent = formatTimer(state.timer.remaining);
  progressElement.style.width = `${percent}%`;
}

function resetTimer(mode = state.timer.mode) {
  state.timer = timerForMode(mode);
  saveState();
}

function nextTimerStage() {
  const timer = state.timer;
  const mode = TIMER_MODES[timer.mode] || TIMER_MODES.weekday;
  if (timer.stageIndex >= mode.stages.length - 1) {
    resetTimer(timer.mode);
    showToast("本轮计时已完成，可以重新开始");
    return;
  }
  timer.stageIndex += 1;
  timer.remaining = mode.stages[timer.stageIndex][1] * 60;
  timer.running = false;
  timer.lastTick = null;
  saveState();
  render();
}

function exportBackup() {
  const payload = {
    app: "system-analyst-mvp",
    version: 1,
    exportedAt: new Date().toISOString(),
    state
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `系统分析师备考备份-${todayIso()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("备份文件已生成");
}

function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      const incoming = payload.state || payload;
      const base = makeDefaultState();
      state = {
        ...base,
        ...incoming,
        selectedDate: PLAN.some((item) => item.date === incoming.selectedDate) ? incoming.selectedDate : base.selectedDate,
        completed: incoming.completed && typeof incoming.completed === "object" ? incoming.completed : {},
        notes: incoming.notes && typeof incoming.notes === "object" ? incoming.notes : {},
        scores: Array.isArray(incoming.scores) ? incoming.scores : [],
        retests: Array.isArray(incoming.retests) ? incoming.retests : [],
        essayCards: base.essayCards.map((card) => ({ ...card, ...(Array.isArray(incoming.essayCards) ? incoming.essayCards.find((item) => item.id === card.id) : {}) })),
        essays: base.essays.map((essay) => ({ ...essay, ...(Array.isArray(incoming.essays) ? incoming.essays.find((item) => item.id === essay.id) : {}) })),
        timer: timerForMode("weekday")
      };
      saveState();
      render();
      showToast("备份已导入");
    } catch (error) {
      showToast("导入失败：不是有效的备份文件");
    }
  };
  reader.readAsText(file);
}

function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "set-view") {
    setView(target.dataset.view);
  } else if (action === "jump-today") {
    const current = PLAN.find((item) => item.date === todayIso());
    state.selectedDate = current ? current.date : getInitialDate();
    if (!state.timer.running) resetTimer(suggestedTimerMode(current || selectedDay()));
    saveState();
    setView("today");
  } else if (action === "scroll-to") {
    document.getElementById(target.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (action === "select-day") {
    const nextDay = PLAN.find((item) => item.date === target.dataset.date) || PLAN[0];
    state.selectedDate = nextDay.date;
    if (!state.timer.running) resetTimer(suggestedTimerMode(nextDay));
    saveState();
    setView("today");
  } else if (action === "timer-mode") {
    resetTimer(target.dataset.mode);
    render();
  } else if (action === "timer-toggle") {
    if (state.timer.remaining === 0) resetTimer(state.timer.mode);
    state.timer.running = !state.timer.running;
    state.timer.lastTick = state.timer.running ? Date.now() : null;
    saveState();
    render();
    showToast(state.timer.running ? "计时开始" : "计时已暂停");
  } else if (action === "timer-reset") {
    resetTimer(state.timer.mode);
    render();
    showToast("计时已重置");
  } else if (action === "timer-next") {
    nextTimerStage();
  } else if (action === "remove-retest") {
    state.retests = state.retests.filter((item) => item.id !== target.dataset.retestId);
    saveState();
    render();
  }
}

function handleChange(event) {
  const target = event.target;
  const action = target.dataset.action;
  if (action === "toggle-task") {
    state.completed[`${target.dataset.day}:${target.dataset.task}`] = target.checked;
    saveState();
    render();
    showToast(target.checked ? "任务已完成" : "已取消完成");
  } else if (action === "toggle-retest") {
    const item = state.retests.find((entry) => entry.id === target.dataset.retestId);
    if (item) item.done = target.checked;
    saveState();
    render();
  } else if (action === "toggle-essay") {
    const essay = state.essays.find((entry) => entry.id === target.dataset.essayId);
    if (essay) essay.completed = target.checked;
    saveState();
    render();
  }
}

function handleInput(event) {
  const target = event.target;
  if (target.dataset.noteDate) {
    state.notes[target.dataset.noteDate] = target.value;
    saveState();
  } else if (target.dataset.cardId && target.dataset.cardField) {
    const card = state.essayCards.find((item) => item.id === target.dataset.cardId);
    if (card) card[target.dataset.cardField] = target.value;
    saveState();
  } else if (target.dataset.essayScore) {
    const essay = state.essays.find((entry) => entry.id === target.dataset.essayScore);
    if (essay) essay.score = target.value;
    saveState();
  }
}

function handleSubmit(event) {
  const form = event.target;
  if (!form.matches("form[data-form]")) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.dataset.form === "score") {
    const score = Number(data.get("score"));
    const subject = String(data.get("subject"));
    if (!Number.isFinite(score) || score < 0 || score > 75) {
      showToast("请输入 0—75 之间的分数");
      return;
    }
    state.scores.push({ id: `score-${Date.now()}`, date: String(data.get("date")), subject, score, kind: String(data.get("kind")), createdAt: new Date().toISOString() });
    saveState();
    form.reset();
    render();
    showToast("成绩已记录");
  } else if (form.dataset.form === "retest") {
    const rule = String(data.get("rule") || "").trim();
    const date = String(data.get("date") || "");
    if (!rule || !date) return;
    state.retests.push({ id: `retest-${Date.now()}`, rule, date, done: false });
    saveState();
    render();
    showToast("已加入复测清单");
  }
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav && !nav.matches("[data-action]")) setView(nav.dataset.view);
  handleClick(event);
});
app.addEventListener("change", handleChange);
app.addEventListener("input", handleInput);
document.addEventListener("submit", handleSubmit);

document.getElementById("menu-button")?.addEventListener("click", () => sidebar.classList.toggle("open"));
document.getElementById("export-button")?.addEventListener("click", exportBackup);
document.getElementById("import-input")?.addEventListener("change", (event) => {
  importBackup(event.target.files?.[0]);
  event.target.value = "";
});

window.addEventListener("beforeunload", saveState);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

render();
