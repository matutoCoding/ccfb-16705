# 玉雕透光与取料推演系统 (Jade Light Studio)

浏览器内的玉雕透光仿真与取料推演。TypeScript + WebGPU,渲染管线手写,原料与方案存 IndexedDB。

## 运行

```bash
npm install
npm run dev        # 开发,默认 http://localhost:5173
npm test           # Vitest 单元测试(15 项,含 Beer-Lambert 精度)
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 预览构建产物
```

需最新版 Chrome/Edge 并开启硬件加速(WebGPU)。无 GPU 环境下页面优雅降级,CPU 侧全部功能与精度校验仍可用。

## 六个页面

| 页面 | 功能 |
| --- | --- |
| 原料库 | 导入原石 OBJ 网格(体素化)、记录产地/颜色/油性/重量,每料挂多方案;内置三块测试料 |
| 内部结构 | 三轴切片逐层绘制绺裂/棉絮/杂色,登记绺裂面,导入简单体数据 JSON |
| 雕刻方案 | 布尔减料、浮雕、镂空;厚度色带实时显示,薄于下限报警;统计每条绺裂暴露面积 |
| 透光渲染 | 次表面散射 + Beer-Lambert 光程积分;手电背光/台灯侧光/环境光切换;渐进累加收敛 |
| 方案对比 | 2–3 方案同视角同灯光并排,对比损料率、剩余重量、绺裂暴露 |
| 设置 | 渐进渲染参数;CPU/GPU 双路 Beer-Lambert 精度校验;厚度翻倍指数衰减自检 |

## 三块测试料

1. **青白玉籽料 · 贯穿裂** — 一条蜿蜒贯穿上下的绺裂面
2. **糖白玉籽料 · 糖色皮** — 外壳糖色(杂色)带与向内沁入
3. **白玉籽料 · 大片棉** — 三团云片状棉絮

均为 96³ 体素、0.6mm/体素的确定性程序化生成(可复现)。

## 厚度→透光的精度保障(核心)

系统严格遵循 **Beer-Lambert 定律**:

```
T(d) = exp(-σ · d)
```

- 厚度翻倍 `d → 2d`,透射比 `T(2d)/T(d) = exp(-σ·d)`,数学上严格指数衰减。
- GPU 着色器(`traceMedium`)与 CPU 积分器(`integrateTransmission`)逐体素累加光学厚度 `τ = Σ(σA + σ缺陷)·Δl`,再取 `exp(-τ)`,与解析公式同构。
- 绺裂/棉絮/杂色以额外衰减系数叠加到光程,在透光下自然显现。
- **验证模式**关闭一切随机散射,GPU 对已知厚度板输出确定性 `exp(-σd)`,回读像素与解析值对比;设置页一键出误差报告。
- 单元测试锁死:解析透射误差、厚度翻倍误差(浮点级 ~1e-14%)、DDA 光程积分 < 5%。

> 说明:连续介质的解析真值用精确物理距离积分;体素 DDA 路径另测其工程量化误差。体素越小越精确,当前 0.6mm 体素在工程厚度区间内满足 < 5%。

## 架构

```
src/
  core/        纯数学/数据层(无 DOM、可单测)
    volume.ts        SDF、体素 DDA、Beer-Lambert、光程积分
    carve.ts         占据掩码布尔运算、厚度场、绺裂暴露
    marchingCubes.ts SDF → 三角网格
    stoneGenerator.ts 测试料程序化生成
    validation.ts    解析校验与厚度翻倍自检
    materials.ts     玉质光学参数库(σA/σS/IOR/密度)
    objImport.ts     OBJ 解析与网格体素化
    volumeImport.ts  简单体数据导入
    storage.ts       IndexedDB 封装
  render/      WebGPU 层
    shaders.ts       WGSL compute(路径/光程)+ present
    jadeRenderer.ts  纹理上传、渐进累加、预览/收敛调度、回读
    camera.ts        轨道相机与矩阵
    viewport.ts      canvas 交互封装
  pages/       六个页面
  export/      厚度热图 PNG / 打印
  state/ ui/   集中状态与 DOM 外壳
```

## 关键设计取舍

- **占据掩码为布尔运算唯一真值**:雕刻先改掩码再用 3-4-5 chamfer 距离变换重建 SDF,避免直接改距离场导致的符号/拓扑错误。
- **渐进渲染**:转视角时每帧低样本快速预览,静止后多 dispatch 累加到 `maxSamples`,时域平均降噪。
- **SDF 单位统一**:纹理存毫米,着色器采样后除以体素尺寸转回体素单位,保证步进、梯度、内外判定一致。
- **包围盒外解析距离**:相机在网格外时返回到包围盒的保守距离,避免纹理 clamp 造成的 sphere tracing 误判。
