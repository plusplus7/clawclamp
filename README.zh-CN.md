# Clawclamp

[English README](./README.md)

![npm scope](https://img.shields.io/badge/npm-%40plusplus7%2Fclawclamp-cb3837)
![cedar](https://img.shields.io/badge/auth-Cedar-0b7285)
![ui](https://img.shields.io/badge/UI-audit%20%26%20policy%20lab-1f6feb)
![vibe coding](https://img.shields.io/badge/vibe%20coding-AI%20generated-7c3aed)

Clawclamp 是一个为 OpenClaw 提供 Cedar 权限控制的插件。它会在每次工具调用前执行 Cedar 鉴权，记录允许/拒绝审计日志，并提供一个网关 UI 用于查看日志、维护 Cedar policy 和发放短期授权。

这个仓库属于 vibe coding 项目，主要实现内容由 AI 辅助生成。

默认情况下，Clawclamp 会以 `gray` 模式启动，避免用户刚安装插件后就把所有工具都拦住。团队可以先观察策略命中情况，再切到 `enforce`。

## 截图

准备发布到 GitHub 时，建议把截图放到 `screenshots/` 目录，并在这里引用。

- 建议文件名：`screenshots/policy-lab.png`、`screenshots/audit-log.png`
- 建议展示内容：策略编辑器、审计日志表格、模式切换和短期授权区域

## 功能

- 基于 `before_tool_call` 的 Cedar 鉴权
- 基于 Cedar policy 的长期授权控制
- 基于带过期时间的 Cedar policy 的短期授权
- 审计 UI，可查看允许、拒绝和灰度放行的工具调用
- 灰度模式：即使被 Cedar 拒绝，调用也可继续执行，但会被审计记录

## 安装

通过 npm 安装：

```bash
openclaw plugins install @plusplus7/clawclamp
```

如果通过配置或插件管理安装，包名使用 `@plusplus7/clawclamp`。

## GitHub 展示文案

建议仓库描述：

> OpenClaw 的 Cedar 权限控制与审计插件，一个 vibe coding / AI 辅助生成项目。

建议 topics：

`openclaw`、`cedar`、`authorization`、`audit`、`plugin`、`ai-generated`、`vibe-coding`

## 配置

在 `plugins.entries.clawclamp.config` 下配置：

```yaml
plugins:
  entries:
    clawclamp:
      enabled: true
      config:
        mode: gray
        principalId: openclaw
        policyStoreUri: file:///path/to/policy-store.json
        policyFailOpen: false
        # 可选：UI 访问令牌（非 loopback 时可通过 ?token= 或 X-OpenClaw-Token 访问）
        # uiToken: "your-ui-token"
        risk:
          default: high
          overrides:
            read: low
            web_search: medium
            exec: high
        grants:
          defaultTtlSeconds: 900
          maxTtlSeconds: 3600
        audit:
          maxEntries: 500
          includeParams: true
```

`policyStoreUri` 指向一个 Cedar policy store JSON（`file://` 或 `https://`）。也可以使用 `policyStoreLocal` 直接传入原始 JSON 字符串。如果不配置，插件会使用内置的默认 policy store。默认情况下不会自动放行任何工具，只有显式 permit policy 或短期授权 policy 才能放行；但插件启动模式默认是 `gray`，因此新安装时会先以灰度方式观察，而不是直接强制拦截。

## UI

打开网关路径 `/plugins/clawclamp`，可以查看审计日志、切换模式、创建短期授权，以及增删改查 Cedar policy。

UI 访问规则：

- 来自 loopback（`127.0.0.1` / `::1`）的请求默认允许访问
- 非 loopback 请求需要通过 `?token=`、`X-OpenClaw-Token` 或 `Authorization: Bearer` 提供令牌

策略管理说明：

- UI 内置 Cedar policy 面板，支持 CRUD
- 如果配置了 `policyStoreUri`，策略将变为只读
- 默认 policy 集为空，因此默认拒绝所有工具调用，除非你手动添加 permit policy 或创建短期授权
