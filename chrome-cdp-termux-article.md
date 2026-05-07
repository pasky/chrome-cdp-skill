# 在手机上跑Chrome远程调试？我把不可能变成了可能

> 当AI编码助手遇上Android Termux，一个困扰我两周的问题终于有了答案

## 起因：一个"不可能"的需求

想象一下这个场景：你躺在沙发上，手里只有一台手机，却想继续调试白天没写完的代码。你的AI编码助手需要访问浏览器页面，但所有浏览器自动化工具都说"Android？不支持。"

这就是我两周前的困境。

我用的AI编码工具依赖一个叫 `chrome-cdp` 的精巧工具——它通过Chrome DevTools Protocol直接连接到浏览器，不需要Puppeteer，不需要重装浏览器，甚至不需要重新登录。但它有一个前提：Chrome必须开着远程调试端口。

而问题在于——我在Termux（Android上的终端模拟器）上。没有桌面环境，没有图形界面，连Chrome都得从x11仓库单独安装。

## 踩坑日记：每一步都是血泪

### 坑1：找不到Chromium

```
$ pkg install chromium
E: Unable to locate package chromium
```

一上来就吃闭门羹。搜索半天才发现，Chromium藏在 `x11-repo` 里——一个你根本不会想到要安装的仓库。

```bash
pkg install x11-repo    # 先装仓库
pkg install chromium     # 才能装浏览器
```

### 坑2：Playwright？不存在的

既然有了Chrome，那用Playwright来自动化吧？于是我天真地运行：

```bash
npm install playwright-core
npx playwright-core install chromium
```

结果：

```
Unsupported platform: android
```

Playwright直接拒了。它的底层依赖有平台特定二进制文件，Android不在支持列表里。这条路走不通。

### 坑3：DevToolsActivePort 在哪？

`chrome-cdp` 的工作原理是扫描操作系统各处的 `DevToolsActivePort` 文件来发现Chrome的调试端口。但在Termux上，Chromium根本不生成这个文件。

```
No DevToolsActivePort found.
Enable remote debugging at chrome://inspect/#remote-debugging
```

在手机上访问 `chrome://inspect`？这可是headless模式，根本没有界面。

## 灵光一现：换个思路

既然找不到端口文件，那我直接告诉它端口号不就行了？

Chrome headless模式下启动时，我可以指定 `--remote-debugging-port=9222`，然后通过 `http://127.0.0.1:9222/json/version` 获取WebSocket URL。

但原版 `cdp.mjs` 的 `getWsUrl()` 函数是同步的，只支持读取文件，不支持HTTP发现。源码大概长这样：

```javascript
function getWsUrl() {
  // 扫描 DevToolsActivePort 文件...
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) throw new Error('Not found');
  // 从文件读取端口和路径...
  return `ws://${host}:${lines[0]}${lines[1]}`;
}
```

我需要做三件事：
1. 把 `getWsUrl()` 改成异步函数
2. 添加 `CDP_PORT` 环境变量支持
3. 通过HTTP API自动发现WebSocket URL

## 解决方案：一行环境变量搞定

改动其实不大，但效果显著。新增的fallback逻辑：

```javascript
const cdpPort = process.env.CDP_PORT;
if (cdpPort) {
  const resp = await fetch(`http://${host}:${cdpPort}/json/version`);
  const data = await resp.json();
  if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
}
```

现在在Termux上只需要：

```bash
export CDP_PORT=9222
chromium-browser --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 &
cdp list
```

## 最终效果：手机上的Chrome调试

改动完成后，我在手机上做了个测试——访问GitHub issues页面：

```bash
$ cdp list
9CC23064  Issues · pasky/chrome-cdp-skill · GitHub

$ cdp snap 9CC23064
[RootWebArea] Issues · pasky/chrome-cdp-skill · GitHub
  [link] Skip to content
  [heading] Navigation Menu
  ...
  [list] Search results
    [listitem] Thanks for chrome-cdp-skill #38
    [listitem] mouse drag over canvas #24
    [listitem] Unix socket IPC fails with EPERM... #19
```

成功了。AI编码助手现在可以直接"看"到浏览器页面，理解页面结构，甚至交互操作——全部在手机上完成。

## 技术总结：给同样在Termux上挣扎的你

```
# 安装
pkg install x11-repo chromium nodejs

# 启动Chromium（headless）
chromium-browser \
  --headless \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 &

# 设置环境变量
export CDP_PORT=9222

# 开始使用
cdp list
cdp snap <target>
cdp eval <target> "document.title"
```

### 完整踩坑清单

| 坑 | 解决方案 |
|----|---------|
| Chromium不在默认仓库 | `pkg install x11-repo` 先装x11仓库 |
| Playwright不支持Android | 放弃Playwright，用headless Chromium直连 |
| 没有DevToolsActivePort | 设置 `CDP_PORT=9222` 环境变量 |
| `--no-sandbox` 必须 | Termux不支持用户命名空间 |
| `--disable-gpu` 必须 | Android通常没有可用GPU |

## 开源的意义

这个改动我已经提交到了 `github.com/aresbit/chrome-cdp-skill`。原项目 `chrome-cdp` 本身就是一个精巧的作品——不用Puppeteer，直接通过WebSocket连接Chrome，每个标签页有独立的持久化守护进程，解决了同类工具的所有痛点。

而我做的只是在它优雅的设计基础上，加了一小块拼图：让 `CDP_PORT` 环境变量成为fallback发现机制。这样无论是Termux用户，还是手动启动Chrome的开发者，都能轻松使用。

这次经历让我更加确信：好的开源项目就像乐高，每个人都可以贡献一块属于自己的积木。

---

*如果你也在Termux上折腾过什么有意思的配置，欢迎评论区分享你的踩坑故事 👇*
