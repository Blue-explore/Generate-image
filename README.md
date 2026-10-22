# dsh-tool-image-ark

给 **DeepSeek Harness（DSH）** 的 `generate_image` 工具：模型按需调用，走火山方舟（Ark）的
`doubao-seedream` 出图，返回可直接展示的图片 URL。

已在两个运行时上验证：CLI `@deepseek-ai/dsh 0.2.0-rc.2`、桌面版 `DeepSeek Harness`（内置
`dsh 0.2.1-rc.2`）。装完 `dsh.profile.bundles` 会选中它，`--dump-config` 出现 `tool-image-ark` 行，
`generate_image` 用真实 `dsh-tools` 注册并执行通过。

## 它是一个 DSH bundle

`package.json` 里这段声明决定了它能不能被 DSH 激活：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

没有它，`dsh plugin add` 只会把包装进 `node_modules`，激活不了任何东西（安装时会打印
`declares no dsh.bundle — installed as a plain dependency`）。

`cordis.patch.yml` 是一层 patch，在 **profile 根层** insert 一条插件行：

```yaml
- insert:
    - id: tool-image-ark
      name: dsh-tool-image-ark
```

这里故意不写 `config`：模型、超时都有代码默认值。原因是 DSH 对同 id 的 patch 是**整个 config 替换**
而不是深合并——你自己那份 patch 里只填 `apiKey` 时，不会顺手把 `model` 抹掉。

之所以插在根层而不是 agent preset 里：`ctx.tools.register` 在根上下文注册的是**全局工具**
（源码注释：*"Register globally or in the calling agent scope. Scoped tools shadow globals."*），
所有 agent 都能看到，不需要改任何 preset。

`@deepseek-ai/dsh-tools` 声明为 **peerDependency**：linked 包请求宿主包时，DSH 的
`routeLinked` 会按 peer 声明做拦截路由，指到宿主自己那份 `dsh-tools`。所以别把它写进
`dependencies`（npm 上最新只有 `0.0.1-rc.1`，和运行时对不上）。

版本范围写 `"^0.2.0-rc.2"` 而不是钉死 `0.2.0-rc.2`：DSH 安装时会用
`semver.satisfies(runtimeVersion, peerRange, { includePrerelease: true })` 逐个校验
`@deepseek-ai/dsh*` peer，钉死一个精确版本的话，桌面版升级到 `0.2.1-rc.2` 就会被判定
**不兼容并拒绝安装**。`^0.2.0-rc.2` 覆盖整个 `0.2.x`（含 rc），挡住 `0.3` 这种可能破坏
`defineTool` 接口的大版本。

## 安装

### A. 桌面版（DeepSeek Harness App）

在 App 的「插件 → 安装」里选这个目录（或点报错弹窗里的「重试」）。App 会把包装进
`~/.dsh/profiles/desktop`，并在 `dsh.profile.bundles` 里勾上。

然后**给插件配 key**（桌面版从 Finder 启动，拿不到你 shell 里的 `ARK_API_KEY`）：

```bash
cd /Users/bule/learn/workbuddy_test/dsh-tool-image-ark
node set-key.mjs desktop 你的方舟key
```

它只改 `~/.dsh/profiles/desktop/cordis.patch.yml` 里属于本插件那一行（自动备份、权限 600、
可重复执行）。改完**完全退出 App 再打开**。

### B. CLI

```bash
cd /Users/bule/learn/workbuddy_test/dsh-tool-image-ark
export ARK_API_KEY=你的方舟key        # GUI 场景才需要 set-key.mjs
DSH=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh
$DSH plugin --profile web add "$PWD"   # profile 名：web / desktop / headless
```

或 `./install.sh web`（等价，装完自检 bundle 是否被选中、patch 行是否生效）。

装完重启对应 profile，然后说「画一只在雪地里的柴犬」。

卸载：

```bash
dsh plugin --profile web remove dsh-tool-image-ark
```

## 配置

工具行的 `config`（同名环境变量也可）：

| 字段 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `apiKey` | `ARK_API_KEY` | — | 必填，方舟 API Key |
| `model` | `ARK_IMAGE_MODEL` | `doubao-seedream-4-5-251128` | 图片模型 ID |
| `baseUrl` | `ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | 区域 / 网关 |
| `watermark` | `IMAGE_WATERMARK` | `false` | 方舟默认会打水印，这里默认关 |
| `timeoutMs` | `HTTP_TIMEOUT_MS` | `120000` | 单次请求超时 |
| `maxRetries` | `HTTP_MAX_RETRIES` | `2` | 仅 429 / 5xx / 超时重试 |

想只给某个 preset 用，不要在 bundle patch 里插根行，改成在 preset 行上关掉全局工具并局部注册
（`ctx.tools.restrict`）——当前版本先按全局工具交付。

## 工具行为

`generate_image(prompt, size?, count?, output_format?, watermark?, reference_image_urls?)`

- `prompt` 必填，模型负责把用户口语翻译成具体描述（主体 / 风格 / 构图 / 光线 / 画幅）。
- `size` 走 `1K` / `2K` / `4K` 档位或 `WxH`；`count` 1–4，是**并发多次独立生成**，不是组图。
- 返回 `{ images: [{ url, size }], model }`；URL 是方舟临时地址，24 小时内有效，需要长期保存请自行下载。
- 部分失败返回 `warnings`；全失败抛错并透传方舟 `error.code`（`InvalidParameter`、
  `AuthenticationError` 等），模型据此决定改参数还是提示你查 key。

## 排错

| 现象 | 原因 |
| --- | --- |
| 安装时提示 `declares no dsh.bundle` | `package.json` 缺 `dsh.bundle.patch`，或 `files` 没包含 `cordis.patch.yml` |
| 安装报 `is incompatible with dsh 0.2.x` / `installation rejected` | peer 范围没覆盖当前运行时版本，见上文 `^0.2.0-rc.2` 的说明；改范围并把 `version` 加一后重装 |
| 装完模型看不到工具 | `--dump-config` 里没有 `tool-image-ark` 行 → bundle 没被选中；完全重启一次进程 |
| 启动日志 `Cannot find package '@deepseek-ai/dsh-tools'` | 该包被写进了 `dependencies` 而不是 `peerDependencies`（要走宿主路由） |
| 调用返回 `missing_ark_api_key` | GUI 里没配 key：跑 `node set-key.mjs desktop 你的key`，或 CLI 里 `export ARK_API_KEY` |
| 调用返回 `AuthenticationError` | key 不对，或账号没开通该图片模型 |
| 调用返回 `InvalidParameter` | `size` 超了总像素上下限，换 `2K` 或明确的 `1024x1024` |
