# 主题续读与读时记忆

日期：2026-11-04

这一版只做两件事：沿一条主题线读到下一篇，以及在读的时候点回这条线上已经留下的划线、笔记和问答。下午路线、图可提问、全库搜索、新的阅读版式、新的记录类型、自动闪卡，都不在这一版。

## 阅读线

每个主题记住上次沿着它打开的论文。线记在主题上，不记在「这次从哪个页面点进来」。从论文库再次打开时，线还在。

`topics` 增加两列，用现有的 `migrateColumns` 补列：

- `cursor_arxiv_id TEXT`，默认空
- `cursor_at TEXT`，默认空

写入游标时，`cursor_at` 用 `datetime('now','localtime')`。只有该 `arxiv_id` 当前存在于这个主题的 `topic_papers` 中才允许写入。续读不修改论文的未读、在读、已读、精读。

### 选哪一条

纯函数 `resolveReadingLine` 的输入：

- 当前论文的 `arxiv_id`
- 这次打开时显式带入的 `enteredTopicId`，没有则为空
- 含有这篇论文的主题列表。每项有 `id`、`name`、`cursorArxivId`、`cursorAt`、`cursorInGraph`

`cursorInGraph` 为真，当且仅当 `cursorArxivId` 非空，且这个 id 仍在该主题当前的 `topic_papers` 里。构建失败或论文已被移出图时，游标可以还留在列上，但选线时把它当成没有游标。

规则按顺序：

1. `enteredTopicId` 在候选里，就用它。
2. 没有候选，返回空。阅读器不显示续读，也不做跨论文回跳。
3. 只有一个候选，用它。
4. 多个候选里，游标正指向这篇且 `cursorInGraph` 为真的那些，取 `cursorAt` 最新的。`cursorAt` 为空的排在任何时间之后。时间相同，取较大的主题 id。
5. 没有游标正指向这篇，就在全部候选里按同样的时间规则取一个。

从主题页打开（含主题里的「阅读」和精炼笔记回跳）时，把当前主题 id 作为 `enteredTopicId`。从论文库、沉淀、命令面板打开时不带。用户在工具栏改选主题时，把所选主题当作新的 `enteredTopicId`，并把该主题游标写成当前论文。

打开成功且解析出主题后，把该主题游标写成当前论文。这样从论文库回来时，规则 4 会落到上次正在读的那条线上。

### 下一篇

纯函数 `nextPaper`。只把 `read_order` 非空的论文排进去，按 `read_order` 升序，相同则按 `arxiv_id` 升序。

- 当前论文在这个序列里：返回下一项。已经是最后一项则返回空。
- 当前论文不在序列里：序列有论文则返回第一项，否则返回空。

序号有空档时仍按排序取下一项，不要求连续整数。

位置用纯函数 `layerPosition`。在当前层内排序：`read_order` 为空的放最后，其余按 `read_order`、再按 `arxiv_id`。位置从 1 计，分母是该层篇数。层的短名：

| layer | 短名 |
|---|---|
| series | 系列 |
| foundation | 地基 |
| key | 核心 |
| bridge | 桥梁 |
| frontier | 前沿 |
| discussion | 评测 |
| context | 参照 |
| node | 节点 |

未知层的短名用「节点」。当前论文不在该主题的论文列表里时，位置为空。

### 重新构建

`createTopic` 在构建开始时会清掉 `topic_papers`。这一步不清游标。`saveTopicGraph` 在写入新图的同一事务末尾调用纯函数 `cursorAfterSave`：游标 id 仍在新图里就保留原来的 `cursor_arxiv_id` 和 `cursor_at`，否则两列都写成空。构建抛错、事务没有提交时，游标保持原样。若论文行已经被清掉而新图没写上，选线会因 `cursorInGraph` 为假而忽略旧游标。

## 阅读器

非沉浸工具栏在标题和版式开关之间显示这条线。没有解析出主题时，这块不出现。沉浸模式沿用现在的工具栏隐藏，不另加一条浮动续读。

显示内容：

- 主题名。候选主题多于一个时，主题名是菜单，列出这些主题。选择后只换线并更新该主题游标，不离开当前论文。
- 层内位置，例如 `系列 3/7`。位置算不出来就不显示这段。
- 「下一篇」。下一篇与当前篇同一层，或当前篇没有层时，按钮文字就是「下一篇」。跨层时写作 `下一篇 · 评测` 这种，用下一篇的短名。没有下一篇时不显示按钮。

点「下一篇」：

- 已在库里：`openPaper(id, { topicId })`。先有论文 id，再进入阅读器。
- 不在库里：按钮改为「导入中…」并禁用，调用现有的 `importTopicPaper`。成功后再 `openPaper`。失败则留在当前论文，用现有错误提示，并恢复按钮。

从阅读器打开另一篇时，若当前 `readingTopicId` 的主题仍包含新论文，打开参数带上这个主题 id。否则不带，按选线规则重新解析。

主题详情里，游标论文且 `cursorInGraph` 为真的那一行标「读到这里」。

会话内把解析结果放在 store 的 `readingTopicId`。持久来源只有数据库里的游标，不另写 localStorage。

## 读时记忆

只使用当前阅读线上、其他论文里、已经挂了段落的高亮、笔记和问答。判定是词袋，不调用模型，也不建向量索引。纯函数放在 `src/readingLine.ts`，渲染进程和主进程共用。主进程由 esbuild 打进 `electron/main.ts`。测试用和 `tests/topic-graph.test.mjs` 相同的方式编译这个文件。

### 记录从哪来

一次 IPC `memory:list(topicId, excludePaperId)` 返回最多 200 条，按 `created_at` 新到旧。超出的更老记录这一版不参与回跳和提问。每条包含：`kind`（`H`、`N` 或 `Q`）、`id`、`paperId`、`pid`、`text`、`createdAt`、`title`。

来源：

- 高亮：`text` 是原文加备注。`pid` 为空的不要。
- 笔记：`text` 是笔记正文。`pid` 为空的不要。
- 问答：`text` 是问题加回答。`pid` 为空的不要。

论文必须能经 `arxiv_id` 连到该主题的 `topic_papers`，并且 `paper_id` 不是当前论文。查询失败时阅读器照常，只是没有回跳。

### 什么算重合

从文本里取两类记号，大小写按下面的规则，不切分中文。中文笔记只有在其中含有这些英文记号时才会命中。

- 缩写：原文里匹配 `[A-Z]{2,}(?:-[A-Z0-9]+)?`。保留原样。单独作为命中条件时，字母部分至少 3 个。`AI` 不行，`LLM` 可以，`GPT-4` 可以。
- 词：匹配 `[A-Za-z][A-Za-z0-9-]{3,}`，再转成小写。长度至少 4。

下面这些小写词删掉，不参与重合。缩写不走这张表。

`a` `an` `the` `and` `or` `but` `if` `then` `else` `when` `where` `what` `which` `who` `whom` `this` `that` `these` `those` `with` `from` `into` `over` `such` `than` `also` `more` `most` `between` `through` `during` `without` `within` `across` `under` `above` `have` `has` `had` `been` `were` `was` `are` `is` `be` `being` `not` `for` `its` `their` `they` `them` `our` `your` `you` `can` `may` `might` `must` `should` `would` `could` `will` `shall` `using` `used` `use` `based` `paper` `model` `models` `method` `methods` `approach` `approaches` `proposed` `result` `results` `figure` `table` `section` `equation` `algorithm` `performance` `experiment` `experiments` `dataset` `datasets` `training` `learning` `network` `networks` `task` `tasks` `show` `shows` `shown` `however` `therefore` `thus` `via` `per` `each` `both` `only` `same` `other` `about` `after` `before` `there` `here` `onto` `upon` `among` `while` `because` `since` `until` `against` `including` `include` `includes` `well` `many` `much` `some` `any` `all` `one` `two` `three` `new` `first` `second` `third`

一条记录命中，当下面任一成立：

- 至少两个重合的词
- 至少一个重合的缩写，且该缩写字母不少于 3
- 至少一个重合的词，长度不少于 8

分数是重合词的个数，加上重合缩写个数乘 2。不合格的记录分数再高也不要。一段只留分数最高的一条。分数相同取 `createdAt` 更新的；再相同则高亮优于问答、问答优于笔记；再相同取较小的 id。

当前段的文本用块的英文 `en`。没有英文的块不显示回跳。

### 段旁回跳

对照、双语、译文、PDF 阅读里，已经渲染出 `data-pid` 的正文块都可以放回跳。一段最多一个。放在该块末尾。文案：

- 高亮：`你在《标题》划过`
- 问答：`你在《标题》问过`
- 笔记：`你在《标题》记过`

标题超过 18 个字符时保留前 18 个并加省略号。点击时把 `paper:{paperId}:pid` 写成该段，再 `openPaper`，并带上当前 `readingTopicId`。

没有配置模型时，回跳仍然可用。

## 提问

`askQuestion` 增加可选的 `topicId`。问答侧栏把当前的 `readingTopicId` 传进去。没有主题 id 时，提问上下文与现在相同。

有主题 id 时，用问题文本加上当前传给提问的上下文字符串，对 `memory:list` 的同一批记录做同样的命中计算，取得分最高的最多 3 条。每条截到 240 个字符。有结果才加入用户消息：

```
【你在同主题其他论文留下的】
【H12】《标题》：片段
```

系统提示增加一条：这些内容不是当前论文的段落；用到它们时只标 `【H12】`、`【N3】`、`【Q5】`，不要写成 `【段落 #N】`。现有的段落引用规则保持不变。

`AnswerText` 已经把 `【H12】` 这类标记画成可点的芯片。阅读器问答里的跳转改为：

- `【段落 #N】` 仍只在当前论文内滚动。
- `【H】`、`【N】`、`【Q】` 调用 `memory:locate(kind, id)`。查到且是当前论文，就滚到那个 `pid`。查到且是另一篇，按段旁回跳的方式打开，并带上当前阅读线（新论文不在这条线里则重新解析）。查不到时提示「这条记录已经不在」，留在当前页。

`memory:locate` 按编号读高亮、笔记或问答。笔记和问答的 `pid` 为空时返回空。沉淀页里问答的跳转这一版不改，仍跳到那条问答自己挂的段落。

`kind` 用 `'H' | 'N' | 'Q'`。分支用穷尽 switch，默认分支做 `never` 检查。

## 失败

- 主题被删、候选查询失败、记忆查询失败：阅读器照常打开，续读和回跳不出现。
- 下一篇导入失败：留在当前论文，按钮恢复。
- 没有模型：回跳仍在；提问仍是现在的「未配置 LLM Provider」。
- 记录在回答生成后被删除：点击引用时提示「这条记录已经不在」。

## 测试

新增 `tests/reading-line.test.mjs`，编译 `src/readingLine.ts`，加入 `scripts/test-all.mjs` 的离线层，放在主题分层单元测试旁边。覆盖：

- 显式进入的主题优先，即使另一条线的游标更新。
- 显式主题不含这篇时，不采用它。
- 零个候选、一个候选。
- 多条线里只有一条游标指向这篇。
- 多条都指向这篇时，较新的 `cursorAt` 胜出。
- 都没指向这篇时，较新的 `cursorAt` 胜出。
- 空的 `cursorAt` 输给任何时间。
- `cursorAt` 相同时，较大的主题 id 胜出。
- `cursorInGraph` 为假时，该游标不算「指向这篇」。
- 下一篇取排序后的下一项，序号有空档也一样。
- 已经是最后一项时没有下一篇。
- 当前论文没有 `read_order` 时，下一篇是序列第一项。
- 层内位置把空的 `read_order` 排在该层最后，并且仍然计入分母。
- `cursorAfterSave` 在 id 仍在新图里时保留，否则清空。
- 只有停用词时没有回跳。
- 两个实词命中。
- 一个长度不少于 8 的词命中。
- 一个长度 7 的词、且没有缩写时不命中。
- `LLM` 命中，`AI` 不命中。
- 分数更高的记录胜出。
- 分数相同，较新的记录胜出。
- 分数和时间都相同，高亮优于问答，问答优于笔记。

不把整段 UI 旅程加进这一版的验收。现有的交互界面和用户旅程测试在质量台账里是失败的，这一版不靠它们证明续读。

## 接口

渲染进程新增：

- `topicCandidates(arxivId)`
- `setTopicCursor({ topicId, arxivId })`
- `listMemory(topicId, excludePaperId)`
- `locateMemory(kind, id)`

`askQuestion` 的参数增加可选 `topicId`。`openPaper` 增加可选的主题 id 参数。`getTopic` 的主题行带上两列游标，因为本来就是 `SELECT *`。
