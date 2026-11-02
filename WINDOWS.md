# Windows 适配说明

上游 `dsh-superagent` 是按 POSIX 写的：路径校验要求 `/` 开头、命令垫片是 `#!/bin/sh`、PATH 用 `:` 分隔、
服务脚本硬依赖 tmux。本 fork 把这几层改成跨平台，Windows 上可以启动并进入 setup 流程。

## 改了什么

| 文件 | 上游问题 | 改法 |
| --- | --- | --- |
| `src/infra/platform.ts`（新增） | 平台差异散落各处 | 集中 `isWindows` / `isBatch` / `launchable` / `posixPath` / `executableNames` / `shellArgv` |
| `src/deployment.ts` | `stateDir` 校验 `/^\//`，Windows 绝对路径被拒 | 改为 `^(?:[A-Za-z]:[\\/]|[\\/])` |
| `src/deployment.ts` | `executable()` 不认 `PATHEXT`，`gh` 找不到 `gh.exe`、`lark-cli` 找不到 `lark-cli.cmd` | 按 `PATHEXT` 逐个后缀尝试 |
| `src/deployment.ts` | `workerProbe` 用 `env VAR=... cmd` 前缀，Windows 没有 `env` | 改走 subprocess 的 `env` 分层参数 |
| `src/policy.ts` | `executor.directory` 要求 `startsWith('/')` | 同上改成盘符或 `/` 开头 |
| `src/infra/environment.ts` | 垫片写 `#!/bin/sh` + `IFS=:` 过滤 PATH | Windows 写 `<name>.cmd`，用 `for` 展开重建 `;` 分隔的 PATH |
| `src/infra/environment.ts` | 垫片标记是 `#` 注释，批处理会报错 | 标记前加 `rem `，识别时剥掉前缀再比对 |
| `src/infra/environment.ts` | git credential helper 路径带反斜杠，`sh` 会当转义 | 统一转正斜杠 |
| `src/infra/environment.ts` | `verifyEnvironment` 把 git 输出的 `file:` 路径和本地拼接路径直接比 | 两侧都转正斜杠后比 |
| `src/infra/commands.ts` | `execFile` 不能直接执行 `.cmd` | 经 `launchable` 走 PowerShell 调用运算符（`cmd /c` 会被 Node 的引号转义破坏） |
| `src/executor/dsh.ts` | 每个 Ticket 的 prepare 命令用 `sh -c` | Windows 改用 `pwsh -NoProfile -NonInteractive -Command` |
| `src/sources/feishu-loops.ts` | 事件消费者直接 `spawn(bot.cli)`，`.cmd` 起不来 | 同样经 `launchable` |
| `src/app/sessions.ts` | 主 Session 的 `tools.restrict` 硬编码 `'bash'`；Windows 上 DSH 只注册 `pwsh`，`restrict` 拒绝未知工具名，**会话创建失败导致 orchestrator 起不来** | 按平台取 shell 工具名 |
| `src/sources/feishu-loops.ts` | `spawn` 默认不隐藏控制台窗口，长驻的飞书事件消费者会在桌面留一个一直开着的窗口 | `windowsHide: true` |
| `src/infra/platform.ts` | 参数里的 JSON 经 `cmd.exe` 重新解析，双引号被吃掉（飞书读历史消息全部报 `--params invalid format`） | 解析包裹脚本，直接调用它转发的真实程序，不走 `cmd` |
| `src/infra/platform.ts` | 绕开包裹脚本会丢掉它 `set` 的环境变量（bot CLI 退回个人配置，`strict mode off`） | 把 `set` 字面量一起提取成环境变量传下去 |
| `src/infra/platform.ts` | 兜底的 shell 包装用 `-Command` 传命令，引号仍会被 Node 转义破坏 | 改用 `-EncodedCommand`（UTF-16LE base64） |
| `scripts/dsh-superagent` | `import fcntl`、`ps`、`os.kill(SIGINT)`、tmux | 全部加 Windows 分支（见下） |

服务脚本的 Windows 分支：

- 进程发现改用 `Get-CimInstance Win32_Process` 读命令行（`pwsh` 优先，回退 `powershell`），按 `--profile` 匹配；
- 文件锁从 `fcntl.flock` 换成 `msvcrt.locking`；
- 启动不再用 tmux，而是把 npm 的 `dsh.cmd` 垫片解析成 `node <entry>.js` 直接拉起，加 `DETACHED_PROCESS`，
  这样日志句柄能被服务继承（走 `cmd /c` 会丢）；
- `status` / `start` / `restart` 的退出码语义（0/1/2/3）与上游一致。

## 已知限制

1. **`stop` 会强杀进程树。** Windows 无法给无控制台的进程投递 SIGINT，`stop` 直接 `taskkill /T /F`，
   正在跑的 Executor Session 会被打断。想保留上游语义（超时报错、不强杀）就加 `--graceful-only`。
2. **`github.cli` 建议指向 `gh.exe`，不要指向 `.cmd` 包装脚本。** 垫片和探测都能跑，但 git 的 credential
   helper 由 Git for Windows 的 `sh` 执行，`sh` 起不了批处理，push 会失败。
3. **服务必须在你自己的终端里启动。** 在 Agent 沙箱里用后台任务启动，shell 退出时进程会被回收，
   表现为「start 成功、下一条命令就没了」。
4. **prepare 命令要写 PowerShell 语法**，原版文档里的 `git -C ... && git ... worktree add` 里 `&&` 在
   PowerShell 7 可用，但 `$DSH_SUPERAGENT_*` 环境变量要用 `$env:DSH_SUPERAGENT_*`。
5. **Feishu 的 `lark-cli` 每调用一次会多一层 PowerShell**（约 200–400 ms），只影响启动和轮询，不影响常驻消费者。

## 跑起来

```powershell
cd D:\code\dsh-superagent
$env:NODE_OPTIONS=''          # WorkBuddy 的 safe-delete shim 会让 pnpm 删目录失败
pnpm install; pnpm build
python scripts\dsh-superagent start
python scripts\dsh-superagent status
```

`start` 会把面板地址（带 token）打进 `.artifacts/dsh-superagent-superagent-*.log`，浏览器打开后左侧侧边栏选 **Superagent**。

profile 配置在 `%USERPROFILE%\.dsh\profiles\superagent\cordis.patch.yml`（`stateDir` 与面板端口 3082）。

剩下的是账号侧的事，不是代码问题：GitHub 源需要一个能推送到目标仓库的 CLI 身份，Feishu 源需要一个
只允许 bot 身份（`strict mode bot`）的 `lark-cli` 配置。
