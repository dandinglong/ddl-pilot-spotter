# ddl-pilot-spotter

## 1. 项目作用和说明

`ddl-pilot-spotter` 是一个基于 Playwright 的增强型 MCP 服务端，主要用于给 AI 智能体提供浏览器自动化能力，并支持对一段浏览器操作过程进行录制。

这个项目当前有两类核心能力：

- 透传常用浏览器 MCP 工具，例如打开网页、点击、输入、截图、获取页面快照、查看网络请求和控制台日志等
- 提供录制能力，通过 `browser_recording_start` 和 `browser_recording_stop` 将某一段操作保存为落盘产物，便于后续分析

录制完成后，默认会在输出目录下生成对应的记录文件，包含页面前后状态、页面快照、HAR 文件、资源清单和动作元数据。

## 2. 安装

### 环境要求

- Node.js 18 及以上版本
- 本机需要有可用的 Chromium、Chrome 或 Edge 浏览器
- 本项目依赖 `playwright-core`


### 方式一：全局安装

```bash
npm install -g ddl-pilot-spotter
```

### 方式二：本地源码安装

```bash
npm install
npm install -g .
```

## 3. 使用

### 启动 MCP 服务

项目通过标准输入输出启动 MCP 服务：

```bash
spotter mcp
```

查看帮助：

```bash
spotter mcp --help
```

### 带参数启动

例如使用本机 Chrome、关闭无头模式并指定浏览器用户目录：

```bash
spotter mcp --headless false --executable-path "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir "D:\workspace\chrome_profiles\spotter"
```

### 典型调用流程

下面是一组典型的 JSON-RPC 调用流程，依次完成握手、初始化通知、获取工具列表和打开知乎。

```text
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-probe","version":"1.0.0"}}}
```

作用：与 MCP 服务端建立连接，并声明客户端协议版本和基本信息。

```text
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
```

作用：通知服务端，客户端初始化流程已经完成，可以开始正式调用工具。

```text
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

作用：获取当前服务端暴露出来的工具列表，确认支持哪些浏览器操作能力。

```text
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://www.zhihu.com"}}}
```

作用：调用 `browser_navigate` 工具，打开知乎首页。

### 录制操作示例

如果需要录制一段操作，推荐按下面的顺序调用：

1. `browser_recording_start`
2. 执行点击、输入、等待、截图等操作
3. `browser_recording_stop`

示例：

```text
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_recording_start","arguments":{"name":"登录流程"}}}
```

作用：开始录制，给本次录制指定一个名称，便于后续识别。

```text
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_click","arguments":{"ref":"login-button","element":"登录按钮"}}}
```

作用：执行一次页面点击操作，这一段操作会被录制过程捕获。

```text
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"browser_recording_stop","arguments":{}}}
```

作用：结束录制并落盘保存录制结果。

### 在 Codex 中配置

例如可以在 Codex 的配置文件中加入下面这段：

```toml
[mcp_servers.spotter]
command = "spotter"
args = ["mcp", "--headless", "false", "--executable-path", 'C:\Program Files\Google\Chrome\Application\chrome.exe', "--user-data-dir", 'D:\workspace\chrome_profiles\spotter', "--output-dir", 'D:\workspace\chrome_profiles\records']
```

## 4. 参数和参数示例

### 启动参数

#### `--output-dir DIR`

录制结果输出目录，默认值：

```text
~/.spotter/records
```

示例：

```bash
spotter mcp --output-dir "D:\workspace\chrome_profiles\records"
```

#### `--executable-path PATH`

指定浏览器可执行文件路径，例如谷歌浏览器。

示例：

```bash
spotter mcp --executable-path "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

#### `--user-data-dir DIR`

指定浏览器用户数据目录。需要复用登录状态或使用固定浏览器用户目录时很有用。

示例：

```bash
spotter mcp --user-data-dir "D:\workspace\chrome_profiles\spotter"
```

#### `--headless true|false`

是否以无头模式启动浏览器，默认是 `true`。

示例：

```bash
spotter mcp --headless false
```

### 环境变量

下面这些环境变量可以覆盖对应的启动参数：

- `PLAYWRIGHT_MCP_OUTPUT_DIR`
- `PLAYWRIGHT_MCP_EXECUTABLE_PATH`
- `PLAYWRIGHT_MCP_USER_DATA_DIR`
- `PLAYWRIGHT_MCP_HEADLESS`

兼容别名：

- `SPOTTER_BROWSER_PATH`
- `SPOTTER_HEADLESS`

示例：

```bash
set PLAYWRIGHT_MCP_HEADLESS=false
set PLAYWRIGHT_MCP_USER_DATA_DIR=D:\workspace\chrome_profiles\spotter
spotter mcp
```

### 多个进程使用相同 `--user-data-dir` 的场景说明

如果多个 `spotter` 进程使用同一个 `--user-data-dir`，当前实现只允许其中一个进程真正占用这个目录。

原因是这个目录对应的是持久化浏览器用户目录，里面会保存登录状态、Cookie、本地存储以及浏览器锁文件。为了避免多个进程同时读写同一份浏览器数据，`spotter` 会在该目录下写入自己的占用信息，并持续刷新心跳。后启动的另一个 `spotter` 进程如果发现这个目录已经被存活中的进程占用，就会报错，不能继续接管。

可以简单理解为：

- 同一个 `--user-data-dir`，同一时间只建议对应一个 `spotter` 进程
- 如果你需要并行跑多个 `spotter`，应当为每个进程分配不同的 `--user-data-dir`
- 如果上一个进程已经异常退出，新的进程会尝试清理过期占用信息和残留锁文件，然后重新启动

### 进程启动后与 Playwright 的调用关系

`spotter mcp` 启动后，本身先是一个 MCP 服务进程，负责接收客户端发来的 JSON-RPC 请求。

在真正收到浏览器相关工具调用之前，`spotter` 不一定会立刻启动浏览器。第一次收到诸如 `browser_navigate`、`browser_click` 这类工具调用时，服务内部才会创建浏览器运行时，并通过 Playwright 启动浏览器。

调用关系大致如下：

1. 客户端启动 `spotter mcp`
2. `spotter` 作为 MCP 服务进程等待请求
3. 收到第一个浏览器工具调用后，`spotter` 内部创建 Playwright 运行时
4. 如果传了 `--user-data-dir`，则使用持久化用户目录方式启动浏览器
5. 后续所有 MCP 工具调用，再转成对应的 Playwright 页面操作

也就是说，客户端并不是直接调用 Playwright，而是先调用 `spotter` 暴露出来的 MCP 工具，再由 `spotter` 统一转发给 Playwright 执行。

## 5. 免责申明

本项目是一个开源软件，仅供学习和研究目的使用。使用者在使用本软件时，必须遵守所在国家/地区的所有相关法律法规。

项目作者及贡献者明确声明：

- 本项目仅用于技术学习和研究目的，不得用于任何违法或不道德的活动。
- 使用者对本软件的使用行为承担全部责任，包括但不限于任何修改、分发或商业应用。
- 项目作者及贡献者不对因使用本软件而导致的任何直接、间接、附带或特殊的损害或损失承担责任，即使已被告知可能发生此类损害。
- 如果您的使用行为违反了所在司法管辖区的法律，请立即停止使用并删除本软件。
- 本项目按“现状”提供，不提供任何形式的担保，包括但不限于适销性、特定用途适用性和非侵权性担保。
项目作者保留随时更改本免责声明的权利，恕不另行通知。使用本软件即表示您同意受本免责声明条款的约束。
