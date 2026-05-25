# 静态资源打包

本项目所有前端代码都在一个 `src/static/index.html` 里（大概 200KB+，含完整 SPA + Tailwind + Clash YAML 编译器）。我们没有用 R2、没有用 CF Pages，而是**把 HTML 当字符串打进 Worker bundle**。

## 为什么

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **打进 bundle（本项目）** | 部署一条命令，无外部依赖 | bundle 体积变大 |
| Cloudflare Pages | 适合多页面应用 | 多了一套部署流程 |
| R2 + 自定义路由 | 易于动态更新 | 多一次跨服务调用 |

我们的页面是单文件、改动跟着 worker 代码走、体积不大（gzip < 50 KB），打进 bundle 最省事。

## 实现

### 1. wrangler 规则

```toml
# wrangler.toml
rules = [
  { type = "Text", globs = ["**/*.html"], fallthrough = true }
]
```

`type: "Text"` 让 wrangler 在打包时把匹配 glob 的文件读成字符串。

可用的 `type`：

| type | 导入后是什么 | 适用 |
| --- | --- | --- |
| `Text` | `string` | HTML / CSS / 模板 |
| `Data` | `ArrayBuffer` | 二进制 / 图片 |
| `CompiledWasm` | `WebAssembly.Module` | WASM |

`fallthrough: true` 意思是其他匹配规则可以继续匹配（这里只是兜底，没影响）。

### 2. 代码 import

```js
// src/index.js
import indexHtml from './static/index.html';
```

构建时 esbuild 看到 `.html` 后缀，对照 rules 把整个文件内容塞进 `indexHtml` 这个字符串变量。

### 3. 返回响应

```js
function htmlResponse() {
    return new Response(indexHtml, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
        },
    });
}
```

直接把字符串 wrap 成 Response 返回。`no-cache` 是因为页面里有动态注入逻辑，我们希望浏览器每次都拉最新版（其实 Worker 自身已经在边缘缓存，影响小）。

## bundle 大小关注

Workers 免费版 Worker 上限 **1 MB 压缩后**，付费版 10 MB。

查看当前大小：

```bash
npm run deploy
# 输出:
# Total Upload: 65.32 KiB / gzip: 14.21 KiB
```

如果 html 涨到几百 KB 压不下来，考虑：

1. 把第三方 CSS/JS（Tailwind、字体）改成 CDN 引用，不打进 bundle。
2. 拆出 R2 / Pages 单独托管前端，Worker 只做 API。
3. 删除 dev-only 注释。

## 引入其他静态文件

如果要打包多种类型：

```toml
rules = [
  { type = "Text", globs = ["**/*.html", "**/*.css", "**/*.svg"] },
  { type = "Data", globs = ["**/*.png", "**/*.ico"] }
]
```

```js
import css from './style.css';                  // string
import logo from './logo.png';                  // ArrayBuffer

new Response(logo, { headers: { 'Content-Type': 'image/png' } });
```

## 多文件路由模式

如果有 2-3 个 HTML 页面，可以这样做：

```js
import indexHtml from './static/index.html';
import loginHtml from './static/login.html';

const STATIC = {
    '/': indexHtml,
    '/login': loginHtml,
};

if (STATIC[path]) {
    return new Response(STATIC[path], { headers: { 'Content-Type': 'text/html' } });
}
```

文件再多时建议改用 Cloudflare Pages（Pages 本身就是为多文件优化的）。

## 与 Pages 的取舍

| 维度 | Workers 内嵌 | Cloudflare Pages |
| --- | --- | --- |
| 部署单元 | 一份代码 | 静态文件 + Functions 分离 |
| 开发体验 | 一个 `wrangler dev` | Pages dev + Workers dev 两套 |
| 适合场景 | 小型 SPA + API | 多页面、Jamstack、Next.js |
| 路由灵活度 | 完全自定义 | 文件系统路由（带 Functions） |

本项目核心是 API + 单 SPA，Workers 内嵌方案最省心。等前端复杂到值得拆出来再迁。

## 官方文档

- Module rules：https://developers.cloudflare.com/workers/wrangler/configuration/#bundling
- Cloudflare Pages：https://developers.cloudflare.com/pages/
- Pages vs Workers：https://developers.cloudflare.com/pages/functions/
