# CarryCheck

**复制之前，先找出目录交付和合并时会遇到的问题。**

[English](README.md) · [MIT 许可证](LICENSE) · Node.js 22+ · 零依赖

两个目录分别看都正常，合并到同一个目标后却可能互相覆盖。CarryCheck 把一个或多个来源投射到虚拟目标目录，检查文件覆盖、名称兼容性、路径预算和符号链接，并标明每个问题来自哪里。

适用于合并构建产物、交付数据集、把项目发给使用其他操作系统的人。扫描只读文件名、元数据和符号链接的目标文本；不会复制、改名、删除文件，也不读取普通文件内容。使用计划或清单时，会读取对应的 JSON 文件。

## 快速使用

```sh
git clone https://github.com/DrEli7/carrycheck.git
cd carrycheck
node bin/carrycheck.js . --target windows
node bin/carrycheck.js --plan examples/merge-plan.json
node bin/carrycheck.js --manifest examples/problem-manifest.json --format json
```

后两个例子故意包含冲突，退出码为 **1**。`npm run demo` 也会按预期返回 **1**。无需安装依赖或构建。可选执行 `npm install -g .`，将当前本地版本安装为 `carrycheck` 命令。

## 合并前预检

```sh
node bin/carrycheck.js ./release-a ./release-b --target windows
```

两个目录的**内容**映射到同一虚拟根目录，不会自动加上来源目录名。工具没有“后面的来源覆盖前面”的优先级；即使文件内容可能相同，也会报告同名覆盖。名称完全相同的目录可以合并。

需要指定目标位置时，使用 JSON 计划：

```json
{
  "sources": [
    { "from": "./left", "to": "reports", "label": "first" },
    { "from": "./right", "to": "reports", "label": "second" }
  ]
}
```

`from` 相对于计划文件所在目录解析，不受运行命令时的工作目录影响。省略 `to` 或填写 `""` 表示映射到根目录。`to` 使用正斜杠，不能包含空段、`.` 或 `..`。`label` 必须唯一；省略后使用 `source-1`、`source-2` 等匿名标签，直接传目录时也使用这些标签。

示例计划中的 `first` 和 `second` 都要写入 `reports/README.txt`，报告会指出双方来源：

```json
{
  "code": "OVERWRITE",
  "severity": "error",
  "message": "Multiple source entries occupy the same destination name.",
  "paths": [
    { "path": "reports/README.txt", "source": "first" },
    { "path": "reports/README.txt", "source": "second" }
  ],
  "hint": "Place sources under separate mount points or decide explicitly which file to keep. Content equality is not checked."
}
```

把两个映射分别改为 `reports/first` 和 `reports/second`，即可消除这处冲突。CarryCheck 只评估布局，不创建目标目录。若要考虑目标目录中已经存在的文件，把该目录也列为一个来源。报告内容使用英文。

## 离线清单

清单直接描述虚拟目标，可以表达当前系统无法创建的文件名，便于跨平台测试和复现问题。

```json
{
  "entries": [
    { "path": "docs/Readme.txt", "source": "first" },
    { "path": "docs/README.txt", "source": "second" },
    { "path": "latest", "source": "first", "type": "symlink", "linkTarget": "docs/Readme.txt" }
  ]
}
```

顶层也可以直接是数组。每项必须有非空相对 `path`，用 `/` 分段；绝对路径、空段、`.` 和 `..` 会被拒绝。`type` 可为 `file`（默认）、`directory` 或 `symlink`；符号链接必须提供 `linkTarget`。`source` 默认是 `source-1`。字符串必须是合法 Unicode，且不能含 NUL。缺少的祖先目录会自动推导。

清单模式只读这份 UTF-8 JSON，不检查文件是否实际存在。[问题清单](examples/problem-manifest.json) 展示了大小写与 Unicode 碰撞、Windows 设备名、文件/目录冲突、越界链接和不可见字符。

## 目标规则与路径预算

| 规则 | 目标名称比较方式 | 长度单位 |
| --- | --- | --- |
| `windows`（默认） | NFC + JavaScript 小写转换；别名检查另去除末尾点和空格 | UTF-16 代码单元 |
| `macos` | 保守使用 NFC + JavaScript 小写转换 | UTF-8 字节 |
| `posix` | 保留原始拼写，精确比较 | UTF-8 字节 |

Windows 规则检查带扩展名和上标数字的设备保留名、禁用标点/控制字符、末尾点和空格。Windows 与 macOS 规则还会提醒分解形式的 Unicode 名称。所有规则都检查不可见/控制/格式字符、覆盖、条目类型冲突、255 单位组件预算、完整路径预算和虚拟目录中的链接链。

这些是可移植性策略，**并非 NTFS/APFS 模拟器，也不保证每个目标工具都接受该目录**。区分大小写的 macOS 卷或 Windows 目录可能有不同表现；JavaScript 小写转换也不能完整模拟文件系统的大小写折叠。

默认 `--max-path 259` 和 `--root-length 40` 对**三种规则全部生效**。它们是可配置的工具链预算，不是通用操作系统或硬件极限。现代 Windows 的长路径支持还取决于应用和系统配置，见 [Microsoft 官方命名文档](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)。

非空输入的计算方法：

```text
完整目标路径长度 = rootLength + 1 个分隔符 + 相对路径长度
根目录最大预算 = maxPath - 1 个分隔符 - 最长相对路径长度
```

根目录长度不含最后的分隔符，计量单位由目标规则决定。根目录最大预算为负数，意味着相对路径本身已经超预算。空输入的剩余根目录预算直接返回 `maxPath`。

```sh
node bin/carrycheck.js ./dist --root-length 80 --max-path 400
node bin/carrycheck.js ./dist --target posix --max-path 4095
```

## 命令行选项

```text
carrycheck [options] [directory ...]
carrycheck --plan FILE [options]
carrycheck --manifest FILE [options]
```

不指定输入时扫描 `.`。目录参数、计划和清单三种模式不能混用。

| 选项 | 说明 |
| --- | --- |
| `--target windows\|macos\|posix` | 目标规则，默认 `windows` |
| `--format text\|json\|markdown` | 输出格式，默认 `text` |
| `--root-length N` | 非负目标根目录长度，默认 `40` |
| `--max-path N` | 正整数完整路径预算，默认 `259` |
| `--exclude PATH` | 可重复；排除相对路径/子树或任意层级同名条目，不支持 glob |
| `--include-defaults` | 包含默认排除的 `.git` 和 `node_modules` |
| `--strict` | 有警告也返回失败退出码 |
| `--help`、`--version` | 显示帮助或版本 |
| `--` | 后续参数全部按目录路径处理 |

默认跳过任意层级的 `.git` 和 `node_modules`。不含斜杠的排除项匹配任意层级的条目名；含斜杠时匹配来源中的完整相对路径及其子树，在目标映射前应用。排除规则区分大小写、使用正斜杠、不读取 `.gitignore`；清单模式不能使用排除选项。

报告写入 stdout，输入/读取错误写入 stderr。JSON 包含 `schemaVersion: 1`、`target`、`summary`、`budget` 和 `findings`。每条问题有 `code`、`severity`、`message`、带来源标签的 `paths` 和 `hint`。报告使用目标相对路径，不显示来源绝对根目录；文件名和自定义标签本身仍可能包含敏感信息。

```sh
node bin/carrycheck.js --plan merge.json --format json > report.json
node bin/carrycheck.js ./dist --format markdown > report.md
```

| 退出码 | 含义 |
| --- | --- |
| `0` | 无错误；未启用 `--strict` 时允许警告 |
| `1` | 存在错误，或 `--strict` 下存在警告 |
| `2` | 输入无效或文件系统/读取失败，没有完整审计报告 |

## 局限与链接行为

- 扫描时来源目录必须保持稳定。工具能发现部分变化，但不是能抵御竞态攻击的安全边界。来源根目录必须是真实目录，不能是符号链接。
- 不遍历宿主系统中的符号链接；读取目标文本后，在**投射后的目标目录**中分析，允许链接通过另一个来源解析。绝对、越界、悬空、循环、歧义或含平台相关反斜杠的目标会报错；最多分析 64 次链接跳转。所有链接还会收到可移植性警告。
- 分析上限为 100,000 个显式条目、256 层路径、200,000 个推导后的虚拟节点；路径/链接长度、标签和文本总量也有限制。超限输入不会生成报告。特殊文件、无法读取的条目和无效 UTF-8 文件名/链接目标也会使扫描失败。
- 不解析压缩包、不计算哈希、不比较文件内容、不执行复制、不评估权限/ACL 或磁盘空间，也不精确模拟某款复制/解压工具。即使内容一致，同名文件仍报告覆盖。
- 通过检查只代表当前输入符合所选策略，不能保证之后的复制、持续变化的目录或每一种接收端文件系统。

## JavaScript API

```js
import { audit, scanDirectory, formatJson } from './src/index.js';

const entries = await scanDirectory('./dist', {
  source: 'release', to: 'app', exclude: ['.git', 'node_modules']
});
const report = audit(entries, { target: 'windows', rootLength: 40, maxPath: 259 });
process.stdout.write(formatJson(report));
```

`audit()` 是无文件系统 I/O 的纯函数。`scanDirectory()` 不会自动应用 CLI 的默认排除项。另导出 `formatText()` 和 `formatMarkdown()`。

## 相关项目

[pre-commit-hooks](https://github.com/pre-commit/pre-commit-hooks) 提供大小写冲突与 Windows 非法名称检查；[pathvalidate](https://github.com/thombashi/pathvalidate) 校验和清理单个路径；[filename-checker](https://github.com/rapjul/filename-checker) 侧重长度与 SMB 限制。[rclone](https://rclone.org/commands/rclone_copy/) 支持真实传输和 dry-run，[GMD](https://github.com/m5it/gmd) 提供目录比较和同步预览。

CarryCheck 聚焦一套小型工作流：把多个来源映射到虚拟目标，以指定可移植性策略检查组合后的名称和链接，再分享文本、JSON 或 Markdown 报告。单项检查已有成熟先例，本项目不声称独创或唯一。

## 开发

```sh
npm test
npm run check
```

CI 配置覆盖 Ubuntu、Windows、macOS，以及 Node.js 22、24。Windows 缺少链接权限时，真实符号链接测试可能跳过；虚拟清单中的链接测试不依赖宿主权限。参见 [贡献说明](CONTRIBUTING.md) 与[安全说明](SECURITY.md)。
