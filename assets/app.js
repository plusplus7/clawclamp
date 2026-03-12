const API_BASE = "/plugins/clawclamp/api";

const qs = (id) => document.getElementById(id);

const modeEl = qs("mode");
const modeNoteEl = qs("mode-note");
const enforceBtn = qs("mode-enforce");
const grayBtn = qs("mode-gray");
const refreshBtn = qs("refresh");
const grantForm = qs("grant-form");
const grantToolInput = qs("grant-tool");
const grantTtlInput = qs("grant-ttl");
const grantNoteInput = qs("grant-note");
const grantHint = qs("grant-hint");
const grantsEl = qs("grants");
const auditEl = qs("audit");
const auditPageSizeEl = qs("audit-page-size");
const auditPrevEl = qs("audit-prev");
const auditNextEl = qs("audit-next");
const auditPageInfoEl = qs("audit-page-info");
const policyListEl = qs("policy-list");
const policyIdInput = qs("policy-id");
const policyContentInput = qs("policy-content");
const policyCreateBtn = qs("policy-create");
const policyUpdateBtn = qs("policy-update");
const policyDeleteBtn = qs("policy-delete");
const policyStatusEl = qs("policy-status");
let policyReadOnly = false;
let policies = [];
let auditPage = 1;
let auditPageSize = Number(auditPageSizeEl?.value || 50);
let auditTotal = 0;

async function fetchJson(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload.error || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload;
}

function showAlert(message) {
  window.alert(message);
}

function assertOperationOk(payload, fallbackMessage) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, "ok") && payload.ok === false) {
    throw new Error(fallbackMessage);
  }
  return payload;
}

async function runAction(action, successMessage, failurePrefix) {
  try {
    const result = await action();
    if (successMessage) {
      showAlert(successMessage);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showAlert(`${failurePrefix}${message}`);
    throw error;
  }
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return date.toLocaleTimeString();
}

function renderMode(state) {
  modeEl.textContent = state.mode === "gray" ? "灰度" : "强制";
  modeNoteEl.textContent =
    state.mode === "gray"
      ? "被拒绝的工具调用仍会执行，但会标记为灰度放行。"
      : "被拒绝的工具调用将被阻断。";
  enforceBtn.disabled = state.mode === "enforce";
  grayBtn.disabled = state.mode === "gray";
  grantHint.textContent =
    `默认 TTL ${state.grants.defaultTtlSeconds}s，最长 ${state.grants.maxTtlSeconds}s。`;
}

function renderGrants(grants) {
  if (!grants.length) {
    grantsEl.innerHTML = "<div class=\"note\">暂无有效授权。</div>";
    return;
  }
  grantsEl.innerHTML = "";
  grants.forEach((grant) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <div>
        <strong>${grant.toolName}</strong><br />
        <span class="note">到期时间 ${new Date(grant.expiresAt).toLocaleString()}</span>
      </div>
      <button class="btn ghost" data-id="${grant.id}">撤销</button>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      try {
        await runAction(async () => {
          const result = await fetchJson(`${API_BASE}/grants/${encodeURIComponent(grant.id)}`, {
            method: "DELETE",
          });
          assertOperationOk(result, "撤销授权失败");
          await refreshAll();
        }, "已撤销短期授权。", "撤销短期授权失败：");
      } catch {}
    });
    grantsEl.appendChild(item);
  });
}

function decisionBadge(decision) {
  if (decision === "allow_grayed") return "gray";
  if (decision === "deny") return "deny";
  return "allow";
}

function decisionLabel(decision) {
  if (decision === "allow_grayed") return "灰度放行";
  if (decision === "deny") return "拒绝";
  if (decision === "error") return "错误";
  return "允许";
}

function riskLabel(risk) {
  if (risk === "low") return "低";
  if (risk === "medium") return "中";
  if (risk === "high") return "高";
  return risk || "-";
}

function renderAudit(entries) {
  if (!entries.length) {
    auditEl.innerHTML = "<div class=\"note\">暂无审计记录。</div>";
    return;
  }

  const header = document.createElement("div");
  header.className = "table-row header";
  header.innerHTML =
    "<div>时间</div><div>工具</div><div>决策</div><div>风险</div><div>说明</div><div>操作</div>";

  auditEl.innerHTML = "";
  auditEl.appendChild(header);

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "table-row";
    const badgeClass = decisionBadge(entry.decision);
    const canAllow = entry.decision === "deny" || entry.decision === "allow_grayed";
    const canDeny = entry.decision === "allow";
    const paramsText =
      entry.params && typeof entry.params === "object"
        ? JSON.stringify(entry.params, null, 2)
        : entry.params || "";
    const meta = [
      entry.toolCallId ? `toolCallId: ${entry.toolCallId}` : null,
      entry.runId ? `runId: ${entry.runId}` : null,
      entry.sessionKey ? `sessionKey: ${entry.sessionKey}` : null,
      entry.agentId ? `agentId: ${entry.agentId}` : null,
    ].filter(Boolean);
    row.innerHTML = `
      <div>${formatTime(entry.timestamp)}</div>
      <div class="mono">${entry.toolName}</div>
      <div class="badge ${badgeClass}">${decisionLabel(entry.decision)}</div>
      <div>${riskLabel(entry.risk)}</div>
      <div>${entry.reason || entry.error || ""}</div>
      <div class="actions">
        ${canAllow ? "<button class=\"btn mini\" data-action=\"allow\">一键允许</button>" : ""}
        ${canDeny ? "<button class=\"btn mini warn\" data-action=\"deny\">一键拒绝</button>" : ""}
      </div>
      <div class="audit-detail">
        <div class="audit-meta">${meta.join(" · ")}</div>
        ${paramsText ? `<pre>${paramsText}</pre>` : ""}
      </div>
    `;
    const allowBtn = row.querySelector("button[data-action=\"allow\"]");
    if (allowBtn) {
      allowBtn.addEventListener("click", async () => {
        try {
          await runAction(async () => {
            await applyPolicyChange("permit", entry.toolName);
            await refreshAll();
          }, "已添加允许策略。", "添加允许策略失败：");
        } catch {}
      });
    }
    const denyBtn = row.querySelector("button[data-action=\"deny\"]");
    if (denyBtn) {
      denyBtn.addEventListener("click", async () => {
        try {
          await runAction(async () => {
            await applyPolicyChange("forbid", entry.toolName);
            await refreshAll();
          }, "已添加拒绝策略。", "添加拒绝策略失败：");
        } catch {}
      });
    }
    auditEl.appendChild(row);
  });
}

function renderAuditPager(total, page, pageSize) {
  auditTotal = total || 0;
  auditPage = page || 1;
  const totalPages = Math.max(1, Math.ceil(auditTotal / pageSize));
  auditPageInfoEl.textContent = `第 ${auditPage} / ${totalPages} 页 · 共 ${auditTotal} 条`;
  auditPrevEl.disabled = auditPage <= 1;
  auditNextEl.disabled = auditPage >= totalPages;
}

function renderPolicyList(list) {
  policies = list;
  if (!list.length) {
    policyListEl.innerHTML = "<div class=\"note\">暂无策略。</div>";
    return;
  }
  policyListEl.innerHTML = "";
  list.forEach((policy) => {
    const item = document.createElement("button");
    item.className = "policy-item";
    item.textContent = policy.id;
    item.addEventListener("click", () => {
      policyIdInput.value = policy.id;
      policyContentInput.value = policy.content || "";
      policyStatusEl.textContent = "";
    });
    policyListEl.appendChild(item);
  });
}

async function refreshPolicies() {
  const result = await fetchJson(`${API_BASE}/policies`);
  policyReadOnly = result.readOnly === true;
  renderPolicyList(result.policies || []);
  policyCreateBtn.disabled = policyReadOnly;
  policyUpdateBtn.disabled = policyReadOnly;
  policyDeleteBtn.disabled = policyReadOnly;
  if (policyReadOnly) {
    policyStatusEl.textContent = "policyStoreUri 模式下为只读。";
  }
}

async function refreshAll() {
  const state = await fetchJson(`${API_BASE}/state`);
  renderMode(state);
  const grants = await fetchJson(`${API_BASE}/grants`);
  renderGrants(grants.grants || []);
  const logs = await fetchJson(`${API_BASE}/logs?page=${auditPage}&pageSize=${auditPageSize}`);
  renderAudit(logs.entries || []);
  renderAuditPager(logs.total || 0, logs.page || auditPage, logs.pageSize || auditPageSize);
  await refreshPolicies();
}

refreshBtn.addEventListener("click", () => {
  refreshAll();
});

enforceBtn.addEventListener("click", async () => {
  try {
    await runAction(async () => {
      await fetchJson(`${API_BASE}/mode`, {
        method: "POST",
        body: JSON.stringify({ mode: "enforce" }),
      });
      await refreshAll();
    }, "已切换到强制模式。", "切换模式失败：");
  } catch {}
});

grayBtn.addEventListener("click", async () => {
  try {
    await runAction(async () => {
      await fetchJson(`${API_BASE}/mode`, {
        method: "POST",
        body: JSON.stringify({ mode: "gray" }),
      });
      await refreshAll();
    }, "已切换到灰度模式。", "切换模式失败：");
  } catch {}
});

grantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const toolName = grantToolInput.value.trim();
  const ttlSeconds = grantTtlInput.value ? Number(grantTtlInput.value) : undefined;
  const note = grantNoteInput.value.trim();
  try {
    await runAction(async () => {
      await fetchJson(`${API_BASE}/grants`, {
        method: "POST",
        body: JSON.stringify({ toolName, ttlSeconds, note: note || undefined }),
      });
      grantToolInput.value = "";
      grantTtlInput.value = "";
      grantNoteInput.value = "";
      await refreshAll();
    }, "已创建短期授权。", "创建短期授权失败：");
  } catch {}
});

auditPageSizeEl.addEventListener("change", async () => {
  auditPageSize = Number(auditPageSizeEl.value || 50);
  auditPage = 1;
  await refreshAll();
});

auditPrevEl.addEventListener("click", async () => {
  if (auditPage <= 1) return;
  auditPage -= 1;
  await refreshAll();
});

auditNextEl.addEventListener("click", async () => {
  const totalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  if (auditPage >= totalPages) return;
  auditPage += 1;
  await refreshAll();
});

refreshAll();
setInterval(refreshAll, 10_000);

function sanitizeIdPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 64);
}

function policyIdPrefix(effect, toolName) {
  return `ui-${effect}:${sanitizeIdPart(toolName)}:`;
}

function policyBody(effect, toolName) {
  const keyword = effect === "forbid" ? "forbid" : "permit";
  return `${keyword}(principal, action, resource)\nwhen {\n  action == Action::\"Invoke\" && resource.name == \"${toolName}\"\n};`;
}

async function removePoliciesByPrefix(prefix) {
  const targets = policies.filter((policy) => policy.id.startsWith(prefix));
  for (const policy of targets) {
    const result = await fetchJson(`${API_BASE}/policies/${encodeURIComponent(policy.id)}`, {
      method: "DELETE",
    });
    assertOperationOk(result, `删除策略失败: ${policy.id}`);
  }
}

async function applyPolicyChange(effect, toolName) {
  const opposite = effect === "permit" ? "forbid" : "permit";
  await removePoliciesByPrefix(policyIdPrefix(opposite, toolName));
  const id = `${policyIdPrefix(effect, toolName)}${Date.now()}`;
  const content = policyBody(effect, toolName);
  await fetchJson(`${API_BASE}/policies`, {
    method: "POST",
    body: JSON.stringify({ id, content }),
  });
}

policyCreateBtn.addEventListener("click", async () => {
  const id = policyIdInput.value.trim();
  const content = policyContentInput.value.trim();
  if (!content) {
    policyStatusEl.textContent = "请输入 Policy 内容。";
    return;
  }
  const body = { content, ...(id ? { id } : {}) };
  try {
    await runAction(async () => {
      await fetchJson(`${API_BASE}/policies`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      policyStatusEl.textContent = "已新增策略。";
      await refreshAll();
    }, "已新增策略。", "新增策略失败：");
  } catch {}
});

policyUpdateBtn.addEventListener("click", async () => {
  const id = policyIdInput.value.trim();
  const content = policyContentInput.value.trim();
  if (!id) {
    policyStatusEl.textContent = "请选择或填写 Policy ID。";
    return;
  }
  if (!content) {
    policyStatusEl.textContent = "请输入 Policy 内容。";
    return;
  }
  try {
    await runAction(async () => {
      await fetchJson(`${API_BASE}/policies/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      policyStatusEl.textContent = "已保存策略。";
      await refreshAll();
    }, "已保存策略。", "保存策略失败：");
  } catch {}
});

policyDeleteBtn.addEventListener("click", async () => {
  const id = policyIdInput.value.trim();
  if (!id) {
    policyStatusEl.textContent = "请选择或填写 Policy ID。";
    return;
  }
  try {
    await runAction(async () => {
      const result = await fetchJson(`${API_BASE}/policies/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      assertOperationOk(result, "删除策略失败");
      policyStatusEl.textContent = "已删除策略。";
      policyIdInput.value = "";
      policyContentInput.value = "";
      await refreshAll();
    }, "已删除策略。", "删除策略失败：");
  } catch {}
});
