# SPIKE-1 决定：独立角色project覆写research

用户与Claude中期审查批准（design/reviews/BATCH1_REVIEW.md）。原default_agent/agent参数方案不再采用；原生runtime仍固定research，保留requestID幂等收据，不改OpenScience源码。仅P1-10首PR的五项前置边界及最小实现，整条翻译层尚未交付。

## 目录树

```text
/data/
├── os-config/openscience.json     # 账户启动脚本注册可信全局ReinLab插件；provider由账户配置
├── os-data/                      # 内核持久收据
├── roles/<dossierId>/
│   ├── swarm-reader/             # 非git，只有三个控制面管理文件
│   │   ├── openscience.json      # 覆写research定义
│   │   ├── AGENTS.md             # 调用方已按角色过滤的记忆快照
│   │   └── .role-policy.json     # 工具白名单、写目标、摘要、要求的全局插件URL
│   └── swarm-critic/
│       ├── openscience.json
│       ├── AGENTS.md
│       └── .role-policy.json
└── dossiers/<dossierId>/
    ├── papers/
    └── swarm/own-deliveries/      # 示例write_targets
```

roles在档案之外；role project与所有祖先都不能含.git。输出写档案，role目录不可作为研究产物目录。创建/复用只接受内容一致、单硬链接的普通管理文件，拒绝符号链接、不匹配内容、额外配置或说明文件；所有SDK操作先验证。模型无权写role配置或AGENTS。控制面独占这些管理目录是部署前提，不把同UID恶意宿主进程的任意并发改文件称作已实现OS级沙盒。

## 生成定义样例

下面是展示路径/原生读写权限的精简角色输入生成结果；正式role_def的工具表逐项生成，非额外给种子角色加读写能力。模型名由安全路由配置提供，例子是占位符，不能作为live默认模型。

```json
{
  "default_agent": "research",
  "agent": {
    "research": {
      "description": "ReinLab swarm-critic",
      "mode": "primary",
      "prompt": "使用中文，独立审查证据；危险动作一律拒绝。",
      "model": "account-route/strong-model",
      "steps": 48,
      "permission": {
        "*": "deny",
        "read": {
          "*": "deny",
          "/data/roles/<dossierId>/swarm-critic/AGENTS.md": "allow",
          "/data/dossiers/<dossierId>/*": "allow"
        },
        "edit": {
          "*": "deny",
          "../../../dossiers/<dossierId>/swarm/own-deliveries/*": "ask"
        },
        "external_directory": {
          "*": "deny",
          "/data/dossiers/<dossierId>/*": "allow"
        },
        "task": "deny"
      }
    }
  }
}
```

AGENTS.md只含调用方已过滤的本角色快照；本PR没有实现完整记忆服务或声称已验证全部read_scope语义。两个角色的实际provider HTTP system必须分别包含自己的prompt和快照，不能只依据配置加载判定。

## 原生差异与最小补闸

1. 上游默认*allow，因此生成的最终research规则第一项必须*deny；danger和task始终deny。所有本批角色均禁内置委派，群研/独立审查必须如此；控制面调度尚待后续。
2. 上游默认approve把external_directory视为risky：配置allow不能代替filesystem grant。桥接只给新会话当前档案read、实际原生编辑所需write_targets精确路径write，scope固定session；不设project/installation grant、不切full、不关闭sandbox、不自动批准pending decision。read再按canonical路径收紧，已有宽grant不能绕过。
3. write/edit/patch/apply_patch/multiedit共用edit权限，路径为相对role project；简单write/edit仍由全局插件逐工具核对原tool_grants及canonical写目标，未授权别名不能借edit规则执行。多文件patch等在首PR失败关闭，待完整受控工具实现，不能扩大权限应付测试。
4. **安全插件必须由受控全局配置加载。** sandbox启用时上游跳过project-controlled插件；原生fixture现与已有account-entrypoint一致，全局注册同一插件。role配置不注册project plugin。桥接在创建/提交前通过SDK核验全局插件URL，缺失失败关闭；真实硬链接/先读再强制edit/运行中篡改测试证明hook实际执行，不能拿FileTime前置失败当插件生效证据。
5. 上游配置字符串会展开{file:...}/{env:...}，不走读权限。生成配置全文拒绝这些引用；不从真实环境读取值。roleRoot只有受控文件，拒绝.jsonc/.openscience/.synsc等额外入口。每次模型system.transform与工具执行前再次核对普通文件/单链接/摘要，防止运行中AGENTS被换成其他role的链接。数据read/write/edit也拒绝多硬链接文件和FIFO/socket/device等特殊对象，元数据打开带O_NONBLOCK避免挂死。
6. runtime的显式parts.subtask属于上游用户委派路径，可绕过task的agent检查；本桥接首PR只允许sessionID/requestID/message，额外parts/agent/model/directory等输入直接拒绝。内部开启delegation:true做测试，证明task拒绝来自权限而非总开关。
7. SDK每次请求有截止时间（默认10秒，可配置100～30000毫秒）；超时映射OS_UNAVAILABLE，结果未知时检查原requestID收据，绝不自动重提prompt。requestID始终由调用方提供且原样传递，同内容返回原runID/acceptedAt，异内容409。

## 验证与停止点

T-ROLE-1～5在已安装锁定npm2.0.150进程上执行，测试provider只监听回环，截获实际模型HTTP。fixture不进入live实现/默认配置，不使用真实模型密钥或计费。正向读取/写入、canonical/symlink/hardlink逃逸、已有宽grant、工具别名、task和显式parts、幂等、SDK失联均留独立证据。模型system和tool列表样本位于evidence/P1-10/model-requests.json；红灯/实际测试报告与评审同目录。

本PR通过后停下，等审查方确认，再做其余翻译层。云Fly/Supabase仍待补验；Q-021/025/005按现有推荐继续，未擅自开通环境或虚构路由/汇率/无头脚本已通过。
