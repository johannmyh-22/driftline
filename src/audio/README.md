# src/audio

Web Audio API 程序化合成。**不放任何音频文件** —— 引擎音、气流、撞击、UI 音
全部由振荡器与包络生成。

- `context.ts` —— 唯一的 `AudioContext`/主音量总线(`AudioBus`),音量与
  静音存 localStorage。
- `engine.ts` —— 引擎音:一个自定义谐波谱(`PeriodicWave`)的振荡器 + 一层
  窄带噪声,过随「转速代理」调制的滤波器。**厚度靠谐波堆叠,不靠失谐叠加**
  ——两个频率相近的振荡器会产生拍频,人耳听成颤音,详见类注释。
- `wind.ts` —— 气流噪声:预生成白噪声循环(用注入的 `Rng`,不调
  `Math.random()`)过低通滤波器。
- `impact.ts` / `ui.ts` —— 撞墙音 / UI 点击音,事件驱动的一次性脉冲。撞墙音
  是两层:噪声「碎裂」走高通当主角,下滑的锯齿波「车身」走低通当配角。
- `director.ts` —— `AudioDirector`,`main.ts` 唯一直接接线的入口。

`?test=1` 下不构造 `AudioDirector`(没有真实用户手势,`AudioContext` 起不来),
和 `Hud`/`Menu` 同一套约定。数值都在 `game/tuning.ts` 的 `AUDIO` 段。
