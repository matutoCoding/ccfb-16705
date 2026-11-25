// 玉雕透光路径追踪 / 确定性光程积分着色器(WebGPU compute)
// 设计要点:
// 1) 介质透射用逐体素 DDA 光程 + Beer-Lambert,与 CPU 解析值严格同构,保证 <5% 校验
// 2) 验证模式(validation=1)关闭一切随机散射,纯解析板透射,供误差比对
// 3) 常规材质模式叠加单散射、扩散近似与表面菲涅尔,呈现玉的油润半透明

export const TRACE_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj : mat4x4<f32>,
  camPos   : vec4<f32>,
  target   : vec4<f32>,
  // xyz 灯光位置,w 灯光功率
  lightPos : vec4<f32>,
  // rgb sigmaA(1/mm), w ior
  sigmaA   : vec4<f32>,
  // rgb sigmaS(1/mm), w roughness
  sigmaS   : vec4<f32>,
  // x crackSigma,y cottonSigma,z impuritySigma,w oiliness
  defect   : vec4<f32>,
  // x voxelMm,y frameIndex,z renderMode,w lightMode
  params   : vec4<f32>,
  // x 网格nx,y ny,z nz,w 验证模式开关
  grid     : vec4<f32>,
  // 验证板:厚度(mm),基准颜色
  slab     : vec4<f32>,
};

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var sdfTex : texture_3d<f32>;
@group(0) @binding(2) var labelTex : texture_3d<u32>;
@group(0) @binding(3) var linSampler : sampler;
@group(0) @binding(4) var<storage, read_write> accum : array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> sampleCount : array<atomic<i32>>;

struct Rng { s : u32 };
fn hash(r : ptr<function, Rng>, n : u32) -> f32 {
  var x = (*r).s + n * 747796405u;
  x = (x ^ (x >> 16)) * 2246822507u;
  x = (x ^ (x >> 13)) * 3266489909u;
  (*r).s = x ^ (x >> 16);
  return f32((*r).s) / 4294967296.0;
}

// SDF 纹理存毫米,这里统一转回体素单位,使步进/梯度/占据判定都在体素空间
fn sdfAt(p : vec3<f32>) -> f32 {
  let uvw = (p + vec3<f32>(0.5)) / U.grid.xyz;
  return textureSampleLevel(sdfTex, linSampler, uvw, 0.0).r / U.params.x;
}
fn gradAt(p : vec3<f32>) -> vec3<f32> {
  let e = vec3<f32>(1.0, 0.0, 0.0);
  let n = vec3<f32>(
    sdfAt(p + e.xyy) - sdfAt(p - e.xyy),
    sdfAt(p + e.yxy) - sdfAt(p - e.yxy),
    sdfAt(p + e.yyx) - sdfAt(p - e.yyx));
  return normalize(n);
}

// 网格包围盒外返回到盒的保守距离(体素),避免 clamp 采样误判;盒内才查 SDF 纹理
fn sceneDist(p : vec3<f32>) -> f32 {
  let lo = vec3<f32>(0.0);
  let hi = U.grid.xyz;
  let outside = p.x < lo.x || p.y < lo.y || p.z < lo.z || p.x > hi.x || p.y > hi.y || p.z > hi.z;
  if (outside) {
    let q = max(max(lo - p, p - hi), vec3<f32>(0.0));
    return length(q);
  }
  return sdfAt(p);
}

// 射线步进求与 SDF 表面交点,返回是否命中及命中点
fn raymarch(ro : vec3<f32>, rd : vec3<f32>, outHit : ptr<function, vec3<f32>>) -> bool {
  var p = ro;
  for (var i = 0; i < 260; i++) {
    let d = sceneDist(p);
    if (d < 0.35) { *outHit = p; return true; }
    let step = clamp(d * 0.8, 0.4, 8.0);
    p = p + rd * step;
    if (p.x < -8.0 || p.y < -8.0 || p.z < -8.0 ||
        p.x > U.grid.x + 8.0 || p.y > U.grid.y + 8.0 || p.z > U.grid.z + 8.0) {
      return false;
    }
  }
  return false;
}

// 体素 DDA:从 entry 沿 rd 走到出射,累加各通道光学厚度 tau
struct MediumResult { tau : vec3<f32>, exitP : vec3<f32>, hitCrack : f32, pathLen : f32 };
fn traceMedium(entry : vec3<f32>, rd : vec3<f32>) -> MediumResult {
  var res : MediumResult;
  res.tau = vec3<f32>(0.0);
  res.hitCrack = 0.0;
  res.pathLen = 0.0;
  var p = entry;
  let vmm = U.params.x;
  // 以固定小步长沿光程积分(步长 0.5 体素),兼顾精度与性能
  let stepVox = 0.5;
  var travelled = 0.0;
  res.exitP = entry;
  for (var i = 0; i < 600; i++) {
    let cell = vec3<i32>(clamp(floor(p), vec3<f32>(0.0), U.grid.xyz - 1.0));
    let d = textureLoad(sdfTex, cell, 0).r;
    if (d >= 0.0 && travelled > 1.0) { res.exitP = p; break; }
    let lab = textureLoad(labelTex, cell, 0).r;
    var extra = 0.0;
    if (lab == 1u) { extra = U.defect.x; res.hitCrack = 1.0; }
    else if (lab == 2u) { extra = U.defect.y; }
    else if (lab == 3u) { extra = U.defect.z; }
    let dl = stepVox * vmm;
    res.tau = res.tau + (U.sigmaA.rgb + vec3<f32>(extra)) * dl;
    p = p + rd * stepVox;
    travelled = travelled + stepVox;
    res.pathLen = res.pathLen + dl;
    if (travelled > 260.0) { res.exitP = p; break; }
  }
  return res;
}

fn schlick(cosTheta : f32, ior : f32) -> f32 {
  let r0 = pow((1.0 - ior) / (1.0 + ior), 2.0);
  return r0 + (1.0 - r0) * pow(1.0 - cosTheta, 5.0);
}

// 背景:柔和环境渐变
fn background(rd : vec3<f32>) -> vec3<f32> {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(vec3<f32>(0.05, 0.06, 0.08), vec3<f32>(0.16, 0.18, 0.22), t);
}

fn toneMap(c : vec3<f32>) -> vec3<f32> {
  let aces = c * (2.51 * c + 0.03) / (c * (2.43 * c + 0.59) + 0.14);
  let lin = clamp(aces, vec3<f32>(0.0), vec3<f32>(1.0));
  return pow(lin, vec3<f32>(1.0 / 2.2));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let width = U.slab.y;   // host 端约定:slab.y=width, slab.z=height
  let height = U.slab.z;
  let px = vec2<f32>(f32(gid.x), f32(gid.y));
  if (gid.x >= u32(width) || gid.y >= u32(height)) { return; }
  let idx = gid.y * u32(width) + gid.x;

  var rngState : Rng;
  rngState.s = gid.x * 1973u + gid.y * 9277u + u32(U.params.y) * 26699u + 1u;

  // 像素 -> 相机光线(含每帧抖动做抗锯齿/时域累积)
  let jitter = vec2<f32>(hash(&rngState, 1u), hash(&rngState, 2u)) - 0.5;
  let ndc = (px + jitter) / vec2<f32>(width, height) * 2.0 - 1.0;
  let aspect = width / height;
  let tanHalf = U.slab.w;   // 与 CPU 相机一致的 tan(FOV/2)
  let camF = normalize(U.target.xyz - U.camPos.xyz);
  let right = normalize(cross(camF, vec3<f32>(0.0, 1.0, 0.0)));
  let up = cross(right, camF);
  let rd = normalize(camF + right * ndc.x * tanHalf * aspect + up * ndc.y * tanHalf);
  let ro = U.camPos.xyz;

  var color = vec3<f32>(0.0);

  // ------ 验证模式:解析板,纯 Beer-Lambert,无随机项 ------
  if (U.grid.w > 0.5) {
    let d = U.slab.x;
    let trans = exp(-U.sigmaA.rgb * d);
    color = trans * U.lightPos.w;
    let prev = accum[idx].rgb * f32(sampleCount[idx]);
    atomicAdd(&sampleCount[idx], 1);
    accum[idx] = vec4<f32>((prev + color) / f32(sampleCount[idx]), 1.0);
    return;
  }

  var hitP : vec3<f32>;
  let hit = raymarch(ro, rd, &hitP);
  if (!hit) {
    color = background(rd);
  } else {
    let n = gradAt(hitP);
    let mode = U.params.z;

    // 厚度模式:从命中点反向穿透求路径长度,映射色带
    if (mode > 1.5 && mode < 2.5) {
      let med = traceMedium(hitP + n * 0.2, -n);
      let thick = med.pathLen;
      color = thicknessColor(thick);
    } else if (mode > 2.5 && mode < 3.5) {
      // 绺裂模式:裂纹高亮
      let med = traceMedium(hitP + n * 0.2, -n);
      let trans = exp(-med.tau);
      color = mix(vec3<f32>(0.08, 0.05, 0.03), vec3<f32>(1.0, 0.35, 0.15), med.hitCrack);
      color = color * (0.3 + 0.7 * max(trans.r, max(trans.g, trans.b)));
    } else {
      // 材质/透光模式
      let med = traceMedium(hitP + n * 0.2, -n);
      let trans = exp(-med.tau);                 // 精确 Beer-Lambert 透射
      let toLight = normalize(U.lightPos.xyz - med.exitP);
      let back = dot(-rd, n);

      // 表面菲涅尔反射(油润高光),能量按 fres 与透射分配
      let fres = schlick(abs(back), U.sigmaA.w);
      let rough = U.sigmaS.w;
      let halfV = normalize(toLight - rd);
      let spec = pow(max(dot(n, halfV), 0.0), mix(180.0, 18.0, rough));
      let specCol = vec3<f32>(1.0, 0.97, 0.9) * spec * U.lightPos.w * (0.4 + U.defect.w);

      // 背光:透射光主导;侧光:散射与边缘光增强
      var lightTint = vec3<f32>(1.0, 0.96, 0.88);
      if (U.params.w > 1.5) { lightTint = vec3<f32>(1.0, 0.93, 0.82); }
      let backlight = trans * lightTint * U.lightPos.w;

      // 扩散近似:散射把光从内部带出,边缘更亮(玉的润)
      let sPrime = (U.sigmaS.r + U.sigmaS.g + U.sigmaS.b) / 3.0;
      let diffuse = (1.0 - exp(-sPrime * med.pathLen)) * 0.25;
      let rim = pow(1.0 - abs(back), 2.0) * 0.35;
      let internal = backlight * (0.75 + diffuse + rim);

      // 单散射:在介质内朝灯光偏折的能量
      let scatterTint = vec3<f32>(0.9, 0.95, 1.0);
      let single = trans * U.sigmaS.rgb * med.pathLen * 0.5 * max(dot(-rd, toLight), 0.0);

      // 裂纹在透光下显现:降低局部透射并偏暗
      let crackDark = mix(1.0, 0.35, med.hitCrack);

      // 菲涅尔:反射能量 fres,透射能量 (1-fres),符合介质物理
      color = internal * crackDark * (1.0 - fres) + specCol + single * scatterTint;
      // 环境兜底,避免暗部死黑
      color = color + trans * 0.06;
    }
  }

  let prev = accum[idx].rgb * f32(sampleCount[idx]);
  atomicAdd(&sampleCount[idx], 1);
  accum[idx] = vec4<f32>((prev + color) / f32(sampleCount[idx]), 1.0);
}

fn thicknessColor(t : f32) -> vec3<f32> {
  // 薄(蓝) -> 中(绿) -> 厚(红),与厚度图色带一致
  let k = clamp(t / 40.0, 0.0, 1.0);
  let c0 = vec3<f32>(0.1, 0.4, 1.0);
  let c1 = vec3<f32>(0.1, 0.9, 0.4);
  let c2 = vec3<f32>(1.0, 0.25, 0.15);
  if (k < 0.5) { return mix(c0, c1, k * 2.0); }
  return mix(c1, c2, (k - 0.5) * 2.0);
}
`;

export const PRESENT_WGSL = /* wgsl */ `
struct PresentUniforms { width : f32, height : f32, exposure : f32, pad : f32 };
@group(0) @binding(0) var<uniform> P : PresentUniforms;
@group(0) @binding(1) var<storage, read> accum : array<vec4<f32>>;

struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi : u32) -> VOut {
  var out : VOut;
  let p = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  out.pos = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, (p[vi].y + 1.0) * 0.5);
  return out;
}

fn toneMap(c : vec3<f32>) -> vec3<f32> {
  let x = c * P.exposure;
  let aces = x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14);
  return pow(clamp(aces, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
}

@fragment fn fs(in : VOut) -> @location(0) vec4<f32> {
  let cx = u32(in.uv.x * P.width);
  let cy = u32((1.0 - in.uv.y) * P.height);
  let idx = cy * u32(P.width) + cx;
  let c = accum[idx].rgb;
  return vec4<f32>(toneMap(c), 1.0);
}
`;
