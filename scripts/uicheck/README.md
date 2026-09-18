# 界面体检：两把尺子

都要一个**跑着的实例**和一个开了远程调试的 Chrome。它们不进 CI
（需要浏览器与数据），但每次动了排版或文案之后值得跑一遍——
这两条都是靠肉眼看不出来的。

```bash
# 1) 起一个带数据的本地实例（端口写死 18790，要改就改脚本顶上的 BASE）
GW_DEK=$(openssl rand -hex 32) GW_DATA_DIR=/tmp/uigw GW_PORT=18790 \
  GW_HOST=127.0.0.1 GW_BASE_URL=http://127.0.0.1:18790 GW_WEB_ROOT=$PWD/web \
  node dist/adapters/node/main.js &

# 2) 开一个独立的 Chrome（别用你平时那个，脚本会开关标签页）
open -na "Google Chrome" --args --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-uicheck --no-first-run about:blank

# 3) 跑
node scripts/uicheck/overflow.mjs     # 排版溢出
node scripts/uicheck/i18n-leak.mjs    # 英文模式下残留的中文
```

## overflow.mjs —— 排版溢出

在 360 / 402 / 430 / 768 / 1280 五档上把每个页面走一遍，报两件事：

- **整页横向滚动**（`body.scrollWidth > documentElement.clientWidth`）。
  这是硬要求，**一条都不许有**。
- **元素冲出视口** 与 **内容被裁**（`scrollWidth > clientWidth`）。

两类误报要自己分辨，不要照单全收：

- **落地页的插画是有意出血的**（`margin: 0 -16px`、`clip-path`），
  所以 `/welcome` 上那一堆 `svg` / `path` / `.packet` / `.clouds` 都不是 bug。
  判据是它**没有**触发整页横向滚动。
- `.truncate` 的省略号截断本来就会让 `scrollWidth > clientWidth`；
  `<input>` 的内部滚动同理。脚本已经跳过 `.truncate`，输入框要自己认。

**要灌压力数据再跑**：长得不可断的 URL、超长的设备名/渠道名、
长失败原因。不灌的话所有东西都短，什么都测不出来——
`/sent` 那个把整页撑到 462px 的 bug 就是靠一条长失败原因才现形的。

## i18n-leak.mjs —— 英文模式下的残留中文

切到英文，把每页的文本节点与 `placeholder/title/aria-label/alt` 扫一遍，
报出还含汉字的。分两组：

- **未登录可达的页**（落地页、通知页、登录、注册、隐私、找回）里**没有用户数据**，
  所以任何中文都是漏翻。
- **控制台内页**里短信正文、设备名、渠道名、公告是用户自己的数据，
  本来就该原样显示——要自己分辨。

已知的**有意**保留：语言切换按钮上的「中」与它的 `aria-label`、
设置页的「Language / 语言」（双语才认得出）。

**最常见的一类漏翻是「拼出来的串」**：`最后心跳 ${ago()} · v${ver}` 是
**一个**文本节点，整句命中规则之后，捕获组里的「13 分钟前」原样透传。
解法不是再加一条组合规则（那会没完没了，用户列表那行一度堆了十几条），
而是把每一段拆成各自的 `<span>`，让它们各自查表。
