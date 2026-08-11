import { createHash } from "node:crypto";

import { JIRA_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "duedate",
  "assignee",
  "reporter",
  "created",
  "updated",
];
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

function quoteJqlString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildJiraJql(projects = []) {
  const projectFilter = projects.length > 0
    ? ` AND project in (${projects.map(quoteJqlString).join(", ")})`
    : "";
  return `assignee = currentUser()${projectFilter} AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC`;
}

function includesAny(value, terms) {
  const normalized = String(value ?? "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

export function taskStatusFromJira(status) {
  const name = status?.name ?? "";
  const category = status?.statusCategory?.key;
  if (category === "done") {
    return includesAny(name, ["cancel", "reject", "取消", "拒绝"]) ? "canceled" : "done";
  }
  if (category === "new") {
    return includesAny(name, ["backlog", "待立项", "需求池"]) ? "backlog" : "todo";
  }
  if (includesAny(name, ["review", "verify", "test", "验收", "评审", "测试"])) {
    return "in_review";
  }
  if (includesAny(name, ["block", "hold", "阻塞", "挂起"])) return "blocked";
  return "in_progress";
}

export function taskPriorityFromJira(priority) {
  const name = priority?.name ?? "";
  if (includesAny(name, ["highest", "critical", "blocker", "urgent", "紧急", "最高"])) {
    return "urgent";
  }
  if (includesAny(name, ["high", "major", "高"])) return "high";
  if (includesAny(name, ["medium", "normal", "中"])) return "medium";
  if (includesAny(name, ["low", "minor", "trivial", "低"])) return "low";
  return "none";
}

function actorFromJira(user, fallback) {
  const id = limitedString(user?.key ?? user?.name ?? user?.accountId, fallback, 240);
  return {
    type: "user",
    id: `jira:${id}`,
    name: limitedString(user?.displayName ?? user?.name, fallback, 120),
    avatarUrl: user?.avatarUrls?.["48x48"] ?? user?.avatarUrls?.["32x32"] ?? null,
  };
}

function jiraOriginId(baseUrl) {
  return createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
}

function normalizeIssue(issue, config, index = 0) {
  const fields = issue?.fields ?? {};
  const assignee = actorFromJira(fields.assignee, config.displayName);
  const reporter = actorFromJira(fields.reporter, config.displayName);
  const labels = Array.isArray(fields.labels)
    ? [...new Set(fields.labels.flatMap((label) => {
      if (typeof label !== "string") return [];
      const normalized = label.trim().slice(0, 64);
      return normalized ? [normalized] : [];
    }))].slice(0, 20)
    : [];
  return {
    id: `jira:${jiraOriginId(config.baseUrl)}:${String(issue.id)}`,
    identifier: limitedString(issue.key, "JIRA", 128),
    title: limitedString(fields.summary, String(issue.key), 240),
    description: typeof fields.description === "string" ? fields.description.slice(0, 100_000) : "",
    status: taskStatusFromJira(fields.status),
    priority: taskPriorityFromJira(fields.priority),
    labels,
    sortOrder: (index + 1) * 1024,
    creator: reporter,
    assignee,
    dueDate: typeof fields.duedate === "string" ? fields.duedate : null,
    externalUrl: `${config.baseUrl}/browse/${encodeURIComponent(String(issue.key))}`,
    createdAt: typeof fields.created === "string" ? fields.created : new Date().toISOString(),
    updatedAt: typeof fields.updated === "string" ? fields.updated : new Date().toISOString(),
  };
}

function safeConfig(config, lastSyncedAt = null) {
  return config
    ? {
      configured: true,
      baseUrl: config.baseUrl,
      username: null,
      displayName: config.displayName,
      projects: config.projects,
      projectId: JIRA_PROJECT_ID,
      lastSyncedAt,
      insecureHttp: config.baseUrl.startsWith("http:"),
    }
    : {
      configured: false,
      baseUrl: null,
      username: null,
      displayName: null,
      projects: [],
      projectId: JIRA_PROJECT_ID,
      lastSyncedAt: null,
      insecureHttp: false,
    };
}

export function createJiraIntegration({ configStore, database, fetch: fetchImplementation = globalThis.fetch }) {
  let lastSyncedAt = null;
  let pendingSync = null;

  async function request(config, pathname, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(`${config.baseUrl}${pathname}`, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "JIRA_TIMEOUT" : "JIRA_UNAVAILABLE",
        timedOut ? "连接 Jira 超时" : "无法连接 Jira，请检查地址和内网连接",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        401,
        "JIRA_AUTH_FAILED",
        "Jira 登录失败，请检查用户名、密码、Basic Auth 或 CAPTCHA 状态",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(400, "JIRA_REDIRECT", "Jira 地址发生重定向，请填写最终访问地址");
    }
    if (!response.ok) {
      throw new ApiError(
        response.status >= 500 ? 502 : 409,
        "JIRA_REQUEST_FAILED",
        `Jira 请求失败（HTTP ${response.status}）`,
      );
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new ApiError(502, "INVALID_JIRA_RESPONSE", "Jira 返回了无效的 JSON 数据");
    }
  }

  async function fetchAssignedIssues(config) {
    const issues = [];
    let startAt = 0;
    while (true) {
      const page = await request(config, "/rest/api/2/search", {
        method: "POST",
        body: JSON.stringify({
          jql: buildJiraJql(config.projects),
          startAt,
          maxResults: 100,
          fields: JIRA_FIELDS,
        }),
      });
      const pageIssues = Array.isArray(page?.issues) ? page.issues : [];
      issues.push(...pageIssues);
      startAt += pageIssues.length;
      if (pageIssues.length === 0 || startAt >= Number(page?.total ?? 0)) break;
    }
    return issues;
  }

  async function validateConnection(candidate) {
    const myself = await request(candidate, "/rest/api/2/myself");
    const displayName = String(myself?.displayName ?? myself?.name ?? candidate.username).trim();
    const config = { ...candidate, displayName };
    const issues = await fetchAssignedIssues(config);
    return { config, issues };
  }

  async function syncWithConfig(config, { archiveMissing = true } = {}) {
    const issues = await fetchAssignedIssues(config);
    database.ensureJiraProject(`Jira · ${config.displayName}`);
    database.syncJiraTasks(
      issues.map((issue, index) => normalizeIssue(issue, config, index)),
      { archiveMissing },
    );
    lastSyncedAt = new Date().toISOString();
    return safeConfig(config, lastSyncedAt);
  }

  async function sync({ force = false } = {}) {
    const config = await configStore.read();
    if (!config) return safeConfig(null);
    if (!force && lastSyncedAt && Date.now() - new Date(lastSyncedAt).getTime() < SYNC_INTERVAL_MS) {
      return safeConfig(config, lastSyncedAt);
    }
    if (pendingSync) return pendingSync;
    pendingSync = syncWithConfig(config).finally(() => {
      pendingSync = null;
    });
    return pendingSync;
  }

  async function transitionIssue(config, issueKey, targetStatus) {
    const payload = await request(
      config,
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
    );
    const transitions = Array.isArray(payload?.transitions) ? payload.transitions : [];
    const transition = transitions.find((candidate) => taskStatusFromJira(candidate.to) === targetStatus);
    if (!transition) {
      throw new ApiError(
        409,
        "JIRA_TRANSITION_UNAVAILABLE",
        `Jira 当前工作流不能将 ${issueKey} 移到目标状态`,
        {
          availableStatuses: transitions.map((candidate) => ({
            id: String(candidate.id),
            name: String(candidate.name ?? candidate.to?.name ?? ""),
            taskboardStatus: taskStatusFromJira(candidate.to),
          })),
        },
      );
    }
    await request(config, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: String(transition.id) } }),
    });
  }

  async function resolveJiraPriority(config, targetPriority) {
    if (targetPriority === "none") return null;
    const priorities = await request(config, "/rest/api/2/priority");
    const match = Array.isArray(priorities)
      ? priorities.find((priority) => taskPriorityFromJira(priority) === targetPriority)
      : null;
    if (!match) {
      throw new ApiError(
        409,
        "JIRA_PRIORITY_UNAVAILABLE",
        "Jira 中没有可映射到该优先级的选项",
      );
    }
    return { id: String(match.id) };
  }

  return {
    async status() {
      return safeConfig(await configStore.read(), lastSyncedAt);
    },
    async configure(input) {
      const current = await configStore.read();
      const username = input.username || current?.username;
      const password = input.password || current?.password;
      const candidate = configStore.validate({ ...input, username, password });
      if (
        !input.password
        && (
          !current
          || candidate.baseUrl !== current.baseUrl
          || candidate.username !== current.username
        )
      ) {
        throw new ApiError(
          400,
          "JIRA_PASSWORD_REQUIRED",
          "修改 Jira 地址或用户名时必须重新输入密码",
        );
      }
      const { config, issues } = await validateConnection(candidate);
      await configStore.save(config);
      database.ensureJiraProject(`Jira · ${config.displayName}`);
      database.syncJiraTasks(
        issues.map((issue, index) => normalizeIssue(issue, config, index)),
        { archiveMissing: true },
      );
      lastSyncedAt = new Date().toISOString();
      return safeConfig(config, lastSyncedAt);
    },
    sync,
    async updateTask(task, changes) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      if (Object.hasOwn(changes, "status") && changes.status !== task.status) {
        await transitionIssue(config, task.identifier, changes.status);
      }
      const fields = {};
      if (Object.hasOwn(changes, "title") && changes.title !== task.title) fields.summary = changes.title;
      if (Object.hasOwn(changes, "description") && changes.description !== task.description) {
        fields.description = changes.description;
      }
      if (Object.hasOwn(changes, "labels") && JSON.stringify(changes.labels) !== JSON.stringify(task.labels)) {
        fields.labels = changes.labels;
      }
      if (Object.hasOwn(changes, "dueDate") && changes.dueDate !== task.dueDate) {
        fields.duedate = changes.dueDate;
      }
      if (Object.hasOwn(changes, "priority") && changes.priority !== task.priority) {
        fields.priority = await resolveJiraPriority(config, changes.priority);
      }
      if (Object.keys(fields).length > 0) {
        await request(config, `/rest/api/2/issue/${encodeURIComponent(task.identifier)}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
      }
    },
    async moveTask(task, status) {
      if (status === task.status) return;
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      await transitionIssue(config, task.identifier, status);
    },
  };
}
