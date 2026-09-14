📈 股市市场研究驾驶舱


<img width="1280" height="1280" alt="首页" src="https://github.com/Alex0510/stock/stock.png" />

基于 Cloudflare Workers 搭建的在线股市行情与市场研究驾驶舱。

项目采用单文件 Worker 架构，前端页面与后端 API 集成在同一个 JavaScript 文件中，无需 VPS、Node.js 服务器、Nginx、Vercel 或其他后端服务器。

✨ 主要功能

* 📊 A 股实时行情
* 🇺🇸 美股行情
* 📈 美股实时分时
* 🔥 涨幅榜 / 跌幅榜 / 活跃榜
* 🏭 行业与概念板块
* 💰 个股资金流
* 💹 板块资金流
* 🚀 涨停与市场情绪
* 🔍 股票搜索
* 📰 财经快讯
* 🛢️ 黄金 / 白银 / 原油等期货行情
* ₿ BTC/USDT 行情
* 🇺🇸 美国国债收益率
* 📑 财务数据
* 📊 市场决策中心

🌐 数据来源

项目使用多个公开财经数据源，包括：

* 腾讯财经
* 新浪财经
* 东方财富
* Wallstreetcn
* CNBC
* Binance
* 美国财政部公开数据

本项目不会主动生成虚假行情数据。当第三方数据源不可用、超时或受到访问限制时，对应模块可能显示暂无数据或不可用。

⸻

🚀 Cloudflare Workers 部署教程

一、注册 Cloudflare

打开 Cloudflare：

https://dash.cloudflare.com/

注册并登录 Cloudflare 账号。

进入控制台后找到：

Workers & Pages

然后选择：

Create application / Create Worker

Cloudflare 控制台版本不同，按钮名称可能略有区别。

⸻

二、创建 Worker

点击：

Create Worker

Worker 名称可以填写：

stock-dashboard

创建完成后，Cloudflare 会自动分配一个 workers.dev 地址，例如：

https://stock-dashboard.xxxxx.workers.dev

完成 Worker 创建。

⸻

三、上传项目代码

进入刚刚创建的 Worker。

找到：

Edit Code

Cloudflare 默认可能会生成：

export default {
  async fetch(request, env, ctx) {
    return new Response("Hello World!");
  }
};

将默认代码：

全部删除

然后打开本项目提供的 Worker .js 文件。

例如：

worker.js

复制文件中的全部代码，粘贴到 Cloudflare Worker 在线编辑器。

注意：

不要只复制 HTML 部分。

这个项目的：

* 前端 HTML
* CSS
* JavaScript
* Worker API
* 行情请求
* 数据处理
* 缓存

都集成在同一个 Worker 文件中。

粘贴完成后点击：

Deploy

等待 Cloudflare 提示部署成功。

⸻

🌍 四、访问网站

部署完成后打开 Cloudflare 提供的地址：

https://stock-dashboard.xxxxx.workers.dev

如果部署正常，即可看到：

股市市场研究驾驶舱

至此已经完成基本部署。

⸻

⚡ 五、配置 Cloudflare KV 缓存（推荐）

项目支持 Cloudflare KV 缓存。

不配置 KV 通常也可以运行，但配置 KV 后可以进一步利用持久化缓存，减少部分第三方行情接口的重复请求。

1. 创建 KV

进入 Cloudflare 控制台。

找到：

Storage & Databases → KV

创建新的 KV Namespace。

例如：

MRD_CACHE

⸻

2. 绑定 Worker

进入：

Workers & Pages

选择：

stock-dashboard

进入：

Settings → Bindings

添加：

KV Namespace Binding

变量名称填写：

MRD_KV

KV Namespace 选择：

MRD_CACHE

最终类似：

Variable name: MRD_KV
KV Namespace:  MRD_CACHE

保存配置。

建议重新部署一次 Worker。

⚠️ 注意

Binding 变量名称建议保持：

MRD_KV

因为项目代码使用：

env.MRD_KV

访问 KV。

如果修改 Binding 名称，则需要同时修改源码。

⸻

🌐 六、绑定自己的域名

如果域名已经托管到 Cloudflare，可以给项目绑定自己的域名。

例如：

example.com

进入：

Workers & Pages → stock-dashboard → Settings → Domains & Routes

选择：

Add → Custom Domain

填写：

stock.example.com

配置完成后即可通过：

https://stock.example.com

访问股市驾驶舱。

这样就不需要使用默认：

workers.dev

域名。

⸻

🧩 项目架构

整体结构：

用户浏览器
     │
     ▼
Cloudflare Worker
     │
     ├── 腾讯财经
     ├── 新浪财经
     ├── 东方财富
     ├── Wallstreetcn
     ├── CNBC
     ├── Binance
     └── 其他公开数据源
     │
     ▼
数据解析 / 缓存 / API
     │
     ▼
股市市场研究驾驶舱

项目采用单 Worker 架构，因此不需要额外搭建：

❌ VPS
❌ Node.js Server
❌ PHP
❌ MySQL
❌ Nginx
❌ Vercel
❌ Netlify

Cloudflare Workers 即可直接运行。

⸻

📁 推荐 GitHub 项目结构

可以按照下面的方式上传：

stock-dashboard/
│
├── worker.js
├── README.md
└── LICENSE

其中：

worker.js

为完整 Cloudflare Worker 源代码。

README.md

为本搭建说明。

⸻

🇺🇸 美股功能

项目内置多个美股分类，例如：

科技
半导体
AI
中概股
金融
能源
医疗
消费
软件
云计算
网络安全
新能源车

并提供：

核心股票
实时分时
涨幅榜
跌幅榜
活跃榜

方便快速查看不同美股板块行情。

⸻

🔄 更新项目

以后如果 GitHub 发布了新版 worker.js：

1. 下载最新 worker.js
2. 打开 Cloudflare Worker
3. 进入 Edit Code
4. 删除旧代码
5. 粘贴新版完整代码
6. 点击 Deploy

刷新网站即可使用新版。

⸻

🛠 常见问题

1. Worker 部署成功，但是页面打不开

进入：

Workers & Pages → Worker → Logs

打开实时日志，然后重新访问网页。

检查是否出现：

1101
Worker threw exception
SyntaxError
TypeError

如果出现 JavaScript 语法错误，优先检查上传到 Worker 的源码是否完整。

⸻

2. 页面正常，但某些行情没有数据

这通常不一定是 Worker 本身的问题。

由于行情来自第三方数据源，可能出现：

HTTP 403
HTTP 429
请求超时
接口临时不可用
Cloudflare 出口 IP 被限制
第三方接口发生变化

因此可能出现：

A 股正常，美股异常
或者
行情正常，新闻异常

这种情况下应该检查对应第三方数据源。

⸻

3. 是否必须配置 KV？

不是。

项目可以使用 Worker 内存缓存。

KV 属于推荐配置。

需要更稳定的跨 Worker 实例缓存时，可以配置：

MRD_KV

⸻

4. 是否需要 VPS？

不需要。

整个项目可以直接运行于：

Cloudflare Workers

⸻

5. 可以使用自己的域名吗？

可以。

推荐使用：

stock.example.com

这种二级域名绑定 Worker。

⸻

⚠️ 使用说明

本项目提供的行情、新闻、资金流、财务指标以及其他市场数据来自第三方公开数据源。

由于网络环境、第三方接口调整、访问频率限制以及 Cloudflare 出口节点等因素，无法保证所有数据源始终可用。

本项目展示的数据仅供：

* 学习
* 技术研究
* 市场信息参考

不构成任何投资建议。

任何投资决策均应由使用者自行判断并承担相应风险。

⸻

⭐ GitHub

如果这个项目对你有帮助，欢迎：

Star ⭐ / Fork 🍴

也欢迎提交：

Issues / Pull Requests

用于反馈 Bug、数据源失效或功能改进建议。
