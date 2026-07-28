# 第十九章：UI/UX 设计哲学，有信仰的克制

---

## 问题陈述：为什么设计审美是工程问题

**界面设计的一致性，和代码逻辑的一致性同等重要。**

在迭代速度很快的早期阶段，设计元素会悄悄漂移。不同的开发会话加入了不同的橙色，不同的场景引入了不同的间距标准，不同的组件用了不同的阴影深度。每一次单独看都说得过去，但积累起来，界面会开始产生一种模糊的不舒服感，用户说不清楚哪里不对，但他们能感受到。

这篇文章试图把这种说不上来的舒服或不舒服变成可执行的设计原则。

---

## 原则一：结构自显，拒绝贴标签

卡片左侧竖线是一条明确的设计红线。无论何种场景，这个元素都不应该出现在界面里。

「accent border」或「left border indicator」是一种极为常见的设计模式，在 Material Design、Bootstrap 等设计系统中随处可见，用来表示状态、分类或强调。那么问题出在哪里？

竖线本质上是**外加的层级标注**。它在内容旁边贴了一个标签，告诉用户这个东西属于某种类别，而不是让内容本身通过排版、颜色、位置自然传达出来。

这暴露了设计者的意图太过明显：我要让你注意这里。高品质的设计不这样说话，它是这个东西本身值得你注意。

**延伸到同类的被拒绝元素：**
- 卡片边框，用底色区分即可
- 过重的阴影，输入框尤其要避免
- 半透明色块背景
- 蓝色分隔线

这些元素有一个共同特征：它们都是贴上去的，而不是从材质和结构中长出来的。

> **可执行原则**：每当想用竖线/边框/分隔线来告诉用户某个元素的重要性，先问：能否通过底色、字体粗细、留白大小来传达同样的信息？如果可以，就不需要那条线。竖线的存在，是对设计层次感不足的补偿；强大的设计，不需要补偿。

<style>
.demo-block-p1 {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  background: #fafaf7;
  border-radius: 12px;
  padding: 24px;
  margin: 24px 0;
}
.demo-block-p1 .demo-title {
  font-size: 13px;
  color: #8B7355;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.demo-block-p1 .compare-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.demo-block-p1 .compare-col {
  flex: 1;
  min-width: 200px;
}
.demo-block-p1 .compare-label {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  margin-bottom: 10px;
  display: inline-block;
}
.demo-block-p1 .label-bad {
  background: #fde8e8;
  color: #c0392b;
}
.demo-block-p1 .label-good {
  background: #e8f5e9;
  color: #2e7d32;
}
.demo-block-p1 .card-bad {
  background: #fff;
  border: 1px solid #e8e4dc;
  border-radius: 8px;
  padding: 14px 16px;
  border-left: 4px solid #8B7355;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.demo-block-p1 .card-good {
  background: #f3f0ea;
  border-radius: 8px;
  padding: 14px 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
}
.demo-block-p1 .card-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #c4b49a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  font-weight: 700;
  margin-bottom: 8px;
}
.demo-block-p1 .card-name {
  font-size: 13px;
  font-weight: 600;
  color: #1A1714;
  margin-bottom: 4px;
}
.demo-block-p1 .card-text {
  font-size: 13px;
  color: #5a5450;
  line-height: 1.6;
}
.demo-block-p1 .card-note {
  font-size: 11px;
  color: #a09890;
  margin-top: 10px;
}
</style>

<div class="demo-block-p1">
  <div class="demo-title">竖线对比：结构自显 vs 贴标签</div>
  <div class="compare-row">
    <div class="compare-col">
      <div class="compare-label label-bad">✗ 被拒绝</div>
      <div class="card-bad">
        <div class="card-avatar">A</div>
        <div class="card-name">Alice</div>
        <div class="card-text">今天读完了《置身事内》，兰小欢写中国政府与经济，从土地财政一路讲到债务逻辑，让人忽然明白很多事不是坏，是结构。</div>
        <div class="card-note">左侧竖线 = 外加的层级标注，设计意图过于明显</div>
      </div>
    </div>
    <div class="compare-col">
      <div class="compare-label label-good">✓ Alice 的选择</div>
      <div class="card-good">
        <div class="card-avatar">A</div>
        <div class="card-name">Alice</div>
        <div class="card-text">今天读完了《置身事内》，兰小欢写中国政府与经济，从土地财政一路讲到债务逻辑，让人忽然明白很多事不是坏，是结构。</div>
        <div class="card-note">底色区分层次，无竖线，结构从材质中自然生长</div>
      </div>
    </div>
  </div>
</div>

---

## 原则二：时间连续，任何切换都不应硬来

硬切是高频出现的设计问题，接受度极低，属于不可商量的选项。

什么是硬切？**状态 A 在一帧内变成状态 B，没有任何过渡。**

动效不是装饰，它是界面时间维度的语言。当一个元素走向某个地方消失，而不是凭空蒸发，用户的大脑会将界面感知为一个连续的空间，而不是一系列静态画面的切换。这种感知差异，是有质感和没有质感之间最根本的区别之一。

列表的展开和收起，应当配合淡出动效；点击关闭按钮，应当有渐退而非直接消失；主题切换等全局变化，同样需要平滑过渡。

**模态框的动效标准**是参照微信：背景先产生模糊效果，然后内容从下方弹出，两个动作有轻微时间差。背景先变模糊告诉用户原有上下文暂时被遮蔽，内容弹出告诉用户新的交互层次出现了，这是层次感的时间叙事。

**有输入的模态框不允许轻易点击外部关闭。** 这条规则很精细：用户已经输入了信息，随意关闭会导致信息丢失和挫败感。只是展示信息的模态框点击外部关闭是合理的。区分两种模态框的行为，是对交互场景细粒度理解的体现。

> **可执行原则**：展开/收起/切换/弹出/消失，任何状态变化都需要过渡动效，最低限度是淡入淡出。硬切是对用户时间感知的粗暴中断。

<style>
.demo-block-p2 {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  background: #fafaf7;
  border-radius: 12px;
  padding: 24px;
  margin: 24px 0;
}
.demo-block-p2 .demo-title {
  font-size: 13px;
  color: #8B7355;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.demo-block-p2 .compare-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.demo-block-p2 .compare-col {
  flex: 1;
  min-width: 200px;
}
.demo-block-p2 .col-label {
  font-size: 12px;
  font-weight: 600;
  color: #5a5450;
  margin-bottom: 10px;
}
.demo-block-p2 .toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 6px;
  border: 1px solid #e8e4dc;
  background: #fff;
  font-size: 13px;
  color: #1A1714;
  cursor: pointer;
  font-family: inherit;
  margin-bottom: 12px;
  transition: background 0.15s;
}
.demo-block-p2 .toggle-btn:hover {
  background: #f3f0ea;
}
.demo-block-p2 .list-hard {
  background: #fff;
  border: 1px solid #e8e4dc;
  border-radius: 8px;
  overflow: hidden;
}
.demo-block-p2 .list-smooth {
  background: #fff;
  border: 1px solid #e8e4dc;
  border-radius: 8px;
  overflow: hidden;
}
.demo-block-p2 .list-items-hard {
  display: none;
}
.demo-block-p2 .list-items-hard.open {
  display: block;
}
.demo-block-p2 .list-items-smooth {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 280ms ease, opacity 280ms ease;
}
.demo-block-p2 .list-items-smooth.open {
  max-height: 300px;
  opacity: 1;
}
.demo-block-p2 .list-item {
  padding: 10px 14px;
  font-size: 13px;
  color: #1A1714;
  border-bottom: 1px solid #f3f0ea;
  line-height: 1.5;
}
.demo-block-p2 .list-item:last-child {
  border-bottom: none;
}
.demo-block-p2 .note-tag {
  display: inline-block;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 3px;
  margin-top: 8px;
}
.demo-block-p2 .note-bad {
  background: #fde8e8;
  color: #c0392b;
}
.demo-block-p2 .note-good {
  background: #e8f5e9;
  color: #2e7d32;
}
</style>

<div class="demo-block-p2">
  <div class="demo-title">硬切 vs 过渡动效：大脑的感知差异</div>
  <div class="compare-row">
    <div class="compare-col">
      <div class="col-label">硬切模式</div>
      <button class="toggle-btn" onclick="
        var items = document.getElementById('hardItems');
        var btn = this;
        if(items.classList.contains('open')) {
          items.classList.remove('open');
          btn.textContent = '▶ 展开列表';
        } else {
          items.classList.add('open');
          btn.textContent = '▼ 收起列表';
        }
      ">▶ 展开列表</button>
      <div class="list-hard">
        <div id="hardItems" class="list-items-hard">
          <div class="list-item">《置身事内》— 兰小欢</div>
          <div class="list-item">《万历十五年》— 黄仁宇</div>
          <div class="list-item">《枪炮、病菌与钢铁》— 贾雷德·戴蒙德</div>
          <div class="list-item">《人类简史》— 尤瓦尔·赫拉利</div>
        </div>
      </div>
      <div class="note-tag note-bad">大脑感知为「画面切换」</div>
    </div>
    <div class="compare-col">
      <div class="col-label">动效模式（280ms fade + slide）</div>
      <button class="toggle-btn" onclick="
        var items = document.getElementById('smoothItems');
        var btn = this;
        if(items.classList.contains('open')) {
          items.classList.remove('open');
          btn.textContent = '▶ 展开列表';
        } else {
          items.classList.add('open');
          btn.textContent = '▼ 收起列表';
        }
      ">▶ 展开列表</button>
      <div class="list-smooth">
        <div id="smoothItems" class="list-items-smooth">
          <div class="list-item">《置身事内》— 兰小欢</div>
          <div class="list-item">《万历十五年》— 黄仁宇</div>
          <div class="list-item">《枪炮、病菌与钢铁》— 贾雷德·戴蒙德</div>
          <div class="list-item">《人类简史》— 尤瓦尔·赫拉利</div>
        </div>
      </div>
      <div class="note-tag note-good">大脑感知为「空间连续」</div>
    </div>
  </div>
</div>

---

## 原则三：颜色是语义，不是装饰

界面中存在多套相近颜色，是设计漂移的信号。Alice 的选择是收拢，而不是继续兼容。

**颜色是一种语义资源。** 每种颜色都意味着一种用户需要学习的含义。颜色越多，用户的认知负担越重，界面的噪音越大。配色不超过 3 种主色，是这个原则的具体落地。

**颜色的稳定性原则**：书封面的颜色用确定性算法（哈希书名）来分配，而不是随机的。这样既保证视觉丰富性，又保证一致性，同一本书永远是同一个颜色。颜色在这里不是装饰，而是稳定的标识系统。

**高级感的色彩语义**：磨砂、夜宴，这些主题名称本身就携带了完整的颜色语义。磨砂不反光、不张扬、触感细腻；夜宴是黑金配色、低调奢华。高级感的本质是有文化语义的极简，不是用更多颜色来堆叠，而是用一个充满联想空间的词汇来统领基调。

> **设计规范摘录**：设计遵循简洁原则，留白大方、配色克制、排版清晰。这三个词构成色彩哲学的核心三角形。颜色克制，才能让留白真正活；留白大方，才能让排版真正呼吸；排版清晰，才能让信息真正说话。

<style>
.demo-block-p3 {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  background: #fafaf7;
  border-radius: 12px;
  padding: 24px;
  margin: 24px 0;
}
.demo-block-p3 .demo-title {
  font-size: 13px;
  color: #8B7355;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 20px;
}
.demo-block-p3 .section-label {
  font-size: 12px;
  color: #8B7355;
  font-weight: 600;
  margin-bottom: 12px;
  margin-top: 20px;
}
.demo-block-p3 .section-label:first-of-type {
  margin-top: 0;
}
.demo-block-p3 .color-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.demo-block-p3 .color-chip {
  position: relative;
  cursor: pointer;
}
.demo-block-p3 .color-swatch {
  width: 64px;
  height: 48px;
  border-radius: 8px;
  border: 1px solid rgba(0,0,0,0.06);
  margin-bottom: 6px;
  transition: transform 0.15s, box-shadow 0.15s;
}
.demo-block-p3 .color-chip:hover .color-swatch {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
}
.demo-block-p3 .color-name {
  font-size: 11px;
  color: #1A1714;
  font-weight: 600;
  margin-bottom: 2px;
}
.demo-block-p3 .color-hex {
  font-size: 10px;
  color: #a09890;
  font-family: 'SF Mono', monospace;
}
.demo-block-p3 .color-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #1A1714;
  color: #fff;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 5px;
  white-space: nowrap;
  z-index: 10;
  pointer-events: none;
}
.demo-block-p3 .color-chip:hover .color-tooltip {
  display: block;
}
.demo-block-p3 .theme-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.demo-block-p3 .theme-block {
  flex: 1;
  min-width: 160px;
}
.demo-block-p3 .theme-name {
  font-size: 13px;
  font-weight: 600;
  color: #1A1714;
  margin-bottom: 10px;
}
.demo-block-p3 .theme-swatches {
  display: flex;
  gap: 6px;
}
.demo-block-p3 .theme-swatch {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.06);
  cursor: pointer;
  transition: transform 0.15s;
  position: relative;
}
.demo-block-p3 .theme-swatch:hover {
  transform: scale(1.1);
}
.demo-block-p3 .theme-swatch .color-tooltip {
  bottom: calc(100% + 6px);
}
</style>

<div class="demo-block-p3">
  <div class="demo-title">颜色系统：语义而非装饰</div>

  <div class="section-label">六个核心色变量及其语义</div>
  <div class="color-row">
    <div class="color-chip">
      <div class="color-swatch" style="background:#FAFAF7; border:1px solid #e8e4dc;"></div>
      <div class="color-name">背景色</div>
      <div class="color-hex">#FAFAF7</div>
      <div class="color-tooltip">页面底色，暖白克制，不刺眼</div>
    </div>
    <div class="color-chip">
      <div class="color-swatch" style="background:#1A1714;"></div>
      <div class="color-name">文字色</div>
      <div class="color-hex">#1A1714</div>
      <div class="color-tooltip">正文主色，带微暖调的深黑</div>
    </div>
    <div class="color-chip">
      <div class="color-swatch" style="background:#6B6460;"></div>
      <div class="color-name">次要文字</div>
      <div class="color-hex">#6B6460</div>
      <div class="color-tooltip">辅助信息，降调但不消失</div>
    </div>
    <div class="color-chip">
      <div class="color-swatch" style="background:#C9A96E;"></div>
      <div class="color-name">金色</div>
      <div class="color-hex">#C9A96E</div>
      <div class="color-tooltip">品牌强调色，温润不张扬</div>
    </div>
    <div class="color-chip">
      <div class="color-swatch" style="background:#5B8FB9;"></div>
      <div class="color-name">蓝色</div>
      <div class="color-hex">#5B8FB9</div>
      <div class="color-tooltip">交互色，链接与操作按钮</div>
    </div>
    <div class="color-chip">
      <div class="color-swatch" style="background:#EAE8E3; border:1px solid #dedad4;"></div>
      <div class="color-name">卡片色</div>
      <div class="color-hex">#EAE8E3</div>
      <div class="color-tooltip">卡片、悬浮层背景，有层次感</div>
    </div>
  </div>

  <div class="section-label">两套主题（Hover 查看角色语义）</div>
  <div class="theme-row">
    <div class="theme-block">
      <div class="theme-name">磨砂（浅色）</div>
      <div class="theme-swatches">
        <div class="theme-swatch" style="background:#FAFAF7; border:1px solid #e8e4dc;">
          <div class="color-tooltip">背景：暖白亚光 #FAFAF7</div>
        </div>
        <div class="theme-swatch" style="background:#EAE8E3;">
          <div class="color-tooltip">卡片：细腻暖灰 #EAE8E3</div>
        </div>
        <div class="theme-swatch" style="background:#C9A96E;">
          <div class="color-tooltip">金色：品牌强调 #C9A96E</div>
        </div>
        <div class="theme-swatch" style="background:#1A1714;">
          <div class="color-tooltip">文字：带暖调深黑 #1A1714</div>
        </div>
      </div>
    </div>
    <div class="theme-block">
      <div class="theme-name">夜宴（暗色）</div>
      <div class="theme-swatches">
        <div class="theme-swatch" style="background:#1A1B1E;">
          <div class="color-tooltip">背景：暖调深黑 #1A1B1E</div>
        </div>
        <div class="theme-swatch" style="background:#D4B878;">
          <div class="color-tooltip">金色：暗色下提亮 #D4B878</div>
        </div>
        <div class="theme-swatch" style="background:#7DB8DD;">
          <div class="color-tooltip">蓝色：暗色下提亮 #7DB8DD</div>
        </div>
        <div class="theme-swatch" style="background:#E8E6E3;">
          <div class="color-tooltip">文字：暖白高可读 #E8E6E3</div>
        </div>
      </div>
    </div>
  </div>
</div>

---

## 原则四：图标统一，可控胜过丰富

设计规范中有两条明确的图标规则：

```
❌ 不允许使用 emoji 作为按钮图标
✅ 必须使用 SVG 图标（Lucide 图标集）
✅ 直接下载 Lucide 图标，本地使用，不依赖 CDN
```

为什么 Emoji 不行？三个原因：

**第一，渲染不可控。** Emoji 是系统字体渲染的，同一个 Emoji 在 macOS、Windows、Android 上显示效果完全不同，同一平台的不同版本也可能不同。对追求一致性的设计体系而言，不可控性不可接受。

**第二，情绪语义固定。** 📖 不只是一个书本图形，它携带着轻松、卡通、随意的平台情感色彩。当产品调性是精致、高级、有文化感时，Emoji 的情绪语义与此不符。

**第三，无法跟随设计系统变化。** SVG 图标可以精确控制颜色、大小、描边粗细，可以在 hover/active/disabled 状态下精确切换样式。Emoji 做不到，它永远是那个颜色，那个大小，那种风格。

图标本地化（不依赖 CDN）解决的是稳定性问题：CDN 可能失效，图标可能在界面加载后才渐渐出现。对于追求质感的产品，图标的加载时机是非常敏感的，高级感不只是好看，还要稳定、可靠、不出错。

<style>
.demo-block-p4 {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  background: #fafaf7;
  border-radius: 12px;
  padding: 24px;
  margin: 24px 0;
}
.demo-block-p4 .demo-title {
  font-size: 13px;
  color: #8B7355;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.demo-block-p4 .compare-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.demo-block-p4 .compare-col {
  flex: 1;
  min-width: 200px;
}
.demo-block-p4 .col-header {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  margin-bottom: 14px;
  display: inline-block;
}
.demo-block-p4 .header-bad {
  background: #fde8e8;
  color: #c0392b;
}
.demo-block-p4 .header-good {
  background: #e8f5e9;
  color: #2e7d32;
}
.demo-block-p4 .icon-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.demo-block-p4 .icon-item {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid #e8e4dc;
  border-radius: 7px;
  padding: 9px 14px;
}
.demo-block-p4 .icon-emoji {
  font-size: 18px;
  width: 24px;
  text-align: center;
}
.demo-block-p4 .icon-svg {
  width: 18px;
  height: 18px;
  color: #8B7355;
  flex-shrink: 0;
}
.demo-block-p4 .icon-label {
  font-size: 13px;
  color: #1A1714;
}
.demo-block-p4 .col-note {
  font-size: 11px;
  color: #a09890;
  margin-top: 10px;
  line-height: 1.5;
}
</style>

<div class="demo-block-p4">
  <div class="demo-title">Emoji vs SVG：可控性对比</div>
  <div class="compare-row">
    <div class="compare-col">
      <div class="col-header header-bad">✗ Emoji 图标</div>
      <div class="icon-row">
        <div class="icon-item">
          <span class="icon-emoji">📖</span>
          <span class="icon-label">阅读</span>
        </div>
        <div class="icon-item">
          <span class="icon-emoji">📋</span>
          <span class="icon-label">笔记</span>
        </div>
        <div class="icon-item">
          <span class="icon-emoji">🔍</span>
          <span class="icon-label">搜索</span>
        </div>
        <div class="icon-item">
          <span class="icon-emoji">💬</span>
          <span class="icon-label">对话</span>
        </div>
        <div class="icon-item">
          <span class="icon-emoji">⚙️</span>
          <span class="icon-label">设置</span>
        </div>
      </div>
      <div class="col-note">系统字体渲染，不可控；情绪语义固定；无法跟随设计系统变化颜色与粗细</div>
    </div>
    <div class="compare-col">
      <div class="col-header header-good">✓ SVG 线条图标（Lucide 风格）</div>
      <div class="icon-row">
        <div class="icon-item">
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <span class="icon-label">阅读</span>
        </div>
        <div class="icon-item">
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
          </svg>
          <span class="icon-label">笔记</span>
        </div>
        <div class="icon-item">
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span class="icon-label">搜索</span>
        </div>
        <div class="icon-item">
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span class="icon-label">对话</span>
        </div>
        <div class="icon-item">
          <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
          </svg>
          <span class="icon-label">设置</span>
        </div>
      </div>
      <div class="col-note">可精确控制颜色、描边粗细；随主题切换；本地化，不依赖 CDN，加载稳定</div>
    </div>
  </div>
</div>

---

## 原则五：信息分层，只展示应该被看到的

普通用户不需要看到 AI 的内部运作，这不是藏着掖着，而是保护体验。

Alice 的信息分层体系：

- **普通用户层**：只看到 Alice 的内容输出（朋友圈、读书笔记、思绪），一个活生生的人的行为结果
- **Debug 用户层**：可以看到事件流、日志、系统日程，AI 的内部机制
- **开发者模式**：需要特定的隐藏操作才能激活

为什么要这样分层？当算法、数据来源和内部状态直接挤进普通界面时，用户会被实现细节打断，难以保持对任务与内容的专注。Debug 模式承担后台通道职责，只向主动查看技术细节的用户开放。

这在娱乐产业中有悠久传统：演员在舞台上扮演角色，观众不应该看到后台的布景搭建和剧本。

**费用信息的特殊处理**：token 消耗、API 成本，这些技术性信息对普通用户而言是噪音，会引发不必要的焦虑。隐藏在 debug 模式下，让普通用户专注于内容体验本身。

> **核心逻辑**：用户的注意力是稀缺资源，界面设计者有责任保护这个资源，不让无关信息消耗它。每一个不必要展示的信息，都是对用户注意力的一次消耗。

---

## 原则六：流式即时，拒绝突然出现

AI 响应的流式渲染不是技术选项，而是产品哲学：**用户不应该等待。**

一个关键的设计细节：识别到工具名，前端就可以渲染卡片，不应该等到整个工具调用完成再展示。

当 AI 的流式 token 中出现了工具调用的名字，前端就应该立刻渲染出对应的工具卡片。用户看到卡片出现、代码在滚动输出、工具在逐一完成，整个过程是连续的、可见的、有节奏的，而不是一个长时间的等待后突然全部出现。

为什么流式渲染如此重要？**人类的对话是实时的，AI 的对话也应该是实时的。** 当 AI 的响应逐字显示，用户的体验是在听她说话；当响应突然整段出现，用户的感受是在收到机器打印的输出。这两种状态的心理感受，是活人感与机器感之间的核心差异。

主动呈现的等待过程不是等待，而是一种参与感。用户在看着内容逐步生成的时候，不是在等，而是在看。

<style>
.demo-block-p6 {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  background: #fafaf7;
  border-radius: 12px;
  padding: 24px;
  margin: 24px 0;
}
.demo-block-p6 .demo-title {
  font-size: 13px;
  color: #8B7355;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.demo-block-p6 .compare-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.demo-block-p6 .compare-col {
  flex: 1;
  min-width: 200px;
}
.demo-block-p6 .col-label {
  font-size: 12px;
  font-weight: 600;
  color: #5a5450;
  margin-bottom: 10px;
}
.demo-block-p6 .send-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 6px;
  border: none;
  background: #8B7355;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  margin-bottom: 12px;
  transition: background 0.15s, opacity 0.15s;
}
.demo-block-p6 .send-btn:hover {
  background: #7a6348;
}
.demo-block-p6 .send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.demo-block-p6 .chat-box {
  background: #fff;
  border: 1px solid #e8e4dc;
  border-radius: 8px;
  padding: 14px;
  min-height: 110px;
  font-size: 13px;
  color: #1A1714;
  line-height: 1.6;
}
.demo-block-p6 .tool-card {
  display: none;
  background: #f3f0ea;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: #8B7355;
  margin-bottom: 8px;
  align-items: center;
  gap: 6px;
}
.demo-block-p6 .tool-card.visible {
  display: flex;
}
.demo-block-p6 .spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #e8e4dc;
  border-top-color: #8B7355;
  border-radius: 50%;
  animation: spin6 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin6 {
  to { transform: rotate(360deg); }
}
.demo-block-p6 .stream-text {
  color: #1A1714;
}
.demo-block-p6 .cursor-blink {
  display: inline-block;
  width: 2px;
  height: 14px;
  background: #8B7355;
  margin-left: 1px;
  vertical-align: middle;
  animation: blink6 0.8s ease infinite;
}
@keyframes blink6 {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.demo-block-p6 .note-tag {
  display: inline-block;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 3px;
  margin-top: 8px;
}
.demo-block-p6 .note-bad {
  background: #fde8e8;
  color: #c0392b;
}
.demo-block-p6 .note-good {
  background: #e8f5e9;
  color: #2e7d32;
}
.demo-block-p6 .reset-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid #e8e4dc;
  background: transparent;
  font-size: 11px;
  color: #8B7355;
  cursor: pointer;
  font-family: inherit;
  margin-left: 8px;
  transition: background 0.15s;
}
.demo-block-p6 .reset-btn:hover {
  background: #f3f0ea;
}
</style>

<div class="demo-block-p6">
  <div class="demo-title">流式渲染 vs 非流式：两种等待体验</div>
  <div class="compare-row">
    <div class="compare-col">
      <div class="col-label">非流式输出（延迟 2s 整段出现）</div>
      <div>
        <button class="send-btn" id="batchSendBtn" onclick="startBatch()">发送</button>
        <button class="reset-btn" onclick="resetBatch()">重置</button>
      </div>
      <div class="chat-box" id="batchBox">
        <span id="batchText"></span>
        <span id="batchLoader" style="display:none; color:#a09890; font-size:12px;">等待响应中…</span>
      </div>
      <div class="note-tag note-bad">空白等待 2 秒，内容突然整段出现，机器感强烈</div>
    </div>
    <div class="compare-col">
      <div class="col-label">流式输出</div>
      <div>
        <button class="send-btn" id="streamSendBtn" onclick="startStream()">发送</button>
        <button class="reset-btn" onclick="resetStream()">重置</button>
      </div>
      <div class="chat-box" id="streamBox">
        <div class="tool-card" id="streamToolCard">
          <div class="spinner"></div>
          <span>正在搜索最近阅读记录…</span>
        </div>
        <span class="stream-text" id="streamText"></span><span class="cursor-blink" id="streamCursor" style="display:none;"></span>
      </div>
      <div class="note-tag note-good">工具卡片即时出现，文字逐字打出，用户全程参与</div>
    </div>
  </div>
</div>

<script>
(function() {
  var fullText = '今天翻完了《枪炮、病菌与钢铁》，戴蒙德的核心论点其实很简单：地理决定了哪个族群能驯化哪些动植物，进而决定了文明的走向。历史不是少数人的胜利，是大陆形状的胜利。';
  var streamTimer = null;
  var streamRunning = false;

  window.startStream = function() {
    if (streamRunning) return;
    streamRunning = true;
    document.getElementById('streamSendBtn').disabled = true;
    var toolCard = document.getElementById('streamToolCard');
    var textEl = document.getElementById('streamText');
    var cursor = document.getElementById('streamCursor');
    toolCard.classList.add('visible');
    cursor.style.display = 'inline-block';
    var i = 0;
    setTimeout(function() {
      toolCard.classList.remove('visible');
      streamTimer = setInterval(function() {
        if (i < fullText.length) {
          textEl.textContent += fullText[i];
          i++;
        } else {
          clearInterval(streamTimer);
          cursor.style.display = 'none';
        }
      }, 40);
    }, 900);
  };

  window.resetStream = function() {
    if (streamTimer) clearInterval(streamTimer);
    streamRunning = false;
    document.getElementById('streamSendBtn').disabled = false;
    document.getElementById('streamToolCard').classList.remove('visible');
    document.getElementById('streamText').textContent = '';
    document.getElementById('streamCursor').style.display = 'none';
  };

  window.startBatch = function() {
    var btn = document.getElementById('batchSendBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    var loader = document.getElementById('batchLoader');
    var textEl = document.getElementById('batchText');
    loader.style.display = 'inline';
    setTimeout(function() {
      loader.style.display = 'none';
      textEl.textContent = fullText;
      btn.disabled = false;
    }, 2000);
  };

  window.resetBatch = function() {
    document.getElementById('batchSendBtn').disabled = false;
    document.getElementById('batchText').textContent = '';
    document.getElementById('batchLoader').style.display = 'none';
  };
})();
</script>

---

## 原则七：视觉边界完整

**应用内部解决所有交互**

应用内不应该出现任何系统级弹窗。

系统级弹窗（Alert / Confirm / MessageBox）打破了应用的视觉边界。系统级弹窗是操作系统渲染的，不是应用渲染的。它有不同的字体、不同的按钮样式、不同的弹出动效，这一切都在告诉用户你暂时离开了 Alice 的世界，进入了操作系统的世界。

对追求沉浸式体验的桌面 AI 助理而言，这种视觉边界的破裂会直接破坏界面一致性。

当系统的限制使得动效和不触发系统弹窗不能同时存在时，宁愿放弃动效，也要保持应用的视觉边界完整性。这个取舍的优先级是明确的。

<style>
.demo-block-p7 {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  background: #fafaf7;
  border-radius: 12px;
  padding: 24px;
  margin: 24px 0;
  border: 1px solid #e8e4dc;
}
.demo-block-p7 .demo-title {
  font-size: 13px;
  color: #8B7355;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 20px;
}
.demo-block-p7 .compare-row {
  display: flex;
  gap: 20px;
}
.demo-block-p7 .compare-col {
  flex: 1;
  min-width: 0;
}
.demo-block-p7 .col-label {
  font-size: 11px;
  font-weight: 600;
  color: #a09890;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 10px;
}
.demo-block-p7 .mock-app {
  background: #f5f3ee;
  border-radius: 10px;
  border: 1px solid #e8e4dc;
  height: 180px;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  padding: 12px;
}
.demo-block-p7 .mock-titlebar {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 32px;
  background: #eae8e3;
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 6px;
  border-radius: 10px 10px 0 0;
}
.demo-block-p7 .traffic-dot {
  width: 10px; height: 10px; border-radius: 50%;
}
.demo-block-p7 .mock-content {
  position: absolute;
  top: 32px; left: 0; right: 0; bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #6B6460;
}
.demo-block-p7 .trigger-btn {
  display: inline-block;
  padding: 6px 14px;
  background: #1A1714;
  color: #fafaf7;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  border: none;
  font-family: inherit;
  transition: opacity 0.15s;
}
.demo-block-p7 .trigger-btn:hover { opacity: 0.8; }
/* 系统弹窗模拟 */
.demo-block-p7 .sys-dialog {
  display: none;
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  background: #f0f0f0;
  border: 1px solid #c0c0c0;
  border-radius: 4px;
  padding: 20px 24px 16px;
  width: 200px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  z-index: 10;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}
.demo-block-p7 .sys-dialog.visible { display: block; }
.demo-block-p7 .sys-dialog-title {
  font-size: 13px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 6px;
}
.demo-block-p7 .sys-dialog-msg {
  font-size: 11px;
  color: #555;
  margin-bottom: 14px;
  line-height: 1.4;
}
.demo-block-p7 .sys-dialog-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.demo-block-p7 .sys-btn {
  padding: 3px 12px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid #c0c0c0;
  background: #e8e8e8;
  cursor: pointer;
  font-family: -apple-system, sans-serif;
}
.demo-block-p7 .sys-btn-primary {
  background: #0066cc;
  color: #fff;
  border-color: #0066cc;
}
/* Toast 模拟 */
.demo-block-p7 .app-toast {
  display: none;
  position: absolute;
  bottom: 16px; left: 50%;
  transform: translateX(-50%) translateY(10px);
  background: rgba(26,23,20,0.88);
  color: #fafaf7;
  font-size: 12px;
  padding: 7px 16px;
  border-radius: 20px;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.25s, transform 0.25s;
}
.demo-block-p7 .app-toast.visible {
  display: block;
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.demo-block-p7 .note-tag {
  display: inline-block;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 3px;
  margin-top: 10px;
}
.demo-block-p7 .note-bad { background: #fde8e8; color: #c0392b; }
.demo-block-p7 .note-good { background: #e8f5e9; color: #2e7d32; }
@media (max-width: 600px) {
  .demo-block-p7 .compare-row { flex-direction: column; }
}
</style>

<div class="demo-block-p7">
  <div class="demo-title">系统弹窗 vs 应用内 Toast：视觉边界对比</div>
  <div class="compare-row">
    <div class="compare-col">
      <div class="col-label">系统级弹窗（❌ 破坏边界）</div>
      <div class="mock-app">
        <div class="mock-titlebar">
          <div class="traffic-dot" style="background:#ff5f57;"></div>
          <div class="traffic-dot" style="background:#febc2e;"></div>
          <div class="traffic-dot" style="background:#28c840;"></div>
        </div>
        <div class="mock-content">
          <button class="trigger-btn" id="sysDialogBtn" onclick="showSysDialog()">删除记录</button>
        </div>
        <div class="sys-dialog" id="sysDialog">
          <div class="sys-dialog-title">确认</div>
          <div class="sys-dialog-msg">确定要删除这条记录吗？此操作无法撤销。</div>
          <div class="sys-dialog-btns">
            <button class="sys-btn" onclick="hideSysDialog()">取消</button>
            <button class="sys-btn sys-btn-primary" onclick="hideSysDialog()">确定</button>
          </div>
        </div>
      </div>
      <div class="note-tag note-bad">字体、按钮、动效全变，瞬间「出戏」</div>
    </div>
    <div class="compare-col">
      <div class="col-label">应用内 Toast（✅ 边界完整）</div>
      <div class="mock-app">
        <div class="mock-titlebar">
          <div class="traffic-dot" style="background:#ff5f57;"></div>
          <div class="traffic-dot" style="background:#febc2e;"></div>
          <div class="traffic-dot" style="background:#28c840;"></div>
        </div>
        <div class="mock-content">
          <button class="trigger-btn" id="toastBtn" onclick="showToast()">删除记录</button>
        </div>
        <div class="app-toast" id="appToast">✓ 已删除</div>
      </div>
      <div class="note-tag note-good">始终在应用视觉体系内，用户未曾离开</div>
    </div>
  </div>
</div>

<script>
(function() {
  window.showSysDialog = function() {
    document.getElementById('sysDialog').classList.add('visible');
  };
  window.hideSysDialog = function() {
    document.getElementById('sysDialog').classList.remove('visible');
  };
  window.showToast = function() {
    var toast = document.getElementById('appToast');
    var btn = document.getElementById('toastBtn');
    btn.disabled = true;
    toast.classList.add('visible');
    setTimeout(function() {
      toast.classList.remove('visible');
      setTimeout(function() { btn.disabled = false; }, 300);
    }, 1800);
  };
})();
</script>

---

## 反面教材总结

以上七条原则都源于真实的设计决策，归纳出五条被明确拒绝过的设计模式：

<style>
.ap-block { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; margin: 16px 0; border: 1px solid #e8e4dc; border-radius: 12px; overflow: hidden; background: #fafaf7; }
.ap-block-header { display: flex; align-items: center; gap: 12px; padding: 14px 18px 10px; }
.ap-block-num { font-size: 11px; font-weight: 700; color: #C9A96E; letter-spacing: 0.08em; }
.ap-block-title { font-size: 14px; font-weight: 700; color: #1A1714; }
.ap-block-desc { font-size: 12px; color: #6B6460; line-height: 1.5; padding: 0 18px 12px; }
.ap-block-demo { display: flex; gap: 0; border-top: 1px solid #e8e4dc; }
.ap-block-col { flex: 1; padding: 14px 16px; min-width: 0; }
.ap-block-col.col-bad { background: #fffafa; border-right: 1px solid #f0e8e8; }
.ap-block-col.col-good { background: #f9fcf9; }
.ap-block-col-label { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; margin-bottom: 8px; }
.ap-block-col-label.bad { color: #c0392b; }
.ap-block-col-label.good { color: #27ae60; }
/* 规律一 */
.ap1-list { border-radius: 7px; overflow: hidden; border: 1px solid #e8e4dc; }
.ap1-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #fff; border-bottom: 1px solid #f0ede8; font-size: 12px; color: #1A1714; }
.ap1-item:last-child { border-bottom: none; }
.ap1-dot { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; flex-shrink: 0; }
/* 规律二 */
.ap2-row { display: flex; flex-direction: column; gap: 5px; }
.ap2-item { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; background: #fff; border: 1px solid #e8e4dc; border-radius: 6px; font-size: 11px; color: #1A1714; }
.ap2-badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
/* 规律三 */
.ap3-panel { border: 1px solid #e8e4dc; border-radius: 7px; overflow: hidden; background: #fff; }
.ap3-header { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; font-size: 12px; font-weight: 600; color: #1A1714; cursor: pointer; background: #f3f0ea; }
.ap3-items-hard { display: none; }
.ap3-items-hard.open { display: block; }
.ap3-items-smooth { max-height: 0; overflow: hidden; transition: max-height 0.3s ease, opacity 0.3s ease; opacity: 0; }
.ap3-items-smooth.open { max-height: 200px; opacity: 1; }
.ap3-sub { padding: 7px 12px; font-size: 11px; color: #1A1714; border-top: 1px solid #f0ede8; }
/* 规律四 */
.ap4-tight { display: flex; flex-direction: column; gap: 0; }
.ap4-tight-item { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 11px; color: #1A1714; line-height: 1.3; }
.ap4-tight-dot { width: 4px; height: 4px; border-radius: 50%; background: #a09890; flex-shrink: 0; }
.ap4-airy { display: flex; flex-direction: column; gap: 10px; }
.ap4-airy-item { padding: 8px 12px; background: #fff; border: 1px solid #e8e4dc; border-radius: 7px; }
.ap4-airy-title { font-size: 12px; font-weight: 600; color: #1A1714; margin-bottom: 2px; }
.ap4-airy-meta { font-size: 10px; color: #a09890; }
/* 规律五 */
.ap5-nav { border: 1px solid #e8e4dc; border-radius: 7px; overflow: hidden; background: #fff; }
.ap5-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid #f0ede8; font-size: 12px; color: #1A1714; }
.ap5-item:last-child { border-bottom: none; }
.ap5-emoji { font-size: 16px; width: 22px; text-align: center; }
.ap5-svg-box { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: #f3f0ea; border-radius: 5px; flex-shrink: 0; }
.ap5-svg-box svg { width: 13px; height: 13px; stroke: #6B6460; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
@media (max-width: 600px) { .ap-block-demo { flex-direction: column; } .ap-block-col.col-bad { border-right: none; border-bottom: 1px solid #f0e8e8; } }
</style>

<!-- 规律一 -->
<div class="ap-block">
  <div class="ap-block-header"><span class="ap-block-num">规律一</span><span class="ap-block-title">反对贴标签式设计</span></div>
  <div class="ap-block-desc">外加的标记不是从内容结构中自然生长的元素。层次只应在排版本身中显现，而不是靠外部符号来标注。</div>
  <div class="ap-block-demo">
    <div class="ap-block-col col-bad">
      <div class="ap-block-col-label bad">❌ 竖线贴标签</div>
      <div class="ap1-list">
        <div class="ap1-item" style="border-left:3px solid #C9A96E;"><div class="ap1-dot" style="background:#c4b49a;">A</div> Alice — 今天天气真好…</div>
        <div class="ap1-item" style="border-left:3px solid #8B7355;"><div class="ap1-dot" style="background:#8B7355;">妈</div> 妈妈 — 记得早点回来</div>
        <div class="ap1-item" style="border-left:3px solid #6B6460;"><div class="ap1-dot" style="background:#6B6460;">W</div> 工作群 — 下午三点开会</div>
      </div>
    </div>
    <div class="ap-block-col col-good">
      <div class="ap-block-col-label good">✅ 颜色+未读自显层次</div>
      <div class="ap1-list">
        <div class="ap1-item"><div class="ap1-dot" style="background:#c4b49a;">A</div><span style="flex:1;font-weight:500;">Alice — 今天天气真好…</span><span style="width:7px;height:7px;border-radius:50%;background:#C9A96E;display:block;"></span></div>
        <div class="ap1-item"><div class="ap1-dot" style="background:#8B7355;">妈</div> 妈妈 — 记得早点回来</div>
        <div class="ap1-item" style="opacity:0.55;"><div class="ap1-dot" style="background:#6B6460;">W</div> 工作群 — 下午三点开会</div>
      </div>
    </div>
  </div>
</div>

<!-- 规律二 -->
<div class="ap-block">
  <div class="ap-block-header"><span class="ap-block-num">规律二</span><span class="ap-block-title">反对视觉噪音</span></div>
  <div class="ap-block-desc">多套相近颜色并存，认知负担极高。每种颜色应当有唯一含义，不混淆。</div>
  <div class="ap-block-demo">
    <div class="ap-block-col col-bad">
      <div class="ap-block-col-label bad">❌ 多套橙色，语义混乱</div>
      <div class="ap2-row">
        <div class="ap2-item">完成读书笔记 <span class="ap2-badge" style="background:#FF6B35;color:#fff;">重要</span></div>
        <div class="ap2-item">下午视频会议 <span class="ap2-badge" style="background:#FF8C42;color:#fff;">提醒</span></div>
        <div class="ap2-item">给妈妈买礼物 <span class="ap2-badge" style="background:#FFA552;color:#fff;">待办</span></div>
        <div class="ap2-item">跑步 5 公里 <span class="ap2-badge" style="background:#FFB347;color:#fff;">进行中</span></div>
      </div>
    </div>
    <div class="ap-block-col col-good">
      <div class="ap-block-col-label good">✅ 一种金色，语义唯一</div>
      <div class="ap2-row">
        <div class="ap2-item">完成读书笔记 <span class="ap2-badge" style="background:#FDF3E3;color:#8B6914;border:1px solid #e8d5a3;">重要</span></div>
        <div class="ap2-item">下午视频会议 <span class="ap2-badge" style="background:#f3f0ea;color:#6B6460;border:1px solid #e8e4dc;">提醒</span></div>
        <div class="ap2-item">给妈妈买礼物 <span class="ap2-badge" style="background:#f3f0ea;color:#6B6460;border:1px solid #e8e4dc;">待办</span></div>
        <div class="ap2-item">跑步 5 公里 <span class="ap2-badge" style="background:#f3f0ea;color:#6B6460;border:1px solid #e8e4dc;">进行中</span></div>
      </div>
    </div>
  </div>
</div>

<!-- 规律三 -->
<div class="ap-block">
  <div class="ap-block-header"><span class="ap-block-num">规律三</span><span class="ap-block-title">反对突然发生</span></div>
  <div class="ap-block-desc">硬切是对时间连续性的破坏。状态变化应有过渡，让大脑感知到空间的连续移动，而不是画面切换。</div>
  <div class="ap-block-demo">
    <div class="ap-block-col col-bad">
      <div class="ap-block-col-label bad">❌ 硬切（无动效）</div>
      <div class="ap3-panel">
        <div class="ap3-header" onclick="(function(el){var it=el.parentNode.querySelector('.ap3-items-hard');it.classList.toggle('open');el.querySelector('span:last-child').textContent=it.classList.contains('open')?'▼':'▶';})(this)"><span>最近阅读</span><span>▶</span></div>
        <div class="ap3-items-hard">
          <div class="ap3-sub">《置身事内》— 兰小欢</div>
          <div class="ap3-sub">《万历十五年》— 黄仁宇</div>
          <div class="ap3-sub">《人类简史》— 尤瓦尔·赫拉利</div>
        </div>
      </div>
    </div>
    <div class="ap-block-col col-good">
      <div class="ap-block-col-label good">✅ 300ms 平滑展开</div>
      <div class="ap3-panel">
        <div class="ap3-header" onclick="(function(el){var it=el.parentNode.querySelector('.ap3-items-smooth');it.classList.toggle('open');el.querySelector('span:last-child').textContent=it.classList.contains('open')?'▼':'▶';})(this)"><span>最近阅读</span><span>▶</span></div>
        <div class="ap3-items-smooth">
          <div class="ap3-sub">《置身事内》— 兰小欢</div>
          <div class="ap3-sub">《万历十五年》— 黄仁宇</div>
          <div class="ap3-sub">《人类简史》— 尤瓦尔·赫拉利</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- 规律四 -->
<div class="ap-block">
  <div class="ap-block-header"><span class="ap-block-num">规律四</span><span class="ap-block-title">反对小家子气</span></div>
  <div class="ap-block-desc">局促拥挤让信息感觉廉价。留白是让内容各自呼吸的空间，不是浪费。</div>
  <div class="ap-block-demo">
    <div class="ap-block-col col-bad">
      <div class="ap-block-col-label bad">❌ 过度紧凑，无留白</div>
      <div class="ap4-tight">
        <div class="ap4-tight-item"><div class="ap4-tight-dot"></div>今天读了《枪炮》第三章</div>
        <div class="ap4-tight-item"><div class="ap4-tight-dot"></div>和朋友通话了两小时</div>
        <div class="ap4-tight-item"><div class="ap4-tight-dot"></div>跑步5公里完成今日目标</div>
        <div class="ap4-tight-item"><div class="ap4-tight-dot"></div>整理工作邮件回复了三封</div>
      </div>
    </div>
    <div class="ap-block-col col-good">
      <div class="ap-block-col-label good">✅ 充分留白，层次清晰</div>
      <div class="ap4-airy">
        <div class="ap4-airy-item"><div class="ap4-airy-title">今天读了《枪炮》第三章</div><div class="ap4-airy-meta">下午 3:00 · 阅读</div></div>
        <div class="ap4-airy-item"><div class="ap4-airy-title">和朋友通话了两小时</div><div class="ap4-airy-meta">下午 5:30 · 社交</div></div>
        <div class="ap4-airy-item"><div class="ap4-airy-title">跑步 5 公里</div><div class="ap4-airy-meta">早上 7:00 · 运动</div></div>
      </div>
    </div>
  </div>
</div>

<!-- 规律五 -->
<div class="ap-block">
  <div class="ap-block-header"><span class="ap-block-num">规律五</span><span class="ap-block-title">反对不可控</span></div>
  <div class="ap-block-desc">Emoji 由操作系统渲染，在不同设备上字形、尺寸、色彩各异，无法控制。SVG 图标本地部署，像素级可控。</div>
  <div class="ap-block-demo">
    <div class="ap-block-col col-bad">
      <div class="ap-block-col-label bad">❌ Emoji 图标（系统渲染，不可控）</div>
      <div class="ap5-nav">
        <div class="ap5-item"><span class="ap5-emoji">📖</span> 阅读</div>
        <div class="ap5-item"><span class="ap5-emoji">📋</span> 笔记</div>
        <div class="ap5-item"><span class="ap5-emoji">🔍</span> 搜索</div>
        <div class="ap5-item"><span class="ap5-emoji">💬</span> 对话</div>
        <div class="ap5-item"><span class="ap5-emoji">⚙️</span> 设置</div>
      </div>
    </div>
    <div class="ap-block-col col-good">
      <div class="ap-block-col-label good">✅ SVG 图标（本地部署，精准可控）</div>
      <div class="ap5-nav">
        <div class="ap5-item"><div class="ap5-svg-box"><svg viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></div> 阅读</div>
        <div class="ap5-item"><div class="ap5-svg-box"><svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg></div> 笔记</div>
        <div class="ap5-item"><div class="ap5-svg-box"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div> 搜索</div>
        <div class="ap5-item"><div class="ap5-svg-box"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div> 对话</div>
        <div class="ap5-item"><div class="ap5-svg-box"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div> 设置</div>
      </div>
    </div>
  </div>
</div>

---

## 核心公理

七条公理是以上所有原则的浓缩提炼。

<style>
.axiom-block {
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  margin: 20px 0;
  border: 1px solid #e8e4dc;
  border-radius: 12px;
  overflow: hidden;
  background: #fafaf7;
}
.axiom-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
}
.axiom-index {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  background: #1A1714;
  color: #fafaf7;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
}
.axiom-title-block { flex: 1; }
.axiom-name {
  font-size: 14px;
  font-weight: 700;
  color: #1A1714;
  margin-bottom: 3px;
}
.axiom-desc {
  font-size: 12px;
  color: #6B6460;
  line-height: 1.55;
}
</style>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">一</div>
    <div class="axiom-title-block">
      <div class="axiom-name">结构自显，拒绝贴标签</div>
      <div class="axiom-desc">层次结构应从内容的排版、颜色和位置中自然显现，而非依靠外加的边框、竖线或分隔线来标注。</div>
    </div>
  </div>
</div>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">二</div>
    <div class="axiom-title-block">
      <div class="axiom-name">时间连续，任何切换都不应硬来</div>
      <div class="axiom-desc">任何状态变化都应当有过渡动效。硬切是对时间连续性的破坏，是界面从活的变成死的的标志。</div>
    </div>
  </div>
</div>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">三</div>
    <div class="axiom-title-block">
      <div class="axiom-name">颜色是语义，不是装饰</div>
      <div class="axiom-desc">全局颜色种类尽可能少，每种颜色有明确且唯一的含义，不允许多套相近颜色并存。</div>
    </div>
  </div>
</div>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">四</div>
    <div class="axiom-title-block">
      <div class="axiom-name">信息分层，只展示应该被看到的</div>
      <div class="axiom-desc">不同层次的用户看到不同复杂度的信息。保护用户的注意力，就是保护用户的体验。</div>
    </div>
  </div>
</div>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">五</div>
    <div class="axiom-title-block">
      <div class="axiom-name">流式即时，拒绝突然出现</div>
      <div class="axiom-desc">AI 的响应应当尽可能早地开始呈现，识别到工具名就渲染卡片，有流式 token 就即时显示。</div>
    </div>
  </div>
</div>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">六</div>
    <div class="axiom-title-block">
      <div class="axiom-name">视觉边界完整，应用内部解决所有交互</div>
      <div class="axiom-desc">不允许出现任何系统级弹窗，所有确认 / 提示 / 反馈都在应用的视觉体系内完成。</div>
    </div>
  </div>
</div>

<div class="axiom-block">
  <div class="axiom-header">
    <div class="axiom-index">七</div>
    <div class="axiom-title-block">
      <div class="axiom-name">图标统一，可控胜过丰富</div>
      <div class="axiom-desc">使用单一来源的 SVG 图标集，本地化部署。Emoji 作为图标使用被明确禁止。</div>
    </div>
  </div>
</div>

---

## 结语：质感是说不上来的舒服

这套 UI/UX 哲学，本质上是**有信仰的克制**。

对竖线的拒绝，对硬切的不容，对系统弹窗的排斥，对多套橙色的整顿，这些看似是对具体设计问题的具体反应，放在一起，它们描绘出一个完整而一致的审美信仰：

**界面是一个有时间维度的空间，不是一组静态画面。**
**元素应当从结构中自然生长，不靠标签标注。**
**颜色是语义，不是情绪。**
**动效是时间的语言，不是视觉特技。**
**信息应当被守门，而不是全部暴露。**

质感不是精美，不是华丽，不是五彩缤纷。质感是精准，每一个像素都有它存在的理由，没有一条线是多余的，没有一种颜色是随意的，没有一次切换是突然的。

当一个用户打开 Alice，他们或许不会意识到这些设计决策。他们只会有一种模糊的感受：这个产品很舒服，用着顺，看着对。这种说不上来为什么的舒服，正是所有这些设计公理在默默发挥作用的结果。
