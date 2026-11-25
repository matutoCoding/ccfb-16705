import type { Vec3 } from '../core/types';
import { v3 } from '../core/vec3';

/** 轨道相机:输出视图/投影矩阵(列主序,适配 WGSL) */
export class OrbitCamera {
  target: Vec3 = [48, 48, 48];
  distance = 150;
  yaw = 0.7;
  pitch = 0.5;
  fov = (45 * Math.PI) / 180;
  near = 1;
  far = 1000;
  aspect = 1;

  get position(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.006));
  }
  pan(dx: number, dy: number): void {
    const s = this.distance * 0.0015;
    const right: Vec3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const up: Vec3 = [0, 1, 0];
    this.target = v3.add(this.target, v3.add(v3.scale(right, -dx * s), v3.scale(up, dy * s)));
  }
  zoom(delta: number): void {
    this.distance = Math.max(40, Math.min(400, this.distance * (1 + delta * 0.001)));
  }

  viewMatrix(): Float32Array {
    return lookAt(this.position, this.target, [0, 1, 0]);
  }
  projMatrix(): Float32Array {
    return perspective(this.fov, this.aspect, this.near, this.far);
  }
  viewProj(): Float32Array {
    return mulMat4(this.projMatrix(), this.viewMatrix());
  }
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  // 列主序
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ]);
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  const f = v3.norm(v3.sub(center, eye));
  const s = v3.norm(v3.cross(f, up));
  const u = v3.cross(s, f);
  // 列主序 view
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -v3.dot(s, eye), -v3.dot(u, eye), v3.dot(f, eye), 1,
  ]);
}

export function mulMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  return out;
}
